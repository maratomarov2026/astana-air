'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CITY = { name: 'Астана', lat: 51.1694, lon: 71.4491 };
const TIMEZONE = 'Asia/Almaty';
const SOURCE_NAME = 'Open-Meteo / CAMS';
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const SOURCE_URL =
  'https://air-quality-api.open-meteo.com/v1/air-quality?' +
  new URLSearchParams({
    latitude: String(CITY.lat),
    longitude: String(CITY.lon),
    timezone: TIMEZONE,
    current: 'us_aqi,pm2_5,pm10,nitrogen_dioxide,sulphur_dioxide,ozone,carbon_monoxide',
    hourly: 'us_aqi,pm2_5',
    past_days: '3',
    forecast_days: '2',
  }).toString();

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

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

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Единственное место, зависящее от формата ответа Open-Meteo.
function normalize(raw, fetchedAt = new Date()) {
  const cur = raw && raw.current;
  const hr = raw && raw.hourly;
  if (!cur || typeof cur.time !== 'string' || !hr || !Array.isArray(hr.time)) {
    throw new Error('Неожиданный формат ответа источника');
  }
  const aqi = hr.us_aqi || [];
  const pm25 = hr.pm2_5 || [];
  return {
    city: CITY.name,
    lat: CITY.lat,
    lon: CITY.lon,
    source: SOURCE_NAME,
    timezone: TIMEZONE,
    fetchedAt: fetchedAt.toISOString(),
    stale: false,
    current: {
      time: cur.time,
      aqi: num(cur.us_aqi),
      pm25: num(cur.pm2_5),
      pm10: num(cur.pm10),
      no2: num(cur.nitrogen_dioxide),
      so2: num(cur.sulphur_dioxide),
      o3: num(cur.ozone),
      co: num(cur.carbon_monoxide),
    },
    hourly: hr.time.map((time, i) => ({ time, aqi: num(aqi[i]), pm25: num(pm25[i]) })),
  };
}

async function fetchSource() {
  const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Источник вернул ${res.status}`);
  return res.json();
}

function createApp({ fetchImpl = fetchSource, ttl = CACHE_TTL_MS, now = () => Date.now() } = {}) {
  let cache = null; // { data, at }
  let inflight = null;

  function getAir() {
    if (cache && now() - cache.at < ttl) return Promise.resolve({ ...cache.data, stale: false });
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = normalize(await fetchImpl(), new Date(now()));
        cache = { data, at: now() };
        return data;
      } catch (err) {
        if (cache) return { ...cache.data, stale: true };
        throw err;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function send(res, status, body, headers = {}, head = false) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(head ? undefined : body);
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request', { 'Content-Type': MIME['.txt'] });
    }
    if (rel.includes('\0')) return send(res, 400, 'Bad request', { 'Content-Type': MIME['.txt'] });
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + path.sep + rel.replace(/^[/\\]+/, ''));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      return send(res, 404, 'Not found', { 'Content-Type': MIME['.txt'] });
    }
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': MIME['.txt'] }, req.method === 'HEAD');
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, buf, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' }, req.method === 'HEAD');
    });
  }

  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD', 'Content-Type': MIME['.txt'] });
    }
    const head = req.method === 'HEAD';
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': MIME['.txt'] }, head);

    if (pathname === '/api/air') {
      try {
        const data = await getAir();
        return send(res, 200, JSON.stringify(data), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' }, head);
      } catch (err) {
        console.error('[air] источник недоступен:', err.message);
        return send(res, 502, JSON.stringify({ error: 'Источник данных недоступен' }), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }, head);
      }
    }

    serveStatic(req, res, pathname);
  });
}

module.exports = { createApp, normalize, SOURCE_URL };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, '0.0.0.0', () => console.log(`Воздух Астаны: http://localhost:${port}`));
}
