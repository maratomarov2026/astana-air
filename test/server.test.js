'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, normalize } = require('../server');

const RAW = {
  current: {
    time: '2026-10-02T15:15',
    us_aqi: 42,
    pm2_5: 9.3,
    pm10: 18,
    nitrogen_dioxide: 10,
    sulphur_dioxide: 3,
    ozone: 70,
    carbon_monoxide: 200,
  },
  hourly: {
    time: ['2026-10-02T14:00', '2026-10-02T15:00', '2026-10-02T16:00'],
    us_aqi: [40, 55, null],
    pm2_5: [8, 11, 12],
  },
};

const okFetch = (counter) => async () => {
  if (counter) counter.n++;
  return { ok: true, status: 200, json: async () => RAW };
};
const failFetch = async () => {
  throw new Error('network down');
};

async function withServer(opts, fn) {
  const { server } = createApp(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function rawGet(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

test('normalize: контракт, null сохраняются, «сейчас» совпадает с графиком', () => {
  const out = normalize(RAW, new Date('2026-10-02T10:00:00Z'));
  assert.equal(out.stale, false);
  assert.equal(out.current.aqi, 42);
  assert.equal(out.current.no2, 10);
  assert.equal(out.hourly.length, 3);
  assert.equal(out.hourly[1].aqi, 42); // перекрыто текущим значением
  assert.equal(out.hourly[2].aqi, null);
  assert.throws(() => normalize({}), /формат/);
});

test('/api/air: кэш — два запроса вызывают источник один раз, параллельные тоже', async () => {
  const counter = { n: 0 };
  await withServer({ fetch: okFetch(counter) }, async (port) => {
    const [a, b] = await Promise.all([rawGet(port, '/api/air'), rawGet(port, '/api/air')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    await rawGet(port, '/api/air');
    assert.equal(counter.n, 1);
    assert.equal(JSON.parse(a.body).stale, false);
  });
});

test('/api/air: при сбое отдаёт кэш с stale, без кэша — 502', async () => {
  let t = 0;
  let fail = false;
  const fetchImpl = async () => (fail ? failFetch() : okFetch()());
  await withServer({ fetch: fetchImpl, now: () => t, ttl: 1000 }, async (port) => {
    assert.equal(JSON.parse((await rawGet(port, '/api/air')).body).stale, false);
    fail = true;
    t = 5000;
    const r = await rawGet(port, '/api/air');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).stale, true);
  });
  await withServer({ fetch: failFetch }, async (port) => {
    const r = await rawGet(port, '/api/air');
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(r.body), { error: 'Источник данных недоступен' });
  });
});

test('статика, healthz, заголовки, методы и защита путей', async () => {
  await withServer({ fetch: okFetch() }, async (port) => {
    const idx = await rawGet(port, '/');
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'], /text\/html/);
    assert.match(idx.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(idx.headers['x-content-type-options'], 'nosniff');
    assert.equal(idx.headers['referrer-policy'], 'no-referrer');

    const health = await rawGet(port, '/healthz');
    assert.equal(health.body, 'ok');

    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%00']) {
      const r = await rawGet(port, p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.body.includes('createApp'), p);
    }

    const post = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(post, 405);
  });
});
