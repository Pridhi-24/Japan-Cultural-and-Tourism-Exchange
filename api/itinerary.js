'use strict';
/**
 * POST /api/itinerary
 * Body: { lang, interests, diet, budget, pace, access, mustVisit, date }
 * Returns: { activities:[{placeId,start,end,travel,outdoor,pinned}], notes, fallback }
 *
 * Plain Node (works on 18+), no dependencies. Needs env GEMINI_API_KEY.
 * Optional env: GEMINI_MODEL (default gemini-3.8-flash), GEMINI_THINKING_LEVEL (default low).
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const THINKING = process.env.GEMINI_THINKING_LEVEL || 'low';
const DEADLINE_MS = 7000; // hard cap for the whole request
const DAY_START = 8 * 60 + 30; // 08:30
const DAY_END = 20 * 60; // 20:00
const BUFFER = { slow: 30, balanced: 20, packed: 10 }; // minutes between stops (after travel)
const TARGET = { slow: '4-5', balanced: '5-6', packed: '7-8' };
const REQUIRED = new Set(['culture', 'crafts', 'homestay']);
const LANGS = { en: 'English', ja: 'Japanese', hi: 'Hindi' };
// the front end's map pins -> a concrete place in places.json
const MUST_MAP = {
  meiji: 'meiji-jingu', harajuku: 'takeshita-street', shibuya: 'shibuya-crossing', senso: 'sensoji',
  asakusa: 'edo-taito', tsuki: 'monja-street', ueno: 'ueno-park', akiba: 'electric-town',
};
const CAT_OF = {
  culture: ['culture'], food: ['food'], nature: ['nature', 'relax'], pop: ['pop'], crafts: ['crafts', 'homestay'],
};
const MSG = {
  en: {
    noDiet: 'None of our listed restaurants is confirmed for your diet, so please check menus or carry snacks.',
    dropped: 'Could not fit: {x}.',
    mismatch: '{x} may not suit your access or diet needs.',
    noCulture: 'No culture or crafts stop fit your access, budget and opening-hour limits today.',
  },
  ja: {
    noDiet: 'ご希望の食事条件に合うお店がリストにありません。メニューをご確認いただくか、軽食をお持ちください。',
    dropped: '時間内に入りきりませんでした: {x}。',
    mismatch: '{x}は配慮条件や食事条件に合わない可能性があります。',
    noCulture: 'ご希望の条件と営業時間の範囲では、文化・工芸のスポットを入れられませんでした。',
  },
  hi: {
    noDiet: 'आपकी खान-पान की ज़रूरत से मेल खाता कोई रेस्तरां हमारी सूची में नहीं है; मेन्यू जाँच लें या नाश्ता साथ रखें।',
    dropped: 'समय में फिट नहीं हो सके: {x}।',
    mismatch: '{x} आपकी ज़रूरतों के अनुकूल नहीं हो सकता।',
    noCulture: 'आपकी ज़रूरतों, बजट और खुलने के समय में संस्कृति या शिल्प का कोई स्थान फिट नहीं हो सका।',
  },
};

/* ------------------------------ helpers ------------------------------ */

const cache = {};
function loadJson(name) {
  if (cache[name]) return cache[name];
  for (const dir of [path.join(process.cwd(), 'data'), path.join(__dirname, '..', 'data')]) {
    try {
      return (cache[name] = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (e) { /* try next location */ }
  }
  throw new Error('missing_' + name);
}

const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  return m ? +m[1] * 60 + +m[2] : NaN;
};
const fmt = (m) => String((m / 60) | 0).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// Opening window in minutes. Overnight venues (openTo <= openFrom) are treated as open until midnight.
function openWindow(p) {
  const from = toMin(p.openFrom);
  let to = toMin(p.openTo);
  if (!(to > from)) to = 24 * 60;
  return { from: Number.isFinite(from) ? from : 0, to };
}
const planDur = (p) => (p.category === 'homestay' ? Math.min(p.durationMin, 60) : p.durationMin);

function dist(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// rough minutes between two places: walking when close, otherwise train + waiting
function estTravel(a, b) {
  const d = dist(a, b);
  const mins = d <= 1.2 ? (d / 4.8) * 60 + 3 : 12 + (d / 22) * 60;
  return Math.min(75, Math.max(5, Math.round(mins)));
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } }
  return {};
}

