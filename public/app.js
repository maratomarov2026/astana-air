'use strict';

(function () {
  var REFRESH_MS = 10 * 60 * 1000;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var CATEGORIES = [
    { max: 50, name: 'Хорошее', range: '0–50', advice: 'Воздух чистый. Гуляйте, занимайтесь спортом, проветривайте квартиру.' },
    { max: 100, name: 'Умеренное', range: '51–100', advice: 'Воздух приемлемый. Очень чувствительным людям лучше сократить долгие нагрузки на улице.' },
    { max: 150, name: 'Вредно для чувствительных', range: '101–150', advice: 'Детям, пожилым и людям с астмой или болезнями сердца лучше проводить на улице меньше времени.' },
    { max: 200, name: 'Вредное', range: '151–200', advice: 'Сократите время на улице, закройте окна. При необходимости выходите в респираторе FFP2 или N95.' },
    { max: 300, name: 'Очень вредное', range: '201–300', advice: 'Оставайтесь в помещении, включите очиститель воздуха. На улицу выходите только по необходимости.' },
    { max: Infinity, name: 'Опасное', range: '301+', advice: 'Не выходите без необходимости, закройте окна, используйте очиститель воздуха и респиратор.' }
  ];

  var $ = function (id) { return document.getElementById(id); };

  function categoryIndex(aqi) {
    for (var i = 0; i < CATEGORIES.length; i++) if (aqi <= CATEGORIES[i].max) return i;
    return CATEGORIES.length - 1;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // 'YYYY-MM-DDTHH:MM' -> {y, m, d, h, min}
  function parseTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5] };
  }

  function dateKey(t) { return t.y + '-' + pad(t.m) + '-' + pad(t.d); }

  function dayDiff(a, b) {
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }

  var MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  var fmtDay = function (t) { return t.d + ' ' + MONTHS[t.m - 1]; };
  var fmtHour = function (t) { return pad(t.h) + ':00'; };

  function fmtNum(v) {
    if (v === null || v === undefined) return '—';
    return String(Math.round(v * 10) / 10).replace('.', ',');
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // ---------- Текущее состояние ----------

  function renderCurrent(data) {
    var cur = data.current;
    var hero = $('hero');
    if (cur.aqi === null) {
      $('aqi').textContent = '—';
      $('cat').textContent = 'Нет данных';
      $('advice').textContent = 'Источник не прислал индекс для этого часа.';
      hero.style.removeProperty('--cat');
    } else {
      var i = categoryIndex(cur.aqi);
      var cat = CATEGORIES[i];
      $('aqi').textContent = String(Math.round(cur.aqi));
      $('cat').textContent = cat.name;
      $('advice').textContent = cat.advice;
      hero.style.setProperty('--cat', 'var(--c' + i + ')');
      renderHaze(cur.aqi);
    }

    var t = parseTime(cur.time);
    $('time').textContent = t
      ? 'Данные на ' + fmtDay(t) + ', ' + pad(t.h) + ':' + pad(t.min) + ' (время Астаны, UTC+5)'
      : '';

    var items = document.querySelectorAll('#pollutants dd');
    for (var j = 0; j < items.length; j++) {
      items[j].textContent = fmtNum(cur[items[j].getAttribute('data-key')]);
    }
  }

  // Чем выше индекс, тем гуще дымка и мутнее небо.
  function renderHaze(aqi) {
    var k = Math.max(0, Math.min(1, aqi / 300));
    $('haze').style.opacity = String(0.55 * k);
    $('skyTint').style.opacity = String(0.7 * k);
    $('blurNode').setAttribute('stdDeviation', String(+(3.5 * k).toFixed(2)));
  }

  // ---------- Лучшее время ----------

  function renderBest(data) {
    var now = parseTime(data.current.time);
    var out = $('best');
    if (!now) { out.textContent = 'Нет данных.'; return; }

    var nowKey = dateKey(now) + 'T' + pad(now.h) + ':00';
    var best = null;
    var count = 0;
    data.hourly.forEach(function (p) {
      var t = parseTime(p.time);
      if (!t || p.aqi === null || p.time < nowKey || count >= 25) return;
      count++; // окно: текущий час и 24 следующих
      if (t.h < 7 || t.h > 21) return;
      if (!best || p.aqi < best.aqi) best = { aqi: p.aqi, t: t };
    });

    if (!best) { out.textContent = 'В ближайшие сутки нет подходящих дневных часов с данными.'; return; }
    var diff = dayDiff(now, best.t);
    var when = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : fmtDay(best.t);
    var cat = CATEGORIES[categoryIndex(best.aqi)];
    out.textContent = 'Лучше всего выйти ' + when + ' в ' + fmtHour(best.t) + ': индекс ' +
      Math.round(best.aqi) + ' (' + cat.name.toLowerCase() + '). Смотрим только дневные часы с 07:00 до 21:00.';
  }

  // ---------- График ----------

  var chartState = null;

  function renderChart(data) {
    var svg = $('chart');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var pts = data.hourly;
    var n = pts.length;
    if (!n) return;

    var W = 960, H = 220, L = 34, R = 10, T = 10, B = 28;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var maxAqi = 150;
    pts.forEach(function (p) { if (p.aqi !== null && p.aqi > maxAqi) maxAqi = p.aqi; });
    maxAqi = Math.ceil(maxAqi / 50) * 50;

    var x = function (i) { return L + (n === 1 ? 0 : i * (W - L - R) / (n - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / maxAqi); };

    // Фон по категориям
    var lo = 0;
    CATEGORIES.forEach(function (c, i) {
      if (lo >= maxAqi) return;
      var hi = Math.min(c.max === Infinity ? maxAqi : c.max, maxAqi);
      var r = svgEl('rect', { x: L, width: W - L - R, y: y(hi), height: y(lo) - y(hi) });
      r.style.fill = 'var(--b' + i + ')';
      svg.appendChild(r);
      lo = hi;
    });

    // Горизонтальные подписи
    for (var v = 0; v <= maxAqi; v += 50) {
      var tx = svgEl('text', { x: L - 4, y: y(v) + 4, 'text-anchor': 'end' });
      tx.textContent = String(v);
      svg.appendChild(tx);
    }

    // Подписи по оси времени
    pts.forEach(function (p, i) {
      var t = parseTime(p.time);
      if (!t || t.h % 12 !== 0) return;
      var line = svgEl('line', { x1: x(i), x2: x(i), y1: T, y2: H - B });
      line.style.stroke = 'var(--line)';
      svg.appendChild(line);
      var lab = svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' });
      lab.textContent = t.h === 0 ? fmtDay(t) : '12:00';
      svg.appendChild(lab);
    });

    var nowIdx = -1;
    var nowT = parseTime(data.current.time);
    if (nowT) {
      var key = dateKey(nowT) + 'T' + pad(nowT.h) + ':00';
      nowIdx = pts.findIndex(function (p) { return p.time === key; });
    }

    // Линии: прошлое сплошной, прогноз пунктиром, пропуски разрывают линию
    function segPath(from, to) {
      var d = '', pen = false;
      for (var i = from; i <= to && i < n; i++) {
        if (pts[i].aqi === null) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(pts[i].aqi).toFixed(1);
        pen = true;
      }
      return d;
    }
    var split = nowIdx < 0 ? n - 1 : nowIdx;
    var past = svgEl('path', { d: segPath(0, split), fill: 'none', 'stroke-width': 2.5, 'stroke-linejoin': 'round' });
    past.style.stroke = 'var(--text)';
    svg.appendChild(past);
    if (nowIdx >= 0 && nowIdx < n - 1) {
      var fc = svgEl('path', { d: segPath(nowIdx, n - 1), fill: 'none', 'stroke-width': 2.5, 'stroke-dasharray': '6 5', 'stroke-linejoin': 'round' });
      fc.style.stroke = 'var(--text)';
      svg.appendChild(fc);
    }

    // Отметка «сейчас»
    if (nowIdx >= 0 && pts[nowIdx].aqi !== null) {
      var dot = svgEl('circle', { cx: x(nowIdx), cy: y(pts[nowIdx].aqi), r: 5 });
      dot.style.fill = 'var(--accent)';
      dot.style.stroke = 'var(--card)';
      dot.setAttribute('stroke-width', '2');
      svg.appendChild(dot);
    }

    // Курсор
    var cursor = svgEl('line', { y1: T, y2: H - B, visibility: 'hidden' });
    cursor.style.stroke = 'var(--accent)';
    svg.appendChild(cursor);

    chartState = { data: data, x: x, nowIdx: nowIdx, cursor: cursor, W: W, L: L, R: R, sel: nowIdx >= 0 ? nowIdx : n - 1 };
  }

  function showPoint(i) {
    var s = chartState;
    if (!s) return;
    var pts = s.data.hourly;
    i = Math.max(0, Math.min(pts.length - 1, i));
    s.sel = i;
    var p = pts[i];
    var t = parseTime(p.time);
    s.cursor.setAttribute('x1', s.x(i));
    s.cursor.setAttribute('x2', s.x(i));
    s.cursor.setAttribute('visibility', 'visible');

    var tag = i === s.nowIdx ? ', сейчас' : (s.nowIdx >= 0 && i > s.nowIdx ? ', прогноз' : '');
    var head = fmtDay(t) + ', ' + fmtHour(t) + tag + ': ';
    if (p.aqi === null) {
      $('tip').textContent = head + 'нет данных.';
      return;
    }
    $('tip').textContent = head + 'индекс ' + Math.round(p.aqi) + ' (' + CATEGORIES[categoryIndex(p.aqi)].name +
      '), PM2.5 ' + fmtNum(p.pm25) + ' мкг/м³';
  }

  function bindChartEvents() {
    var svg = $('chart');
    function fromEvent(e) {
      var s = chartState;
      if (!s) return;
      var rect = svg.getBoundingClientRect();
      var px = (e.clientX - rect.left) * (s.W / rect.width);
      var n = s.data.hourly.length;
      showPoint(Math.round((px - s.L) / ((s.W - s.L - s.R) / (n - 1))));
    }
    svg.addEventListener('pointermove', fromEvent);
    svg.addEventListener('pointerdown', fromEvent);
    svg.addEventListener('keydown', function (e) {
      var s = chartState;
      if (!s) return;
      var step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -24, PageDown: 24 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      showPoint(s.sel + step);
    });
  }

  // ---------- Шкала ----------

  function renderScale(aqi) {
    var ul = $('scale');
    var cur = aqi === null || aqi === undefined ? -1 : categoryIndex(aqi);
    ul.textContent = '';
    CATEGORIES.forEach(function (c, i) {
      var li = document.createElement('li');
      li.style.setProperty('--cat', 'var(--c' + i + ')');
      if (i === cur) li.className = 'current';
      var strong = document.createElement('strong');
      strong.textContent = c.name;
      var range = document.createElement('span');
      range.className = 'range';
      range.textContent = ' · ' + c.range;
      li.appendChild(strong);
      li.appendChild(range);
      if (i === cur) {
        var here = document.createElement('span');
        here.className = 'here';
        here.textContent = 'Сейчас';
        li.appendChild(here);
      }
      var p = document.createElement('div');
      p.textContent = c.advice;
      li.appendChild(p);
      ul.appendChild(li);
    });
  }

  // ---------- Загрузка ----------

  var lastData = null;

  function setStatus(text, warn) {
    var el = $('status');
    el.textContent = text;
    el.className = 'status' + (warn ? ' warn' : '');
  }

  function showError(show) {
    $('error').hidden = !show;
  }

  function render(data) {
    lastData = data;
    showError(false);
    renderCurrent(data);
    renderBest(data);
    renderChart(data);
    showPoint(chartState ? chartState.sel : 0);
    renderScale(data.current.aqi);
    $('src-meta').textContent = 'Источник: ' + data.source + '. Обновлено на сервере: ' +
      new Date(data.fetchedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) + '.';
    if (data.stale) {
      setStatus('Источник недоступен, показаны сохранённые данные', true);
    } else {
      setStatus('Данные актуальны', false);
    }
  }

  function load() {
    return fetch('/api/air', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(render)
      .catch(function () {
        if (lastData) {
          setStatus('Не удалось обновить, показаны предыдущие данные', true);
        } else {
          setStatus('Нет данных', true);
          showError(true);
        }
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderScale(null);
    bindChartEvents();
    $('retry').addEventListener('click', function () {
      setStatus('Загружаем данные…', false);
      load();
    });
    load();
    setInterval(load, REFRESH_MS);
  });
})();
