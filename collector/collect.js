#!/usr/bin/env node
"use strict";
/* ═══ GIFT ATELIER COLLECTOR — 5 независимых сканеров улучшений ═══
   Первоисточник — публичные страницы Telegram t.me/nft/<slug>-<N>.

   ПЯТЬ СКАНЕРОВ (каждый ищет улучшения своим методом, все пишут телеметрию):
     S1 ORACLE-BIN  — бинарный поиск точной границы выпуска
     S2 ORACLE-LIN  — линейный пробер свежих номеров (быстрый путь, 1-6 запросов)
     S3 RANGE-SCAN  — параллельная контрольная проверка диапазонов скачков
     S4 VERIFY      — перекрёстная перепроверка случайных коллекций
     S5 SENTINEL    — сторож аномалий и всплесков скорости (без запросов)

   Дополнительно: имена и арты коллекций с nft.fragment.com (доп. данные,
   кэшируется в docs/fragment.json, обновляется по-немногу каждый цикл).

   Выход:
     docs/gifts.json, docs/status.json (вкл. телеметрию 5 сканеров),
     docs/live.json, docs/history.json, docs/fragment.json,
     docs/index.html (BOOT-срез), collector/state.json, collector/samples.json
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const REG_PATH = path.join(__dirname, 'registry.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const SAMPLES_PATH = path.join(__dirname, 'samples.json');
const FRAG_PATH = path.join(DOCS, 'fragment.json');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PROBE_TIMEOUT = 9000;
const POOL = 7;
const SAMPLES_WINDOW = 48*3600;
const FRAG_PER_CYCLE = 15;     // сколько fragment-имён обновлять за цикл
const FRAG_TTL = 7*24*3600;    // неделя актуальности

function readJSON(p, dflt){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e){ return dflt; } }
function writeJSON(p, obj){ fs.writeFileSync(p, JSON.stringify(obj)); }

/* ═══ ТЕЛЕМЕТРИЯ 5 СКАНЕРОВ ═══ */
const SCAN = {
  s1: { id: 'S1', name: 'ORACLE-BIN',  title: 'Бинарный поиск границы',      req: 0, found: 0, ok: false },
  s2: { id: 'S2', name: 'ORACLE-LIN',  title: 'Линейный пробер свежих',      req: 0, found: 0, ok: false },
  s3: { id: 'S3', name: 'RANGE-SCAN',  title: 'Контроль диапазонов скачков', req: 0, found: 0, ok: false },
  s4: { id: 'S4', name: 'VERIFY',      title: 'Перекрёстная перепроверка',    req: 0, found: 0, ok: false },
  s5: { id: 'S5', name: 'SENTINEL',    title: 'Сторож всплесков скорости',    req: 0, found: 0, ok: false }
};

/* ─── оракул: существует ли NFT-номер (с атрибуцией запросов сканеру) ─── */
const oracleCache = new Map();
const artCache = new Map(); // slug#n -> уникальная картинка этого экземпляра (model/backdrop/symbol), из той же страницы оракула
function extractArt(body){
  const m = body.match(/property="og:image"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}
async function exists(slug, n, stat){
  const key = slug + '#' + n;
  if (oracleCache.has(key)) return oracleCache.get(key);
  for (let attempt = 0; attempt < 2; attempt++){
    try {
      if (stat) stat.req++;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
      const res = await fetch('https://t.me/nft/' + slug.toLowerCase() + '-' + n, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
        signal: ctl.signal, redirect: 'follow'
      });
      clearTimeout(t);
      const body = await res.text();
      const ok = body.indexOf('NFT was created') >= 0;
      oracleCache.set(key, ok);
      if (ok){ const art = extractArt(body); if (art) artCache.set(key, art); }
      return ok;
    } catch(e) {
      if (attempt === 1) throw new Error('oracle-net:' + slug + '#' + n);
      await new Promise(r => setTimeout(r, 700 + Math.random()*600));
    }
  }
}
async function safeExists(slug, n, stat){
  try { return await exists(slug, n, stat); } catch(e){ return null; }
}

