#!/usr/bin/env node
"use strict";
/* ═══ RADAR COLLECTOR — собственный сборщик данных ═══
   Никаких чужих репозиториев и готовых данных: счётчики выпусков добываются
   напрямую у первоисточника (публичные страницы Telegram t.me/nft/<slug>-<N>).
   Алгоритм: оракул существования номера + инкрементальный экспоненциальный
   проход + бинарный поиск границы. После первого полного цикла каждый
   последующий берёт 1-4 запроса на коллекцию.

   Выход (всё своё, в нашем репо):
     docs/gifts.json    — коллекции: issued/total/rate
     docs/status.json   — обновлено, сумма апгрейдов, последние события
     docs/live.json     — живой оверлей для 5-сек тиков фронта
     docs/history.json  — часовые точки истории (для ETA фронта)
     docs/index.html    — BOOT-срез (вшитые данные: ноль запросов при первой отрисовке)
     collector/state.json, collector/samples.json — состояние и выборки скорости
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const REG_PATH = path.join(__dirname, 'registry.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const SAMPLES_PATH = path.join(__dirname, 'samples.json');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PROBE_TIMEOUT = 9000;
const POOL = 7;               // параллельные запросы к t.me
const SAMPLES_WINDOW = 48*3600; // храним выборки 48ч

function readJSON(p, dflt){ try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e){ return dflt; } }
function writeJSON(p, obj){ fs.writeFileSync(p, JSON.stringify(obj)); }

/* ─── оракул: существует ли NFT-номер у коллекции ─── */
const oracleCache = new Map();
async function exists(slug, n){
  const key = slug + '#' + n;
  if (oracleCache.has(key)) return oracleCache.get(key);
  for (let attempt = 0; attempt < 2; attempt++){
    try {
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
      return ok;
    } catch(e) {
      if (attempt === 1) throw new Error('oracle-net:' + slug + '#' + n); // сетевой сбой ≠ «номера нет»
      await new Promise(r => setTimeout(r, 700 + Math.random()*600));
    }
  }
}
async function safeExists(slug, n){
  try { return await exists(slug, n); } catch(e){ return null; } // null = неизвестно
}

