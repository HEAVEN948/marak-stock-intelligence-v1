// Marak Stock Intelligence — shared price-alert Worker (Cloudflare). One Worker serves all your users.
// Setup: bind a KV namespace as "KV" and add a Cron Trigger "* * * * *".
// Optional variables: INVITE (users must type this code once to register),
//                     UPSTOX_TOKEN (use your own Analytics token for everyone; otherwise each user's own token is used).
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type,x-uid','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
const json = (o, s = 200) => new Response(JSON.stringify(o), {status: s, headers: {...CORS, 'content-type': 'application/json'}});
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const norm = s => String(s).toLowerCase().replace(/\s+/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kget = async (env, k, d) => JSON.parse((await env.KV.get(k)) || d);
const PUSH_HOSTS = ['googleapis.com','mozilla.com','mozaws.net','push.apple.com','windows.com'];
const okEndpoint = e => { try { const u = new URL(e); return u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch (x) { return false; } };

async function getVapid(env) {
  let v = await kget(env, 'vapid', 'null');
  if (v) return v;
  const kp = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  v = {priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey))};
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}
async function signJwt(privJwk, payload) {
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const data = enc({typ:'JWT', alg:'ES256'}) + '.' + enc(payload);
  const key = await crypto.subtle.importKey('jwk', privJwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  return data + '.' + b64u(await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, new TextEncoder().encode(data)));
}
// Empty push; the app's service worker then fetches the message text from /pending.
async function sendPush(env, uid, u) {
  const v = await getVapid(env);
  const jwt = await signJwt(v.priv, {aud: new URL(u.sub.endpoint).origin, exp: Math.floor(Date.now()/1000) + 43200, sub: 'mailto:admin@example.com'});
  const r = await fetch(u.sub.endpoint, {method:'POST', headers:{TTL:'120', Urgency:'high', Authorization:`vapid t=${jwt}, k=${v.pub}`}});
  if (r.status === 404 || r.status === 410) { u.sub = null; await env.KV.put('u:' + uid, JSON.stringify(u)); }
  return r.status;
}
async function queue(env, uid, msgs) {
  const k = 'p:' + uid, p = (await kget(env, k, '[]')).concat(msgs).slice(-20);
  await env.KV.put(k, JSON.stringify(p));
}
async function getQuotes(keys, token) {
  try {
    const r = await fetch('https://api.upstox.com/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(keys), {headers:{Accept:'application/json', Authorization:'Bearer ' + token}});
    if (!r.ok) return {status: r.status};
    const out = {};
    Object.values((await r.json()).data || {}).forEach(q => { if (q && q.instrument_token && q.last_price != null) out[norm(q.instrument_token)] = q.last_price; });
    return {status: 200, prices: out};
  } catch (e) { return {status: 0}; }
}
function cleanWatch(w) {
  return (Array.isArray(w) ? w : []).slice(0, 10).map(x => ({
    name: String(x.name || '').slice(0, 20),
    key: String(x.key || ''),
    lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 30).map(l => ({id: String(l.id || '').slice(0, 20), p: +l.p})).filter(l => l.id && isFinite(l.p) && l.p > 0)
  })).filter(x => /^NSE_(EQ|INDEX|FO)\|[\w &-]{1,40}$/.test(x.key) && x.lines.length);
}

async function saveDbg(env, d, mins) {
  if (env.DEBUG || mins % 5 === 0) await env.KV.put('dbg', JSON.stringify(d));   // a few writes per hour; set variable DEBUG=1 to write every minute
}

