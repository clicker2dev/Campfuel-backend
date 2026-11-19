// CampFuel Backend - Unified
// Camps, tracks, VIC fuel (Servo Saver), QLD/NSW cams, multi-state fuel, AI planner
// Bindings: CAMPFUEL_KV, AI (optional), secrets as needed

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const FUEL_BASE = 'https://api.fuel.service.vic.gov.au/open-data/v1';
const FUEL_CACHE_TTL_MS = 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ========== Camps & Tracks ==========
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

      // ========== VIC Fuel (Servo Saver) ==========
      if (path === '/fuel/prices' && request.method === 'GET') {
        return json(await getFuelPrices(env));
      }
      if (path === '/fuel/nearby' && request.method === 'GET') {
        const lat = parseFloat(url.searchParams.get('lat'));
        const lng = parseFloat(url.searchParams.get('lng'));
        const radiusKm = parseFloat(url.searchParams.get('radius') || '25');
        const fuelType = url.searchParams.get('type') || null;
        if (isNaN(lat) || isNaN(lng)) return json({ error: 'lat and lng required' }, 400);
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
                price: p.price,
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
          note: 'Prices ~24h delayed (Victorian Servo Saver).',
        });
      }

      // ========== QLD Fuel (full state) ==========
      if (path === '/qld-fuel') {
        const token = env.QLD_SUBSCRIBER_TOKEN || '22dc9708-c338-4c8d-bcb8-81ac6e3edb35';
        const headers = { 'Authorization': 'FPDAPI SubscriberToken=' + token };
        const [sitesRes, pricesRes] = await Promise.all([
          fetch('https://fppdirectapi-prod.fuelpricesqld.com.au/Subscriber/GetFullSiteDetails?countryId=21&geoRegionLevel=3&geoRegionId=1', { headers }),
          fetch('https://fppdirectapi-prod.fuelpricesqld.com.au/Price/GetSitesPrices?countryId=21&geoRegionLevel=3&geoRegionId=1', { headers })
        ]);
        const s = await sitesRes.json();
        const p = await pricesRes.json();
        return json({ sites: s.S || [], prices: p.SitePrices || [] });
      }

      // ========== Traffic cams & events ==========
      if (path === '/qld-cams') {
        const res = await fetch('https://api.qldtraffic.qld.gov.au/v1/webcams?apikey=v50FSt8XXL8Eb8SO7HoLH71K2k2UPWHe7lGp8SsW');
        return new Response(await res.text(), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (path === '/qld-events') {
        const res = await fetch('https://api.qldtraffic.qld.gov.au/v2/events?apikey=v50FSt8XXL8Eb8SO7HoLH71K2k2UPWHe7lGp8SsW');
        return new Response(await res.text(), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (path === '/nsw-cams') {
        const res = await fetch('https://api.transport.nsw.gov.au/v1/live/cameras', {
          headers: { 'Authorization': 'apikey eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJRU0NIcTJXclJ6Y3Y3c1owalpESDlUQWkwVlVOWmlpb0x6VGw0c3RaYzZBIiwiaWF0IjoxNzkyNTQ3OTkwfQ.cljR0XpjFyG_uEtzY8kpvOpjM6vAoDGhIbFxZXESqaI' }
        });
        return new Response(await res.text(), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }

      // ========== AI Trip Planner ==========
      if (path === '/plan' && request.method === 'POST') {
        if (!env.AI) return json({ error: 'AI binding not configured' }, 500);
        const { prompt } = await request.json();
        if (!prompt) return json({ error: 'prompt required' }, 400);
        const aiResponse = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
          messages: [
            { role: 'system', content: 'You are a trip planning assistant for Australia. Extract structured data from the user request. Return ONLY valid JSON with fields: start, end, maxKm, preferFree, notes.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 256
        });
        let plan;
        try {
          const text = aiResponse.response || aiResponse;
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          plan = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
          plan = { error: 'Could not parse AI response', raw: aiResponse };
        }
        return json(plan);
      }

      // ========== Multi-state nearby fuel proxy ==========
      if (path === '/fuel/nearby-multi' || (path === '/' && url.searchParams.has('lat'))) {
        return await handleMultiStateFuel(request, env, ctx, url);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

async function getFuelPrices(env) {
  if (!env.SERVO_CONSUMER_ID) throw new Error('SERVO_CONSUMER_ID secret not set');
  const cached = await env.CAMPFUEL_KV.get('fuel_prices_cache', 'json');
  if (cached && Date.now() - cached.fetchedAt < FUEL_CACHE_TTL_MS) return cached.data;
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
  await env.CAMPFUEL_KV.put('fuel_prices_cache', JSON.stringify({ data, fetchedAt: Date.now() }), { expirationTtl: 7200 });
  return data;
}

async function handleMultiStateFuel(request, env, ctx, url) {
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const state = (url.searchParams.get('state') || 'nsw').toLowerCase();
  if (!lat || !lng) return json({ error: 'lat and lng required' }, 400);

  const latKey = Math.round(parseFloat(lat) * 20) / 20;
  const lngKey = Math.round(parseFloat(lng) * 20) / 20;
  const cacheKey = new Request(`https://cache.local/fuel?v=5&state=${state}&lat=${latKey}&lng=${lngKey}`);
  const cache = caches.default;
  let response = await cache.match(cacheKey);
  if (response) {
    response = new Response(response.body, response);
    response.headers.set('X-Cache', 'HIT');
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  }

  let data;
  if (state === 'nsw' || state === 'tas' || state === 'act') {
    if (!env.NSW_API_KEY || !env.NSW_API_SECRET) throw new Error('NSW API credentials not set');
    const tokenRes = await fetch('https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials', {
      headers: { 'Authorization': 'Basic ' + btoa(env.NSW_API_KEY + ':' + env.NSW_API_SECRET), 'Accept': 'application/json' }
    });
    if (!tokenRes.ok) throw new Error('NSW token failed: ' + tokenRes.status);
    const { access_token } = await tokenRes.json();
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const priceRes = await fetch('https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices/nearby', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'apikey': env.NSW_API_KEY,
        'transactionid': Date.now().toString(),
        'requesttimestamp': timestamp
      },
      body: JSON.stringify({ latitude: lat, longitude: lng, radius: '30', fueltype: 'U91' })
    });
    if (!priceRes.ok) throw new Error('NSW prices failed: ' + priceRes.status);
    data = await priceRes.json();
  } else if (state === 'wa') {
    const rssRes = await fetch('https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS?Product=1&Region=25', { headers: { 'User-Agent': 'CampFuel/1.0' } });
    if (!rssRes.ok) throw new Error('WA RSS failed: ' + rssRes.status);
    const xml = await rssRes.text();
    const stations = [];
    const parts = xml.split('<item>');
    for (let i = 1; i < parts.length && stations.length < 40; i++) {
      const item = parts[i].split('</item>')[0];
      const extract = (tag) => {
        const start = item.indexOf('<' + tag + '>');
        if (start === -1) return '';
        const end = item.indexOf('</' + tag + '>', start);
        return end === -1 ? '' : item.substring(start + tag.length + 2, end).trim();
      };
      const price = parseFloat(extract('price'));
      const sLat = parseFloat(extract('latitude'));
      const sLng = parseFloat(extract('longitude'));
      if (isNaN(price) || isNaN(sLat) || isNaN(sLng)) continue;
      stations.push({
        name: extract('trading-name') || extract('title') || 'Station',
        brand: extract('brand') || 'Fuel',
        latitude: sLat,
        longitude: sLng,
        price,
        address: extract('address'),
        location: extract('location')
      });
    }
    data = { stations };
  } else if (state === 'qld') {
    return json({ error: 'Use /qld-fuel for full state, or implement nearby QLD' }, 501);
  } else if (state === 'vic') {
    return json({ error: 'Use /fuel/nearby for VIC Servo Saver' }, 501);
  } else {
    return json({ error: 'Unsupported state: ' + state }, 400);
  }

  response = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800', 'X-Cache': 'MISS' }
  });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
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