/* ═══ СКАН КОЛЛЕКЦИИ: S2 (линейно) → S1 (экспонента+бинар) ═══ */
async function scanCollection(slug, lastKnown, total){
  /* первый полный проход — чистый S1 (бинарный от нуля) */
  if (!lastKnown || lastKnown < 0){
    let lo = 0, hi = Math.max(2, total || 100);
    const zero = await safeExists(slug, 1, SCAN.s1);
    if (zero === null) return null;
    if (!zero) return 0;
    while (lo < hi){
      const mid = Math.ceil((lo + hi) / 2);
      const r = await safeExists(slug, mid, SCAN.s1);
      if (r === null) return null;
      if (r) lo = mid; else hi = mid - 1;
    }
    SCAN.s1.found++;
    return lo;
  }
  if (total && lastKnown >= total) return lastKnown;

  /* S2: линейный пробер — свежие номера чаще всего идут подряд */
  let cur = lastKnown;
  for (let probe = 0; probe < 6; probe++){
    const r = await safeExists(slug, cur + 1, SCAN.s2);
    if (r === null) return null;
    if (!r) break;
    cur++;
  }
  if (cur === lastKnown) return lastKnown;        // ничего нового — 1 запрос
  if (cur - lastKnown < 6){ SCAN.s2.found++; return cur; } // малый скачок поймал S2
  SCAN.s2.found++;

  /* S1: экспоненциальный проход вверх + бинарная доводка */
  let step = 1, lo = cur;
  const cap = Math.max((total || 0) + 16, lo + 4096);
  let hi = null;
  while (hi === null){
    const cand = Math.min(lo + step, cap);
    const r = await safeExists(slug, cand, SCAN.s1);
    if (r === null) return null;
    if (r){ lo = cand; step *= 2; if (cand >= cap) { hi = cap; break; } }
    else hi = cand;
  }
  while (hi - lo > 1){
    const mid = Math.floor((lo + hi) / 2);
    const r = await safeExists(slug, mid, SCAN.s1);
    if (r === null) return null;
    if (r) lo = mid; else hi = mid;
  }
  SCAN.s1.found++;
  return lo;
}

/* ═══ S3: контрольная проверка диапазонов скачков ═══ */
async function scanRangeCheck(result){
  const hot = [];
  for (const slug in result){
    const r = result[slug];
    if (r && r.newRange && r.newRange[1] - r.newRange[0] >= 3) hot.push(slug);
  }
  let verified = 0;
  for (const slug of hot){
    const r = result[slug];
    const mid = Math.floor((r.newRange[0] + r.newRange[1]) / 2);
    const [a, b] = await Promise.all([
      safeExists(slug, r.newRange[1], SCAN.s3),
      safeExists(slug, mid, SCAN.s3)
    ]);
    if (a === null && b === null) continue;
    if (a === true || b === true) verified++;
  }
  SCAN.s3.found = verified;
  SCAN.s3.ok = true;
  return hot.length;
}

/* ═══ S4: перекрёстная перепроверка случайных коллекций ═══ */
async function scanVerify(result, registry){
  const done = Object.keys(result);
  if (!done.length) return 0;
  let corrections = 0;
  const picked = [];
  while (picked.length < Math.min(5, done.length) && picked.length < done.length){
    const s = done[Math.floor(Math.random() * done.length)];
    if (picked.indexOf(s) < 0) picked.push(s);
  }
  for (const slug of picked){
    const i = result[slug].issued;
    const [nowOk, nextOk] = await Promise.all([
      safeExists(slug, i, SCAN.s4),
      safeExists(slug, i + 1, SCAN.s4)
    ]);
    if (nowOk === null && nextOk === null) continue;
    if (nowOk === false || nextOk === true){
      /* реальность отличается — пересканируем полностью */
      const col = registry.find(c => String(c.slug || c.name).trim() === slug) || { total: 0 };
      const re = await scanCollection(slug, null, col.total || 0);
      if (re !== null && (!result[slug] || re !== result[slug].issued)){
        const last = result[slug] ? result[slug].issued : null;
        result[slug] = { issued: re, isNew: false };
        if (last !== null && re > last) result[slug].newRange = [last + 1, re];
        corrections++;
      }
    }
  }
  SCAN.s4.found = corrections;
  SCAN.s4.ok = true;
  return corrections;
}