/* ─── граница выпущенных номеров ─── */
async function issuedCount(slug, lastKnown, total){
  // полный поиск, если нет прошлой границы
  if (!lastKnown || lastKnown < 0){
    let lo = 0, hi = Math.max(2, total || 100);
    const zero = await safeExists(slug, 1);
    if (zero === null) return null;
    if (!zero) return 0;
    while (lo < hi){
      const mid = Math.ceil((lo + hi) / 2);
      const r = await safeExists(slug, mid);
      if (r === null) return null;
      if (r) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  if (total && lastKnown >= total) return lastKnown; // коллекция завершена
  // инкрементально: последний известный ещё жив?
  let first = await safeExists(slug, lastKnown + 1);
  if (first === null) return null;
  if (!first) return lastKnown;                     // ничего нового — 1 запрос
  // экспоненциальный проход вверх
  let step = 1, lo = lastKnown;
  const cap = Math.max((total || 0) + 16, lo + 4096);
  let hi = null;
  while (hi === null){
    const cand = Math.min(lo + step, cap);
    const r = await safeExists(slug, cand);
    if (r === null) return null;
    if (r){ lo = cand; step *= 2; if (cand >= cap) { hi = cap; break; } }
    else hi = cand;
  }
  // бинарный поиск точной границы в (lo, hi)
  while (hi - lo > 1){
    const mid = Math.floor((lo + hi) / 2);
    const r = await safeExists(slug, mid);
    if (r === null) return null;
    if (r) lo = mid; else hi = mid;
  }
  return lo;
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
      await new Promise(r => setTimeout(r, 40 + Math.random()*80)); // мягкий тротлинг
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
  const state = readJSON(STATE_PATH, { v: 1, ts: 0, c: {}, recent: [] });
  const samples = readJSON(SAMPLES_PATH, { v: 1, s: {} });
  const now = Math.floor(Date.now()/1000);
  const result = {};   // slug -> issued
  const failed = [];

  await pool(registry, POOL, async (col) => {
    const slug = String(col.slug || col.name).trim();
    const last = state.c[slug] ? state.c[slug].i : null;
    const i = await issuedCount(slug, last, col.total);
    if (i === null){ failed.push(slug); return; }
    result[slug] = { issued: i, isNew: (last === null || last === undefined) };
    if (last !== null && last !== undefined && i > last){
      result[slug].newRange = [last + 1, i];
      result[slug].last = last;
    }
  });

  const MIN_OK = Number(process.env.MIN_OK || 10);
  if (Object.keys(result).length < MIN_OK){
    // сеть/оракул почти полностью лежат — не портим данные, выходим без записи
    console.log('::error::oracle unusable, keep previous state (' + Object.keys(result).length + ' ok)');
    process.exit(1);
  }

  /* новые события */
  let addedEvents = 0;
  for (const slug in result){
    const r = result[slug];
    if (!r.newRange) continue;
    for (let n = r.newRange[0]; n <= r.newRange[1]; n++){
      state.recent.unshift({ slug: slug, gift: null, number: n, mint: now });
      addedEvents++;
    }
  }
  // имена подарков подставим из реестра
  const nameBySlug = {};
  registry.forEach(c => nameBySlug[String(c.slug||c.name).trim()] = c.name || c.slug);
  state.recent.forEach(e => { if (!e.gift) e.gift = nameBySlug[e.slug] || e.slug; });
  state.recent = state.recent.slice(0, 60);

  /* состояние коллекций */
  let mintedTotal = 0, finished = 0;
  const gifts = registry.map(c => {
    const slug = String(c.slug||c.name).trim();
    const r = result[slug] || { issued: state.c[slug] ? state.c[slug].i : 0 };
    const i = Math.max(0, r.issued);
    let total = c.total;
    if (r.issued > total) total = r.issued; // авто-починка реестра
    mintedTotal += i;
    if (total && i >= total) finished++;
    state.c[slug] = { i: i, ts: now };
    return { slug: slug, name: c.name || slug, issued: i, total: total, added: c.added || 0 };
  });

  /* выборки скорости */
  for (const g of gifts){
    const arr = samples.s[g.slug] || [];
    arr.push([now, g.issued]);
    const cut = now - SAMPLES_WINDOW;
    const kept = arr.filter(x => x[0] >= cut);
    samples.s[g.slug] = kept.length > 400 ? kept.slice(-400) : kept;
  }
  /* скорость/час: окно 3ч из выборок */
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

  const lastUpg = state.recent.slice(0, 40).map(e => ({ slug: e.slug, gift: e.gift, number: e.number, counter_issued: e.number, mint: e.mint }));
  writeJSON(path.join(DOCS, 'status.json'), {
    updated: new Date(now*1000).toISOString(),
    updated_unix: now,
    detected_total: mintedTotal,
    last_upgrades: lastUpg,
    sources: 'own-collector:t.me-oracle',
    failed: failed
  });

  const liveItems = {};
  gifts.forEach(g => { liveItems[g.slug] = { i: g.issued, t: g.total, ts: now }; });
  writeJSON(path.join(DOCS, 'live.json'), { updated: new Date(now*1000).toISOString(), items: liveItems });

  /* история: часовые точки (сжатие выборок) */
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

  /* BOOT-срез прямо в index.html: ноль запросов при первой отрисовке */
  try {
    const idxPath = path.join(DOCS, 'index.html');
    let html = fs.readFileSync(idxPath, 'utf8');
    const boot = {
      ts: now,
      u: mintedTotal,
      g: gifts.map(g => [g.slug, g.name || g.slug, g.issued, g.total]),
      r: lastUpg.slice(0, 8)
    };
    const snap = '<!--SNAP-START--><script>window.BOOT=' + JSON.stringify(boot) + ';</script><!--SNAP-END-->';
    if (html.indexOf('<!--SNAP-START-->') >= 0){
      html = html.replace(/<!--SNAP-START-->[\s\S]*?<!--SNAP-END-->/, snap);
    } else {
      html = html.replace('<div id="app">', snap + '\n<div id="app">');
    }
    fs.writeFileSync(idxPath, html);
  } catch(e){ console.log('::warning::snapshot write failed: ' + e.message); }

  /* состояние — в репо */
  state.ts = now;
  state.v = 1;
  writeJSON(STATE_PATH, state);
  writeJSON(SAMPLES_PATH, samples);
  /* реестр подчищаем под факт. итог */
  registry.forEach(c => { const slug = String(c.slug||c.name).trim(); if (result[slug] && result[slug].issued > c.total) c.total = result[slug].issued; });
  writeJSON(REG_PATH, registry);

  console.log('cycle ok: ' + Object.keys(result).length + '/' + registry.length + ' cols, +' + addedEvents + ' new, minted=' + mintedTotal + ', failed=' + failed.length + ', ' + (Date.now()-t0) + 'ms');
})().catch(e => { console.log('::error::' + (e && e.message || e)); process.exit(1); });