function parseInput(b) {
  const list = (v, max) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, 40)).slice(0, max);
  const lang = LANGS[b.lang] ? b.lang : 'en';
  const interests = list(b.interests, 10).map((x) => x.toLowerCase().replace(/^f\./, ''));
  const accessMap = { stepfree: 'stepFree', seats: 'seats', toilet: 'toilet' };
  const access = list(b.access, 5).map((x) => accessMap[x.toLowerCase()]).filter(Boolean);
  if (interests.includes('access') && !access.includes('stepFree')) access.push('stepFree');
  const diet = list(b.diet, 5).map((x) => x.toLowerCase()).filter((x) => ['veg', 'vegan', 'jain', 'halal'].includes(x));
  const budget = ['low', 'medium', 'flexible'].includes(b.budget) ? b.budget : 'medium';
  const pace = BUFFER[b.pace] ? b.pace : 'balanced';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && !isNaN(Date.parse(b.date)) ? b.date : null;
  return { lang, interests, diet, budget, pace, access, mustVisit: list(b.mustVisit, 10), date };
}

function dietOk(p, diet) {
  const have = new Set(p.diet || []);
  return diet.every((d) => (d === 'veg' ? have.has('veg') || have.has('vegan') : have.has(d)));
}

/* --------------------------- candidate pool --------------------------- */

function buildPool(inp, places) {
  const all = new Map(places.map((p) => [p.id, p]));
  const must = new Set();
  for (const raw of inp.mustVisit) {
    const k = raw.replace(/^place:/, '');
    const id = all.has(k) ? k : MUST_MAP[k];
    if (id && all.has(id)) must.add(id);
  }
  const maxPrice = { low: 1, medium: 2, flexible: 3 }[inp.budget];
  const monday = inp.date ? new Date(inp.date + 'T00:00:00Z').getUTCDay() === 1 : false;
  const wanted = new Set(inp.interests.flatMap((i) => CAT_OF[i] || []));
  const mismatched = [];

  const passes = (p) => {
    if (monday && (p.tags || []).includes('closed-monday')) return false;
    if (!inp.access.every((a) => (p.access || []).includes(a))) return false;
    if (p.category === 'food' && !dietOk(p, inp.diet)) return false;
    const cap = Math.min(3, maxPrice + (p.category === 'food' ? 1 : 0));
    return p.priceLevel <= cap;
  };

  const base = places.filter(passes);
  let pool = base.filter((p) => (wanted.size ? wanted.has(p.category) || p.category === 'food' : p.category !== 'homestay'));
  if (!pool.some((p) => REQUIRED.has(p.category))) {
    pool = pool.concat(base.filter((p) => p.category === 'culture' || p.category === 'crafts'));
  }
  for (const id of must) {
    const p = all.get(id);
    if (!pool.some((q) => q.id === id)) {
      pool.push(p);
      if (!passes(p)) mismatched.push(p);
    }
  }
  pool = [...new Map(pool.map((p) => [p.id, p])).values()];
  const noDiet = inp.diet.length > 0 && !pool.some((p) => p.category === 'food');
  return { pool, must, byId: new Map(pool.map((p) => [p.id, p])), wanted, mismatched, noDiet };
}

/* ------------------------------ Gemini ------------------------------ */

