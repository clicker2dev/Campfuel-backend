// CampFuel Shared Backend
// Deploy to Cloudflare Workers with a KV namespace bound as CAMPFUEL_KV

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
