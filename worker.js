/**
 * NZ Petrol Finder – Cloudflare Worker
 * ──────────────────────────────────────────────────────────────
 * Paste this entire file into the Cloudflare Workers editor and
 * click "Deploy". Free tier (100 000 requests/day) is more than enough.
 *
 * Deploy steps (takes ~2 minutes):
 *   1. Go to https://cloudflare.com and sign up (free)
 *   2. Dashboard → Workers & Pages → Create → Hello World (Worker)
 *   3. Click "Edit code", select all, paste this file, click Deploy
 *   4. Copy your Worker URL (e.g. https://petrol-proxy.you.workers.dev)
 *   5. Paste that URL into the setup screen in the Petrol Finder app
 */

const GASPY  = 'https://gaspy.nz/api/v1';
const VER    = 10;
const CORS   = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── session cache (stored in global scope, lives for worker lifetime) ──
let cached = { cookie: '', xsrf: '', exp: 0 };

async function getSession() {
  if (cached.cookie && Date.now() < cached.exp) return cached;

  const r = await fetch(`${GASPY}/Public/init?gold_key=&v=${VER}`, {
    headers: { 'User-Agent': 'Gaspy/10 Android', Accept: 'application/json' },
  });

  // Cloudflare Workers: iterate all Set-Cookie headers
  const cookieParts = [];
  let xsrf = '';
  for (const [k, v] of r.headers.entries()) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const [nameVal] = v.split(';');
    const eqIdx = nameVal.indexOf('=');
    const name  = nameVal.slice(0, eqIdx).trim();
    const val   = nameVal.slice(eqIdx + 1).trim();
    cookieParts.push(`${name}=${val}`);
    if (name === 'XSRF-TOKEN') xsrf = decodeURIComponent(val);
  }

  cached = { cookie: cookieParts.join('; '), xsrf, exp: Date.now() + 10 * 60 * 1000 };
  return cached;
}

function decodeBlob(raw) {
  if (typeof raw !== 'string') return raw;
  for (const part of [...raw.split(':'), raw.replace(':', '')]) {
    try { return JSON.parse(atob(part)); } catch {}
  }
  return null;
}

function normalise(decoded) {
  const list = decoded?.data || decoded?.stations || decoded || [];
  return (Array.isArray(list) ? list : [])
    .map(s => ({
      id:          s.id ?? s.station_id,
      name:        s.name ?? s.station_name ?? 'Station',
      brand:       s.brand ?? s.operator ?? '',
      address:     s.address ?? '',
      lat:         parseFloat(s.latitude ?? s.lat),
      lng:         parseFloat(s.longitude ?? s.lng),
      price:       parseFloat(s.price ?? s.fuel_price) || null,
      lastUpdated: s.last_updated ?? s.updated_at ?? null,
      distance:    s.distance != null ? parseFloat(s.distance) : null,
    }))
    .filter(s => s.price != null)
    .sort((a, b) => a.price - b.price);
}

async function handleStations(request) {
  const { lat, lng, distance = 5, fuelTypeId = 1 } = await request.json();
  if (!lat || !lng) return new Response(JSON.stringify({ error: 'lat and lng required' }), { status: 400, headers: CORS });

  const sess = await getSession();

  const gaspyResp = await fetch(`${GASPY}/FuelPrice/searchFuelPricesV2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'Gaspy/10 Android',
      Cookie: sess.cookie,
      'X-XSRF-TOKEN': sess.xsrf,
    },
    body: JSON.stringify({
      latitude: lat, longitude: lng, distance,
      order_by: 'price', fuel_type_id: fuelTypeId,
      ev_plug_types: [], device_type: 'A', v: VER,
    }),
  });

  const raw      = await gaspyResp.text();
  const decoded  = decodeBlob(raw) ?? JSON.parse(raw);
  const stations = normalise(decoded);

  return new Response(JSON.stringify({ stations }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ ok: true, worker: 'NZ Petrol Finder' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Station search
    if (request.method === 'POST' && url.pathname === '/stations') {
      try {
        return await handleStations(request);
      } catch (err) {
        cached.exp = 0; // reset session on error
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  },
};