function buildPrompt(inp, ctx) {
  const rows = ctx.pool.map((p) => {
    const w = openWindow(p);
    return {
      id: p.id, name: p.name, area: p.area, cat: p.category, lat: p.lat, lng: p.lng,
      open: fmt(w.from), close: fmt(Math.min(w.to, 1439)), mins: planDur(p), outdoor: p.outdoor,
      price: p.priceLevel, tags: (p.tags || []).slice(0, 3),
    };
  });
  const system = [
    'You are a careful Tokyo day-trip planner.',
    'Reply with ONE JSON object only: no markdown, no commentary.',
    'Schema: {"activities":[{"placeId":string,"start":"HH:MM","end":"HH:MM","travel":number,"outdoor":boolean,"pinned":boolean}],"notes":string}',
    'Use ONLY placeId values from the candidate list. Never invent places or ids. Use each id at most once.',
  ].join('\n');
  const user = [
    `Plan one day. Write "notes" in ${LANGS[inp.lang]} (max 300 characters; mention one useful tip).`,
    `Day window: 08:30-20:00. Every stop must start at or after its "open" time and end at or before its "close" time.`,
    `Between consecutive stops leave travel time (minutes, estimate from coordinates and Tokyo transit) PLUS a buffer of ${BUFFER[inp.pace]} minutes.`,
    `Pace: ${inp.pace}. Aim for ${TARGET[inp.pace]} stops. Group nearby areas to cut travel; do not criss-cross the city.`,
    'Include at least one stop with cat culture, crafts or homestay.',
    ctx.must.size
      ? `Must-visit ids (include all, set pinned:true): ${[...ctx.must].join(', ')}. All other stops pinned:false.`
      : 'No must-visits; set pinned:false for every stop.',
    'If food candidates exist, schedule a lunch around 12:00-14:00 and, if the day runs late, dinner around 18:00-19:30.',
    `Budget: ${inp.budget}. Diet: ${inp.diet.join(', ') || 'none'}. Access needs: ${inp.access.join(', ') || 'none'}. Interests: ${inp.interests.join(', ') || 'any'}.`,
    `Date: ${inp.date || 'unknown'}.`,
    `Set outdoor exactly as given for each place. Candidates (JSON):`,
    JSON.stringify(rows),
  ].join('\n');
  return { system, user };
}

async function askGemini(key, prompt, signal) {
  const call = (thinking) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
        },
      }),
    },
  );
  let res = await call(THINKING === 'off' ? '' : THINKING);
  // some models reject thinkingConfig: retry once without it
  if (res.status === 400 && THINKING !== 'off') res = await call('');
  if (!res.ok) throw new Error('gemini_http_' + res.status);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter((x) => typeof x.text === 'string' && !x.thought).map((x) => x.text).join('');
  if (!text) throw new Error('gemini_empty');
  return text;
}

function parseModelJson(text) {
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('bad_json');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!obj || !Array.isArray(obj.activities)) throw new Error('bad_shape');
  return obj;
}

/* --------------------------- validation / repair --------------------------- */

// raw model rows -> [{p,start,end}] (unknown ids dropped, duplicates dropped)
function toItems(rows, byId) {
  const seen = new Set(), items = [];
  for (const r of rows.slice(0, 20)) {
    const id = r && (r.placeId || r.id || r.place_id);
    const p = byId.get(id);
    if (!p || seen.has(id)) continue;
    seen.add(id);
    items.push({ p, start: toMin(r.start), end: toMin(r.end) });
  }
  return items;
}

// sort, keep opening hours, push later items forward so travel+buffer always fits, drop what can't fit
function fit(items, buffer) {
  const key = (x) => (Number.isFinite(x.start) ? x.start : 9999);
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const out = [], dropped = [];
  for (const it of sorted) {
    const p = it.p, w = openWindow(p), nominal = planDur(p);
    let dur = it.end - it.start;
    if (!(dur >= 15)) dur = nominal;
    dur = Math.min(Math.max(dur, 20), Math.round(nominal * 1.5));
    const prev = out[out.length - 1];
    const travel = prev ? estTravel(prev.p, p) : 0;
    let minStart = Math.max(DAY_START, w.from);
    if (prev) minStart = Math.max(minStart, prev.end + travel + buffer);
    const start = Number.isFinite(it.start) ? Math.max(it.start, minStart) : minStart;
    const close = Math.min(DAY_END, w.to);
    let end = start + dur;
    if (end > close) {
      if (close - start >= Math.max(20, Math.round(nominal * 0.5))) end = close;
      else { dropped.push(p); continue; }
    }
    out.push({ p, start, end, travel });
  }
  return { out, dropped };
}

// try to add place p to an already valid plan at the geographically cheapest slot
function tryInsert(out, p, buffer) {
  const base = out.map(({ p: q, start, end }) => ({ p: q, start, end }));
  const slots = [];
  for (let i = -1; i < base.length; i++) {
    const a = base[i] && base[i].p, b = base[i + 1] && base[i + 1].p;
    slots.push({ i, detour: (a ? dist(a, p) : 0) + (b ? dist(p, b) : 0) - (a && b ? dist(a, b) : 0) });
  }
  slots.sort((x, y) => x.detour - y.detour);
  for (const { i } of slots) {
    const start = i < 0 ? 0 : base[i].end + 1;
    const r = fit([...base, { p, start, end: start + planDur(p) }], buffer);
    if (r.out.length === base.length + 1 && r.out.some((a) => a.p.id === p.id)) return r.out;
  }
  return null;
}