/* ═══ S5: сторож всплесков (анализ, без запросов) ═══ */
function scanSentinel(result, state, prevDeltas){
  let spikes = 0;
  const spikeList = [];
  for (const slug in result){
    const r = result[slug];
    if (!r || r.isNew) continue;
    const delta = r.issued - (r.last !== undefined ? r.last : (state.c[slug] ? state.c[slug].i : r.issued));
    const prev = prevDeltas[slug] || 0;
    if (delta > 0 && (delta >= 20 || (prev > 0 && delta > prev * 3))){
      spikes++; spikeList.push({ slug: slug, delta: delta, prev: prev });
    }
    /* аномалия: номер уменьшился — ошибка оракула, держим прошлое */
    if (delta < 0){
      result[slug].issued = state.c[slug].i;
      result[slug].newRange = undefined;
      spikes++;
    }
  }
  SCAN.s5.found = spikes;
  SCAN.s5.ok = true;
  return spikeList;
}

/* ═══ Fragment: имена и арты коллекций (доп. данные) ═══ */
async function fetchFragment(fragCache, registry, now){
  const todo = [];
  for (const c of registry){
    const slug = String(c.slug || c.name).trim();
    const e = fragCache[slug];
    if (!e || !e.name || now - e.ts > FRAG_TTL) todo.push(slug);
  }
  const batch = todo.slice(0, FRAG_PER_CYCLE);
  let fetched = 0;
  for (const slug of batch){
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch('https://nft.fragment.com/collection/' + slug.toLowerCase() + '.json', {
        headers: { 'User-Agent': UA }, signal: ctl.signal
      });
      clearTimeout(t);
      if (!res.ok) throw 0;
      const j = await res.json();
      if (j && j.name){
        fragCache[slug] = { name: j.name, img: j.image || ('https://nft.fragment.com/collection/' + slug.toLowerCase() + '.webp'), ts: now };
        fetched++;
      }
    } catch(e){ fragCache[slug] = { name: null, img: null, ts: now }; }
    await new Promise(r => setTimeout(r, 150 + Math.random()*150));
  }
  return fetched;
}

/* ─── пул воркеров ─── */
async function pool(items, n, fn){
  let idx = 0, netFails = 0;
  const worker = async () => {
    while (true){
      const i = idx++;
      if (i >= items.length) return;
      try { await fn(items[i], i); }
      catch(e){ netFails++; if (netFails > 8) throw e; }
      await new Promise(r => setTimeout(r, 40 + Math.random()*80));
    }
  };
  await Promise.all(Array.from({length: Math.min(n, items.length)}, worker));
  return netFails;
}

