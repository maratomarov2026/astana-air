'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, normalize } = require('../server.js');

const RAW = {
  current: { time: '2026-10-02T15:00', us_aqi: 42, pm2_5: 9.3, pm10: 18, nitrogen_dioxide: 10, sulphur_dioxide: 3, ozone: 70, carbon_monoxide: 200 },
  hourly: { time: ['2026-09-29T00:00', '2026-09-29T01:00', '2026-09-29T02:00'], us_aqi: [31, null, 35], pm2_5: [6.2, null, 7] },
};

function start(app) {
  return new Promise((resolve) => app.listen(0, '127.0.0.1', () => resolve(app.address().port)));
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('normalize приводит ответ источника к контракту и сохраняет пропуски', () => {
  const d = normalize(RAW, new Date('2026-10-02T10:00:00Z'));
  assert.equal(d.city, 'Астана');
  assert.equal(d.stale, false);
  assert.equal(d.fetchedAt, '2026-10-02T10:00:00.000Z');
  assert.deepEqual(d.current, { time: '2026-10-02T15:00', aqi: 42, pm25: 9.3, pm10: 18, no2: 10, so2: 3, o3: 70, co: 200 });
  assert.equal(d.hourly.length, 3);
  assert.equal(d.hourly[1].aqi, null);
  assert.throws(() => normalize({}), /формат/);
});

test('кэш: два запроса подряд и параллельные вызывают источник один раз', async () => {
  let calls = 0;
  const app = createApp({ fetchImpl: async () => (calls++, RAW) });
  const port = await start(app);
  try {
    await Promise.all([get(port, '/api/air'), get(port, '/api/air')]);
    const r = await get(port, '/api/air');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).stale, false);
    assert.equal(calls, 1);
  } finally {
    app.close();
  }
});

test('stale: при сбое источника отдаётся последний кэш, без кэша — 502', async () => {
  let t = 0;
  let fail = false;
  const app = createApp({ fetchImpl: async () => { if (fail) throw new Error('down'); return RAW; }, ttl: 1000, now: () => t });
  const port = await start(app);
  try {
    fail = true;
    const bad = await get(port, '/api/air');
    assert.equal(bad.status, 502);
    assert.deepEqual(JSON.parse(bad.body), { error: 'Источник данных недоступен' });

    fail = false;
    assert.equal((await get(port, '/api/air')).status, 200);
    t = 5000;
    fail = true;
    const stale = JSON.parse((await get(port, '/api/air')).body);
    assert.equal(stale.stale, true);
    assert.equal(stale.current.aqi, 42);
  } finally {
    app.close();
  }
});

test('статика, healthz, методы и защита от выхода за public/', async () => {
  const app = createApp({ fetchImpl: async () => RAW });
  const port = await start(app);
  try {
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['referrer-policy'], 'no-referrer');

    assert.equal((await get(port, '/healthz')).body, 'ok');
    assert.equal((await get(port, '/app.js')).status, 200);
    assert.equal((await get(port, '/', 'POST')).status, 405);

    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fpackage.json']) {
      const r = await get(port, p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.body.includes('createApp'), p);
    }
  } finally {
    app.close();
  }
});
