'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LAT = 51.1694;
const LON = 71.4491;
const TIMEZONE = 'Asia/Almaty';
const SOURCE_NAME = 'Open-Meteo / CAMS';
const CACHE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const SOURCE_URL =
  'https://air-quality-api.open-meteo.com/v1/air-quality' +
  `?latitude=${LAT}&longitude=${LON}&timezone=${encodeURIComponent(TIMEZONE)}` +
  '&current=us_aqi,pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,ozone,carbon_monoxide' +
  '&hourly=us_aqi,pm2_5&past_days=3&forecast_days=2';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Превращает ответ Open-Meteo в контракт /api/air.
 * Единственное место, которое знает формат источника.
 */
function normalize(raw, fetchedAt = new Date()) {
  const cur = raw && raw.current;
  const hr = raw && raw.hourly;
  if (!cur || !hr || !Array.isArray(hr.time)) {
    throw new Error('Неожиданный формат ответа источника');
  }

  const hourly = hr.time.map((time, i) => ({
    time,
    aqi: num(hr.us_aqi && hr.us_aqi[i]),
    pm25: num(hr.pm2_5 && hr.pm2_5[i]),
  }));

  const current = {
    time: cur.time,
    aqi: num(cur.us_aqi),
    pm25: num(cur.pm2_5),
    pm10: num(cur.pm10),
    no2: num(cur.nitrogen_dioxide),
    so2: num(cur.sulphur_dioxide),
    o3: num(cur.ozone),
    co: num(cur.carbon_monoxide),
  };

  // Точка «сейчас» на графике совпадает с крупным числом.
  const hourKey = String(cur.time).slice(0, 13) + ':00';
  const point = hourly.find((p) => p.time === hourKey);
  if (point) {
    if (current.aqi !== null) point.aqi = current.aqi;
    if (current.pm25 !== null) point.pm25 = current.pm25;
  }

  return {
    city: 'Астана',
    lat: LAT,
    lon: LON,
    source: SOURCE_NAME,
    timezone: TIMEZONE,
    fetchedAt: fetchedAt.toISOString(),
    stale: false,
    current,
    hourly,
  };
}

function createApp(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const ttl = options.ttl ?? CACHE_TTL_MS;
  const now = options.now || Date.now;
  const publicDir = options.publicDir || PUBLIC_DIR;

  let cache = null; // { data, at }
  let inflight = null;

  async function loadFromSource() {
    const res = await fetchImpl(SOURCE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Источник ответил ${res.status}`);
    const data = normalize(await res.json(), new Date(now()));
    cache = { data, at: now() };
    return data;
  }

  async function getAir() {
    if (cache && now() - cache.at < ttl) return cache.data;
    if (!inflight) {
      inflight = loadFromSource().finally(() => {
        inflight = null;
      });
    }
    try {
      return await inflight;
    } catch (err) {
      if (cache) return { ...cache.data, stale: true };
      throw err;
    }
  }

  function send(res, status, headers, body, head) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(head ? undefined : body);
  }

  function sendJson(res, status, obj, head) {
    send(
      res,
      status,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(obj),
      head,
    );
  }

  function serveStatic(pathname, res, head) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request', head);
    }
    if (rel.includes('\0')) {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request', head);
    }
    if (rel.endsWith('/')) rel += 'index.html';

    const root = path.resolve(publicDir);
    const file = path.resolve(root, '.' + path.sep + rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found', head);
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found', head);
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }, buf, head);
    });
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(
        res,
        405,
        { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
        'Method not allowed',
      );
    }
    const head = req.method === 'HEAD';
    const pathname = (req.url || '/').split('?')[0].split('#')[0];

    if (pathname === '/healthz') {
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok', head);
    }
    if (pathname === '/api/air') {
      try {
        return sendJson(res, 200, await getAir(), head);
      } catch (err) {
        console.error('[air] источник недоступен:', err.message);
        return sendJson(res, 502, { error: 'Источник данных недоступен' }, head);
      }
    }
    serveStatic(pathname, res, head);
  });

  return { server, getAir };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.listen(port, () => console.log(`Воздух Астаны: http://localhost:${port}`));
}

module.exports = { createApp, normalize, SOURCE_URL };
