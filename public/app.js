(() => {
  'use strict';

  const CATS = [
    { max: 50, range: '0–50', name: 'Хорошее', advice: 'Воздух чистый. Гуляйте, занимайтесь спортом, проветривайте квартиру.' },
    { max: 100, range: '51–100', name: 'Умеренное', advice: 'Воздух приемлемый. Очень чувствительным людям лучше сократить долгие нагрузки на улице.' },
    { max: 150, range: '101–150', name: 'Вредно для чувствительных', advice: 'Детям, пожилым и людям с астмой или болезнями сердца лучше проводить на улице меньше времени.' },
    { max: 200, range: '151–200', name: 'Вредное', advice: 'Сократите время на улице и закройте окна. При необходимости наденьте респиратор FFP2 или N95.' },
    { max: 300, range: '201–300', name: 'Очень вредное', advice: 'Оставайтесь в помещении, включите очиститель воздуха. Выходите только по необходимости.' },
    { max: Infinity, range: '301+', name: 'Опасное', advice: 'Не выходите без необходимости, закройте окна, включите очиститель воздуха и носите респиратор.' },
  ];

  const METRICS = [
    ['pm25', 'PM2.5'], ['pm10', 'PM10'], ['no2', 'NO₂'], ['so2', 'SO₂'], ['o3', 'O₃'], ['co', 'CO'],
  ];

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const REFRESH_MS = 10 * 60 * 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const catIndex = (aqi) => CATS.findIndex((c) => aqi <= c.max);

  // Время приходит по Астане без смещения: "YYYY-MM-DDTHH:MM". Работаем со строками.
  const dateOf = (t) => t.slice(0, 10);
  const hourOf = (t) => Number(t.slice(11, 13));
  const fmtDay = (t) => `${Number(t.slice(8, 10))} ${MONTHS[Number(t.slice(5, 7)) - 1]}`;
  const fmtDayShort = (t) => `${Number(t.slice(8, 10))} ${MONTHS_SHORT[Number(t.slice(5, 7)) - 1]}`;
  const fmtHour = (t) => `${t.slice(11, 16)}`;
  const nextDate = (d) => {
    const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + 1));
    return dt.toISOString().slice(0, 10);
  };
  const fmtNum = (v) => (v == null ? '–' : String(Math.round(v * 10) / 10).replace('.', ','));

  function el(name, attrs, text) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function relDay(date, today) {
    if (date === today) return 'сегодня';
    if (date === nextDate(today)) return 'завтра';
    return fmtDay(date);
  }

  // Индекс часа «сейчас» в массиве hourly: последний час, не позже текущего времени.
  function findNowIndex(hourly, curTime) {
    const key = curTime.slice(0, 13);
    let idx = -1;
    for (let i = 0; i < hourly.length; i++) {
      if (hourly[i].time.slice(0, 13) <= key) idx = i;
      else break;
    }
    return idx;
  }

  function renderScale(active) {
    const ol = $('scale');
    ol.textContent = '';
    CATS.forEach((c, i) => {
      const li = document.createElement('li');
      li.dataset.cat = String(i);
      if (i === active) li.setAttribute('aria-current', 'true');
      const b = document.createElement('b');
      b.textContent = `${c.range} · ${c.name}`;
      const s = document.createElement('span');
      s.textContent = c.advice;
      li.append(b, s);
      ol.append(li);
    });
  }

  function renderMetrics(cur) {
    const dl = $('metrics');
    dl.textContent = '';
    for (const [key, label] of METRICS) {
      const d = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = fmtNum(cur[key]);
      d.append(dt, dd);
      dl.append(d);
    }
  }

  function renderHero(cur) {
    const hero = $('hero');
    if (cur.aqi == null) {
      $('aqi').textContent = '–';
      $('cat').textContent = 'Нет данных';
      $('advice').textContent = 'Источник не передал текущий индекс. Посмотрите график ниже.';
      hero.dataset.cat = '0';
      $('haze').style.opacity = '0';
      $('blurNode').setAttribute('stdDeviation', '0');
      renderScale(-1);
      return -1;
    }
    const i = catIndex(cur.aqi);
    const c = CATS[i];
    hero.dataset.cat = String(i);
    $('aqi').textContent = String(Math.round(cur.aqi));
    $('cat').textContent = c.name;
    $('advice').textContent = c.advice;
    // дымка и размытие силуэта растут с индексом
    const k = Math.min(cur.aqi / 300, 1);
    $('haze').style.opacity = String(Math.round(k * 0.75 * 100) / 100);
    $('blurNode').setAttribute('stdDeviation', String(Math.round(k * 4 * 10) / 10));
    renderScale(i);
    return i;
  }

  function renderBest(hourly, nowIdx, curTime) {
    const out = $('best');
    let best = null;
    if (nowIdx >= 0) {
      for (let i = nowIdx; i < hourly.length && i <= nowIdx + 24; i++) {
        const p = hourly[i];
        const h = hourOf(p.time);
        if (p.aqi == null || h < 7 || h > 21) continue;
        if (!best || p.aqi < best.aqi) best = p;
      }
    }
    if (!best) {
      out.textContent = 'В ближайшие 24 часа нет данных для расчёта.';
      return;
    }
    const day = relDay(dateOf(best.time), dateOf(curTime));
    out.textContent = `${day[0].toUpperCase()}${day.slice(1)} в ${fmtHour(best.time)}: индекс ${Math.round(best.aqi)}, ${CATS[catIndex(best.aqi)].name.toLowerCase()}.`;
  }

  function renderChart(hourly, nowIdx) {
    const box = $('chart');
    box.textContent = '';
    const n = hourly.length;
    if (n < 2) {
      box.textContent = 'Нет данных для графика.';
      return;
    }
    const W = 960, H = 260, L = 34, R = 8, T = 10, B = 28;
    const vals = hourly.map((p) => p.aqi).filter((v) => v != null);
    const yMax = Math.max(150, Math.ceil(Math.max(0, ...vals) / 50) * 50);
    const x = (i) => L + (i * (W - L - R)) / (n - 1);
    const y = (v) => T + (1 - Math.min(v, yMax) / yMax) * (H - T - B);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: '0', 'aria-label': 'График индекса качества воздуха по часам. Стрелки влево и вправо переключают час.' });

    // фон по категориям
    let lo = 0;
    CATS.forEach((c, i) => {
      if (lo >= yMax) return;
      const hi = Math.min(c.max === Infinity ? yMax : c.max, yMax);
      const g = el('rect', { class: 'band', x: L, y: y(hi), width: W - L - R, height: y(lo) - y(hi) });
      g.dataset.cat = String(i);
      svg.append(g);
      lo = hi;
    });

    // ось Y
    for (const v of [0, 50, 100, 150, 200, 300].filter((v) => v <= yMax)) {
      svg.append(el('line', { class: 'axis', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.append(el('text', { x: L - 4, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }

    // ось X
    hourly.forEach((p, i) => {
      const h = hourOf(p.time);
      if (h % 12 !== 0) return;
      svg.append(el('text', { x: x(i), y: H - 8, 'text-anchor': i < 6 ? 'start' : 'middle' }, h === 0 ? fmtDayShort(p.time) : '12:00'));
    });

    // линия: прерывается на пропусках
    const path = (from, to) => {
      let d = '';
      let pen = false;
      for (let i = from; i <= to; i++) {
        const v = hourly[i].aqi;
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
        pen = true;
      }
      return d.trim();
    };
    const split = nowIdx >= 0 ? nowIdx : -1;
    const pastD = split >= 0 ? path(0, split) : '';
    const futD = path(Math.max(split, 0), n - 1);
    if (pastD) svg.append(el('path', { class: 'line past', d: pastD }));
    if (futD) svg.append(el('path', { class: 'line fut', d: futD }));

    // отметка «сейчас»
    if (nowIdx >= 0) {
      svg.append(el('line', { class: 'nowline', x1: x(nowIdx), x2: x(nowIdx), y1: T, y2: H - B }));
      svg.append(el('text', { x: x(nowIdx) + 4, y: T + 10 }, 'сейчас'));
      if (hourly[nowIdx].aqi != null) svg.append(el('circle', { class: 'nowdot', cx: x(nowIdx), cy: y(hourly[nowIdx].aqi), r: 4.5 }));
    }

    const hoverLine = el('line', { class: 'hoverline', y1: T, y2: H - B, visibility: 'hidden' });
    const hoverDot = el('circle', { class: 'hoverdot', r: 4, visibility: 'hidden' });
    svg.append(hoverLine, hoverDot);

    const tip = $('tip');
    let sel = nowIdx >= 0 ? nowIdx : 0;

    function show(i) {
      sel = Math.max(0, Math.min(n - 1, i));
      const p = hourly[sel];
      hoverLine.setAttribute('x1', x(sel));
      hoverLine.setAttribute('x2', x(sel));
      hoverLine.setAttribute('visibility', 'visible');
      if (p.aqi != null) {
        hoverDot.setAttribute('cx', x(sel));
        hoverDot.setAttribute('cy', y(p.aqi));
        hoverDot.setAttribute('visibility', 'visible');
      } else {
        hoverDot.setAttribute('visibility', 'hidden');
      }
      const when = sel === nowIdx ? 'сейчас' : sel > nowIdx ? 'прогноз' : 'было';
      const head = `${fmtDay(p.time)}, ${fmtHour(p.time)} (${when})`;
      tip.textContent = p.aqi == null
        ? `${head}: нет данных.`
        : `${head}: индекс ${Math.round(p.aqi)}, ${CATS[catIndex(p.aqi)].name.toLowerCase()}, PM2.5 ${fmtNum(p.pm25)} мкг/м³.`;
    }

    const fromEvent = (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      return Math.round(((vx - L) / (W - L - R)) * (n - 1));
    };
    svg.addEventListener('pointermove', (e) => show(fromEvent(e)));
    svg.addEventListener('pointerdown', (e) => show(fromEvent(e)));
    svg.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'PageUp' ? -24 : e.key === 'PageDown' ? 24 : 0;
      if (!step) return;
      e.preventDefault();
      show(sel + step);
    });

    box.append(svg);
  }

  function render(data) {
    // значение «сейчас» на графике совпадает с крупным числом
    const hourly = data.hourly.map((p) => ({ ...p }));
    const nowIdx = findNowIndex(hourly, data.current.time);
    if (nowIdx >= 0) {
      if (data.current.aqi != null) hourly[nowIdx].aqi = data.current.aqi;
      if (data.current.pm25 != null) hourly[nowIdx].pm25 = data.current.pm25;
    }

    renderHero(data.current);
    renderMetrics(data.current);
    renderChart(hourly, nowIdx);
    renderBest(hourly, nowIdx, data.current.time);

    $('stale').hidden = !data.stale;
    $('updated').textContent = `Данные на ${fmtHour(data.current.time)}, ${fmtDay(data.current.time)} (время Астаны). Источник: ${data.source}.`;
    $('error').hidden = true;
    $('content').hidden = false;
    $('tip').textContent = 'Проведите пальцем или мышью по графику, чтобы увидеть значение.';
  }

  let loading = false;
  let hasData = false;

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch('/api/air', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      render(await res.json());
      hasData = true;
    } catch (err) {
      if (hasData) {
        $('stale').hidden = false;
      } else {
        $('content').hidden = true;
        $('error').hidden = false;
        $('updated').textContent = 'Данных нет.';
      }
    } finally {
      loading = false;
    }
  }

  $('retry').addEventListener('click', () => {
    $('updated').textContent = 'Загружаем данные…';
    load();
  });

  load();
  setInterval(load, REFRESH_MS);
})();
