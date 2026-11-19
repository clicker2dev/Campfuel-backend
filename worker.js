// CampFuel Shared Backend
// Deploy to Cloudflare Workers with a KV namespace bound as CAMPFUEL_KV
// Set secret: wrangler secret put SERVO_CONSUMER_ID

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FUEL_BASE = 'https://api.fuel.service.vic.gov.au/open-data/v1';
const FUEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (data is ~24h delayed anyway)

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/camps' && request.method === 'GET') {
        const list = await env.CAMPFUEL_KV.get('host_camps', 'json') || [];
        return json(list);
      }
      if (path === '/camps' && request.method === 'POST') {
        const camp = await request.json();
        if (!camp.name || !camp.lat || !camp.lng) return json({ error: 'Missing fields' }, 400);
        camp.id = camp.id || Date.now();
        camp.created = new Date().toISOString();
        const list = await env.CAMPFUEL_KV.get('host_camps', 'json') || [];
        list.push(camp);
        await env.CAMPFUEL_KV.put('host_camps', JSON.stringify(list));
        return json({ ok: true, camp });
      }

      if (path === '/tracks' && request.method === 'GET') {
        const list = await env.CAMPFUEL_KV.get('submitted_tracks', 'json') || [];
        return json(list);
      }
      if (path === '/tracks' && request.method === 'POST') {
        const track = await request.json();
        if (!track.name || !track.coordinates) return json({ error: 'Missing fields' }, 400);
        track.id = track.id || Date.now();
        track.verified = false;
        track.reviews = track.reviews || 0;
        track.created = new Date().toISOString();
        const list = await env.CAMPFUEL_KV.get('submitted_tracks', 'json') || [];
        list.push(track);
        await env.CAMPFUEL_KV.put('submitted_tracks', JSON.stringify(list));
        return json({ ok: true, track });
      }

      if (path.startsWith('/tracks/') && path.endsWith('/review') && request.method === 'POST') {
        const id = parseInt(path.split('/')[2]);
        const list = await env.CAMPFUEL_KV.get('submitted_tracks', 'json') || [];
        const track = list.find(t => t.id === id);
        if (!track) return json({ error: 'Not found' }, 404);
        track.reviews = (track.reviews || 0) + 1;
        if (track.reviews >= 3) track.verified = true;
        await env.CAMPFUEL_KV.put('submitted_tracks', JSON.stringify(list));
        return json({ ok: true, track });
      }

      // --- Fuel prices (Servo Saver / Fair Fuel Open Data API) ---
      if (path === '/fuel/prices' && request.method === 'GET') {
        const data = await getFuelPrices(env);
        return json(data);
      }

      if (path === '/fuel/nearby' && request.method === 'GET') {
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        const radiusKm = parseFloat(url.searchParams.get('radius') || '25');
        const fuelType = url.searchParams.get('type') || null; // e.g. U91, DSL, P95

        if (isNaN(lat) || isNaN(lng)) {
          return json({ error: 'lat and lng query params required' }, 400);
        }

        const data = await getFuelPrices(env);
        const stations = (data.fuelPriceDetails || [])
          .map(item => {
            const station = item.fuelStation || {};
            const loc = station.location || {};
            if (loc.latitude == null || loc.longitude == null) return null;

            const dist = haversine(lat, lng, loc.latitude, loc.longitude);
            if (dist > radiusKm) return null;

            let prices = item.fuelPrices || [];
            if (fuelType) {
              prices = prices.filter(p => p.fuelType === fuelType);
              if (prices.length === 0) return null;
            }

            return {
              id: station.id,
              name: station.name,
              address: station.address,
              brandId: station.brandId,
              lat: loc.latitude,
              lng: loc.longitude,
              distanceKm: Math.round(dist * 10) / 10,
              prices: prices.map(p => ({
                type: p.fuelType,
                price: p.price, // cents per litre
                available: p.isAvailable,
                updatedAt: p.updatedAt,
              })),
              updatedAt: item.updatedAt,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.distanceKm - b.distanceKm);

        return json({
          query: { lat, lng, radiusKm, fuelType },
          count: stations.length,
          stations,
          note: 'Prices are ~24 hours delayed (Victorian Servo Saver Open Data API).',
        });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

async function getFuelPrices(env) {
  if (!env.SERVO_CONSUMER_ID) {
    throw new Error('SERVO_CONSUMER_ID secret not set');
  }

  const cached = await env.CAMPFUEL_KV.get('fuel_prices_cache', 'json');
  if (cached && Date.now() - cached.fetchedAt < FUEL_CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(`${FUEL_BASE}/fuel/prices`, {
    headers: {
      'User-Agent': 'Campfuel/1.0',
      'x-consumer-id': env.SERVO_CONSUMER_ID,
      'x-transactionid': crypto.randomUUID(),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Servo Saver API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  await env.CAMPFUEL_KV.put(
    'fuel_prices_cache',
    JSON.stringify({ data, fetchedAt: Date.now() }),
    { expirationTtl: 7200 } // 2 hours max
  );
  return data;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