function assemble(items, ctx, inp) {
  const buffer = BUFFER[inp.pace], L = MSG[inp.lang], notes = [];
  let out = fit(items, buffer).out;

  const lost = [];
  for (const id of ctx.must) {
    if (out.some((a) => a.p.id === id)) continue;
    const r = tryInsert(out, ctx.byId.get(id), buffer);
    if (r) out = r; else lost.push(ctx.byId.get(id));
  }
  if (!out.some((a) => REQUIRED.has(a.p.category))) {
    const cands = ctx.pool
      .filter((p) => REQUIRED.has(p.category) && !out.some((a) => a.p.id === p.id))
      .sort((a, b) => (ctx.wanted.has(a.category) ? 0 : 1) - (ctx.wanted.has(b.category) ? 0 : 1))
      .slice(0, 8);
    for (const p of cands) {
      const r = tryInsert(out, p, buffer);
      if (r) { out = r; break; }
    }
  }
  // validation may have dropped stops (closed, no room): top up with nearby candidates before giving up
  const low = { slow: 4, balanced: 5, packed: 6 }[inp.pace];
  if (out.length < low) {
    const cands = ctx.pool
      .filter((p) => p.category !== 'homestay' && !out.some((a) => a.p.id === p.id))
      .sort((a, b) => (ctx.wanted.has(a.category) ? 0 : 1) - (ctx.wanted.has(b.category) ? 0 : 1));
    for (const p of cands) {
      if (out.length >= low) break;
      if (p.category === 'food' && out.filter((a) => a.p.category === 'food').length >= 2) continue;
      const r = tryInsert(out, p, buffer);
      if (r) out = r;
    }
  }
  if (out.length < 3) throw new Error('too_few_stops');

  if (lost.length) notes.push(L.dropped.replace('{x}', lost.map((p) => p.name).join(', ')));
  if (ctx.mismatched.length) notes.push(L.mismatch.replace('{x}', ctx.mismatched.map((p) => p.name).join(', ')));
  if (ctx.noDiet) notes.push(L.noDiet);
  // honour the traveller's hard filters over the culture rule: say so instead of ignoring access/diet
  if (!out.some((a) => REQUIRED.has(a.p.category))) notes.push(L.noCulture);

  return {
    activities: out.map((a) => ({
      placeId: a.p.id,
      start: fmt(a.start),
      end: fmt(a.end),
      travel: a.travel,
      outdoor: !!a.p.outdoor,
      pinned: ctx.must.has(a.p.id),
    })),
    serverNotes: notes,
  };
}

/* ------------------------------ handler ------------------------------ */

async function plan(inp, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no_api_key');
  const ctx = buildPool(inp, loadJson('places.json'));
  if (ctx.pool.length < 4) throw new Error('pool_too_small');
  const text = await askGemini(key, buildPrompt(inp, ctx), signal);
  const raw = parseModelJson(text);
  const items = toItems(raw.activities, ctx.byId);
  if (!items.length) throw new Error('no_valid_activities');
  const { activities, serverNotes } = assemble(items, ctx, inp);
  const modelNote = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 400) : '';
  return { activities, notes: [modelNote, ...serverNotes].filter(Boolean).join(' ').slice(0, 700) };
}

function sendFallback(res, lang, reason) {
  try {
    const f = loadJson('fallback_itinerary.json');
    const n = f.notes;
    const notes = n && typeof n === 'object' ? n[lang] || n.en || '' : n || '';
    return res.status(200).json({ activities: f.activities, notes, fallback: true, reason });
  } catch (e) {
    return res.status(500).json({ activities: [], notes: '', fallback: true, reason: 'fallback_missing' });
  }
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }
  let inp;
  try { inp = parseInput(readBody(req)); } catch (e) { inp = parseInput({}); }

  const ac = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')); }, DEADLINE_MS);
  });
  try {
    const result = await Promise.race([plan(inp, ac.signal), deadline]);
    clearTimeout(timer);
    return res.status(200).json({ ...result, fallback: false });
  } catch (e) {
    clearTimeout(timer);
    const reason = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error';
    console.error('itinerary fallback:', reason);
    return sendFallback(res, inp.lang, reason);
  }
}

module.exports = handler;
module.exports._internals = { parseInput, buildPool, fit, assemble, toItems, estTravel, parseModelJson, fmt, toMin };