async function run(env) {
  const ist = new Date(Date.now() + 19800000), day = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (!env.ANYTIME && (day === 0 || day === 6 || mins < 555 || mins > 935)) return;   // Mon-Fri 9:15-15:35 IST only
  const names = (await env.KV.list({prefix: 'u:'})).keys;
  const users = [], dbg = {at: new Date().toISOString(), registered: names.length, withPhone: 0, withToken: 0, withLines: 0, quotes: [], hits: 0, push: []};
  for (const k of names) {
    const u = await kget(env, k.name, 'null');
    if (!u) continue;
    if (u.sub) dbg.withPhone++;
    if (env.UPSTOX_TOKEN || u.token) dbg.withToken++;
    if ((u.watch || []).length) dbg.withLines++;
    if (u.sub && (env.UPSTOX_TOKEN || u.token) && (u.watch || []).length) users.push({uid: k.name.slice(2), u});
  }
  if (!users.length) { dbg.note = 'no user has a phone + token + lines all registered'; await saveDbg(env, dbg, mins); return; }
  const tokOf = u => env.UPSTOX_TOKEN || u.token, groups = new Map();
  users.forEach(({u}) => { const s = groups.get(tokOf(u)) || new Set(); u.watch.forEach(w => s.add(w.key)); groups.set(tokOf(u), s); });
  const polls = +env.POLLS || Math.max(1, Math.min(10, Math.floor(40 / groups.size))), gap = +env.GAP_MS || Math.floor(50000 / polls);
  const g = globalThis.__last = globalThis.__last || {}, today = ist.toISOString().slice(0, 10);
  for (let n = 0; n < polls; n++) {
    const res = new Map();
    await Promise.all([...groups].map(async ([t, keys]) => res.set(t, await getQuotes([...keys].join(','), t))));
    if (n === 0) res.forEach((r, t) => dbg.quotes.push({status: r.status, got: r.prices ? Object.keys(r.prices) : [], want: [...groups.get(t)].map(norm)}));
    const prev = {...g};
    for (const {uid, u} of users) {
      if (!u.sub) continue;
      const r = res.get(tokOf(u));
      if (r.status === 401 && !env.UPSTOX_TOKEN) {
        if (u.warn !== today) { u.warn = today; await env.KV.put('u:' + uid, JSON.stringify(u)); await queue(env, uid, [{title:'Upstox token expired', body:'Open the app and paste a fresh token.', tag:'msi-token'}]); await sendPush(env, uid, u); }
        continue;
      }
      if (!r.prices) continue;
      let dirty = false; const msgs = []; u.armed = u.armed || {};
      for (const w of u.watch) {
        const p = r.prices[norm(w.key)]; if (p == null) continue;
        const last = prev[w.key];
        for (const L of w.lines) {
          const dist = Math.abs(p - L.p) / L.p, st = u.armed[L.id];
          if (st === undefined) { u.armed[L.id] = dist > 0.003; dirty = true; continue; }   // new line: arm only if price isn't already on it
          if (!st) { if (dist > 0.003) { u.armed[L.id] = true; dirty = true; } continue; }  // re-arm after price moves 0.3% away
          if ((last != null && (last - L.p) * (p - L.p) <= 0) || dist <= 0.0005) {
            u.armed[L.id] = false; dirty = true;
            const kind = ((last != null ? last : p) > L.p) ? 'support' : 'resistance';
            dbg.hits++;
            msgs.push({title: `${w.name} hit ${kind}`, body: `${w.name} touched ${L.p.toFixed(2)} (price ${p.toFixed(2)})`, tag: L.id});
          }
        }
      }
      if (dirty) await env.KV.put('u:' + uid, JSON.stringify(u));
      if (msgs.length) { await queue(env, uid, msgs); dbg.push.push(await sendPush(env, uid, u)); }
    }
    res.forEach(r => { if (r.prices) Object.entries(r.prices).forEach(([k, v]) => { for (const {u} of users) for (const w of u.watch) if (norm(w.key) === k) g[w.key] = v; }); });
    if (n < polls - 1) await sleep(gap);
  }
  dbg.lastPrices = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v]));
  await saveDbg(env, dbg, mins);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, {headers: CORS});
    const u = new URL(req.url), uid = req.headers.get('x-uid') || u.searchParams.get('uid');
    if (u.pathname === '/vapid') return json({pub: (await getVapid(env)).pub});
    if (u.pathname === '/debug') { const ist = new Date(Date.now() + 19800000); return json({nowIST: ist.toISOString().slice(0, 16), lastRun: await kget(env, 'dbg', 'null')}); }
    if (!/^[a-f0-9]{32}$/.test(uid || '')) return json({ok: true});
    const k = 'u:' + uid;
    if (u.pathname === '/sync' && req.method === 'POST') {
      const b = await req.json(), old = await kget(env, k, 'null');
      if (!old && env.INVITE && b.invite !== env.INVITE) return json({error: 'invite code required or wrong'}, 403);
      if (!b.sub) { await env.KV.delete(k); await env.KV.delete('p:' + uid); return json({ok: true, removed: true}); }
      if (!okEndpoint(b.sub.endpoint)) return json({error: 'unsupported push service'}, 400);
      const watch = cleanWatch(b.watch), armed = {};
      watch.forEach(w => w.lines.forEach(l => { if (old && old.armed && old.armed[l.id] !== undefined) armed[l.id] = old.armed[l.id]; }));
      await env.KV.put(k, JSON.stringify({sub: {endpoint: b.sub.endpoint, keys: b.sub.keys}, token: String(b.token || '').slice(0, 4000), watch, armed, warn: old ? old.warn || '' : ''}));
      return json({ok: true, lines: watch.reduce((a, w) => a + w.lines.length, 0)});
    }
    if (u.pathname === '/pending') {
      const p = await kget(env, 'p:' + uid, '[]');
      if (p.length) await env.KV.put('p:' + uid, '[]');
      return json(p);
    }
    if (u.pathname === '/test') {
      const usr = await kget(env, k, 'null');
      if (!usr || !usr.sub) return json({error: 'This phone is not registered yet. Tap Enable in the app first.'}, 400);
      await queue(env, uid, [{title: 'Test alert', body: 'Alerts are working on this phone.', tag: 'msi-test'}]);
      return json({pushStatus: await sendPush(env, uid, usr)});
    }
    return json({ok: true});
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};