/* ═══ main ═══ */
(async () => {
  const t0 = Date.now();
  const registry = readJSON(REG_PATH, []);
  if (!registry.length){ console.log('::error::registry empty'); process.exit(1); }
  const state = readJSON(STATE_PATH, { v: 1, ts: 0, c: {}, recent: [], scan: null, prevDeltas: {} });
  const samples = readJSON(SAMPLES_PATH, { v: 1, s: {} });
  const fragCache = readJSON(FRAG_PATH, {});
  const now = Math.floor(Date.now()/1000);

  /* миграция легаси-событий: slug мог быть именем с пробелами ('Candy Canes') —
     приводим к каноничному slug реестра, чтобы арт и дедуп работали всегда */
  const canIdx = {}, nameIdx = {};
  function normS(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
  for (const c of registry){
    const s = String(c.slug || c.name).trim();
    canIdx[s.toLowerCase()] = s; canIdx[normS(s)] = s;
    const nm = (fragCache[s] && fragCache[s].name) || c.name || s;
    nameIdx[String(nm).toLowerCase()] = s; nameIdx[normS(nm)] = s;
  }
  function canonSlug(slug, gift){
    const q = String(slug||'').trim().toLowerCase();
    if (canIdx[q]) return canIdx[q];
    if (canIdx[normS(q)]) return canIdx[normS(q)];
    const g = String(gift||'').trim().toLowerCase();
    if (nameIdx[g]) return nameIdx[g];
    if (nameIdx[normS(g)]) return nameIdx[normS(g)];
    const st = normS(q || g); let best = null, bl = 0;
    for (const k in canIdx){ if (k.length > bl && st.length >= 4 && (st.indexOf(k) === 0 || k.indexOf(st) === 0)){ best = canIdx[k]; bl = k.length; } }
    return best || String(slug||'').trim();
  }
  for (const e of (state.recent||[])) e.slug = canonSlug(e.slug, e.gift);
  const result = {};
  const failed = [];

  /* Фаза 1: S2+S1 сканируют все коллекции */
  await pool(registry, POOL, async (col) => {
    const slug = String(col.slug || col.name).trim();
    const last = state.c[slug] ? state.c[slug].i : null;
    const i = await scanCollection(slug, last, col.total);
    if (i === null){ failed.push(slug); return; }
    result[slug] = { issued: i, isNew: (last === null || last === undefined) };
    if (last !== null && last !== undefined && i > last){
      result[slug].newRange = [last + 1, i];
      result[slug].last = last;
    }
  });
  SCAN.s1.ok = true; SCAN.s2.ok = true;

  const MIN_OK = Number(process.env.MIN_OK || 10);
  if (Object.keys(result).length < MIN_OK){
    console.log('::error::oracle unusable, keep previous state (' + Object.keys(result).length + ' ok)');
    process.exit(1);
  }

  /* Фаза 2: S5 сторож аномалий (до записи событий) */
  const spikeList = scanSentinel(result, state, state.prevDeltas || {});

  /* Фаза 3: S3 контроль диапазонов + S4 перепроверка */
  const hotRanges = await scanRangeCheck(result);
  const corrections = await scanVerify(result, registry);

  /* Фаза 4: Fragment-имена (доп. данные) */
  const fragFetched = await fetchFragment(fragCache, registry, now);

  /* дельты для S5 на следующий цикл */
  const prevDeltas = {};
  for (const slug in result) prevDeltas[slug] = result[slug].issued - (result[slug].last !== undefined ? result[slug].last : (state.c[slug] ? state.c[slug].i : result[slug].issued));
  state.prevDeltas = prevDeltas;

  /* новые события */
  let addedEvents = 0;
  for (const slug in result){
    const r = result[slug];
    if (!r.newRange) continue;
    for (let n = r.newRange[0]; n <= r.newRange[1]; n++){
      const artKey = slug + '#' + n;
      state.recent.unshift({ slug: slug, gift: null, number: n, mint: now, art: artCache.get(artKey) || null });
      addedEvents++;
    }
  }
  const nameBySlug = {};
  registry.forEach(c => nameBySlug[String(c.slug||c.name).trim()] = c.name || c.slug);
  state.recent.forEach(e => { if (!e.gift) e.gift = (fragCache[e.slug] && fragCache[e.slug].name) || nameBySlug[e.slug] || e.slug; });
  state.recent = state.recent.slice(0, 200);

  /* состояние коллекций (имена — из Fragment, если есть) */
  let mintedTotal = 0, finished = 0;
  const gifts = registry.map(c => {
    const slug = String(c.slug||c.name).trim();
    const r = result[slug] || { issued: state.c[slug] ? state.c[slug].i : 0 };
    const i = Math.max(0, r.issued);
    let total = c.total;
    if (r.issued > total) total = r.issued;
    mintedTotal += i;
    if (total && i >= total) finished++;
    state.c[slug] = { i: i, ts: now };
    const fname = (fragCache[slug] && fragCache[slug].name) || null;
    return { slug: slug, name: fname || c.name || slug, issued: i, total: total, added: c.added || 0 };
  });

  /* выборки скорости */
  for (const g of gifts){
    const arr = samples.s[g.slug] || [];
    arr.push([now, g.issued]);
    const cut = now - SAMPLES_WINDOW;
    const kept = arr.filter(x => x[0] >= cut);
    samples.s[g.slug] = kept.length > 400 ? kept.slice(-400) : kept;
  }
  const rates = {};
  for (const g of gifts){
    const arr = samples.s[g.slug] || [];
    if (arr.length < 2) continue;
    const fresh = arr.filter(x => now - x[0] <= 3*3600);
    if (fresh.length < 2) continue;
    const a = fresh[0], b = fresh[fresh.length-1];
    const dh = (b[0] - a[0]) / 3600;
    if (dh < 0.2) continue;
    const rate = (b[1] - a[1]) / dh;
    if (rate > 0.01) rates[g.slug] = Math.round(rate * 100) / 100;
  }
  gifts.forEach(g => { g.rate = rates[g.slug] || 0; });

  /* ─── выхлоп для фронта ─── */
  writeJSON(path.join(DOCS, 'gifts.json'), { gifts: gifts, updated: new Date(now*1000).toISOString() });

  /* телеметрия сканеров: за цикл + сессия */
  state.scan = state.scan || {};
  const scanOut = [];
  for (const k of ['s1','s2','s3','s4','s5']){
    const s = SCAN[k];
    state.scan[k] = state.scan[k] || { req: 0, found: 0 };
    state.scan[k].req += s.req;
    state.scan[k].found += s.found;
    scanOut.push({
      id: s.id, name: s.name, title: s.title, ok: s.ok,
      req: s.req, found: s.found,
      req_total: state.scan[k].req, found_total: state.scan[k].found
    });
  }

  const lastUpg = state.recent.slice(0, 40).map(e => ({ slug: e.slug, gift: e.gift, number: e.number, counter_issued: e.number, mint: e.mint, art: e.art || null }));
  const upgPerHour = state.recent.filter(e => now - Number(e.mint||0) <= 3600).length;
  writeJSON(path.join(DOCS, 'status.json'), {
    updated: new Date(now*1000).toISOString(),
    updated_unix: now,
    detected_total: mintedTotal,
    upg_per_hour: upgPerHour,
    last_upgrades: lastUpg,
    scanners: scanOut,
    spikes: spikeList.slice(0, 10),
    sources: 'own-collector:5-scanners+s1-oracle',
    failed: failed
  });

  const liveItems = {};
  gifts.forEach(g => { liveItems[g.slug] = { i: g.issued, t: g.total, ts: now }; });
  writeJSON(path.join(DOCS, 'live.json'), { updated: new Date(now*1000).toISOString(), items: liveItems });

  const hist = readJSON(path.join(DOCS, 'history.json'), { hours: [] });
  const hourBucket = Math.floor(now / 3600);
  const issuedMap = {};
  gifts.forEach(g => issuedMap[g.slug] = g.issued);
  if (!hist.hours.length || hist.hours[hist.hours.length-1].h !== hourBucket){
    hist.hours.push({ h: hourBucket, ts: hourBucket*3600, issued: issuedMap });
    if (hist.hours.length > 24*30) hist.hours = hist.hours.slice(-24*30);
  } else {
    hist.hours[hist.hours.length-1].issued = issuedMap;
  }
  writeJSON(path.join(DOCS, 'history.json'), hist);
  writeJSON(FRAG_PATH, fragCache);

  /* BOOT-срез прямо в index.html */
  try {
    const idxPath = path.join(DOCS, 'index.html');
    let html = fs.readFileSync(idxPath, 'utf8');
    const boot = {
      ts: now,
      u: mintedTotal,
      g: gifts.map(g => [g.slug, g.name || g.slug, g.issued, g.total]),
      r: lastUpg.slice(0, 8),
      s: scanOut
    };
    const snap = '<!--SNAP-START--><script>window.BOOT=' + JSON.stringify(boot) + ';</script><!--SNAP-END-->';
    if (html.indexOf('<!--SNAP-START-->') >= 0){
      html = html.replace(/<!--SNAP-START-->[\s\S]*?<!--SNAP-END-->/, snap);
    } else {
      html = html.replace('<div id="app">', snap + '\n<div id="app">');
    }
    fs.writeFileSync(idxPath, html);
  } catch(e){ console.log('::warning::snapshot write failed: ' + e.message); }

  state.ts = now;
  state.v = 2;
  writeJSON(STATE_PATH, state);
  writeJSON(SAMPLES_PATH, samples);
  registry.forEach(c => { const slug = String(c.slug||c.name).trim(); if (result[slug] && result[slug].issued > c.total) c.total = result[slug].issued; });
  writeJSON(REG_PATH, registry);

  const sc = scanOut.map(s => s.id + '(' + s.req + 'req/' + s.found + ')').join(' ');
  console.log('MARK new=' + addedEvents + ' frag=' + fragFetched + ' fix=' + corrections + ' events_h=' + upgPerHour);
  console.log('cycle ok: ' + Object.keys(result).length + '/' + registry.length + ' cols, +' + addedEvents + ' new, minted=' + mintedTotal + ', spikes=' + spikeList.length + ', verify-fix=' + corrections + ', frag+' + fragFetched + ', scanners=[' + sc + '], failed=' + failed.length + ', ' + (Date.now()-t0) + 'ms');
})().catch(e => { console.log('::error::' + (e && e.message || e)); process.exit(1); });
