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
const bdCache = new Map();  // slug#n -> Backdrop экземпляра, из ТОЙ ЖЕ страницы оракула (тот же запрос, что и детект — не может не быть)
function extractArt(body){
  const m = body.match(/property="og:image"\s+content="([^"]+)"/);
  return m ? m[1] : null;
}
function extractBackdrop(body){
  /* og:description: 'Model: X
Backdrop: Y
Symbol: Z' — берём значение Backdrop */
  const m = body.match(/Backdrop:\s*([^\n<"]+)/);
  return m ? m[1].trim() : null;
}
/* «Номера ещё нет» — НЕ вечный факт:gift может быть улучшен через секунду после
   пробы. Раньше отрицательный ответ кэшировался навсегда → апгрейд, случившийся
   сразу после пробы, не замечался до перезапуска воркера (до ~50 минут!) — это и
   были «перебои с номерами». Теперь: положительный ответ вечен (существование
   монотонно, номер один раз созданный существует всегда), отрицательный живёт
   NEG_TTL и по истечении перепроверяется свежим запросом. */
const NEG_TTL = 90 * 1000;
async function exists(slug, n, stat){
  const key = slug + '#' + n;
  const c = oracleCache.get(key);
  if (c !== undefined){
    if (c.v || Date.now() - c.ts <= NEG_TTL) return c.v;
    oracleCache.delete(key); // протухшее «нет» — перепроверяем по-настоящему
  }
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
      oracleCache.set(key, { v: ok, ts: Date.now() });
      if (ok){
        const art = extractArt(body); if (art) artCache.set(key, art);
        const bd = extractBackdrop(body); if (bd) bdCache.set(key, bd);
      }
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
  if (total && lastKnown >= total){
    /* Telegram иногда РАСШИРЯЕТ тираж закрытой коллекции — раньше такие новые
       апгрейды пропускались навсегда (сканер считал коллекцию законченной).
       Один дешёвый запрос за цикл: если №lastKnown+1 появился — падаем в общий
       путь ниже и бинаркой находим новую границу. Слепой зоны больше нет. */
    const nx = await safeExists(slug, lastKnown + 1, SCAN.s2);
    if (nx !== true) return lastKnown;
    console.log('supply_extended=' + slug + ' (#' + (lastKnown + 1) + ' за пределом тиража ' + total + ')');
  }

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

/* ═══ МГНОВЕННЫЙ ПУШ АПГРЕЙДОВ (как у Trackingonebot): карточка в чат через @lvlonebot ═══ */
async function tg(method, body){
  /* 429 от Telegram (всплеск >1 сообщения/сек в один чат) — раньше просто логировался
     и карточка терялась без повтора. Теперь уважаем retry_after и повторяем один раз —
     ни одна карточка не должна пропадать молча из-за кратковременного лимита. */
  for (let attempt = 0; attempt < 2; attempt++){
    const res = await fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const j = await res.json();
    if (j.ok || j.error_code !== 429 || attempt === 1) return j;
    const wait = (j.parameters && j.parameters.retry_after ? j.parameters.retry_after : 2) * 1000 + 150;
    console.log('::warning::429 от Telegram на ' + method + ', жду ' + wait + 'мс и повторяю');
    await new Promise(r => setTimeout(r, wait));
  }
}
/* Telegram не может сам скачать картинку по URL с cdn*.telesco.pe (failed to get HTTP URL
   content — у этих ссылок своя привязка к сессии оракула). Поэтому для фото качаем файл
   САМИ (тот же User-Agent, что и у оракула) и грузим его боту как multipart-вложение —
   так фото гарантированно приходит каждый раз, а не иногда через случайный linkpreview. */
async function fetchImageBytes(url){
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch(e){ return null; }
}
async function tgSendPhotoFile(chat, imgBuf, caption, kb){
  const boundary = '----gtp' + Date.now() + Math.random().toString(16).slice(2);
  const parts = [];
  const field = (name, val) => parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + val + '\r\n'));
  field('chat_id', chat);
  field('caption', caption);
  field('parse_mode', 'HTML');
  if (kb) field('reply_markup', JSON.stringify(kb));
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photo"; filename="art.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
  parts.push(imgBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const res = await fetch('https://api.telegram.org/bot' + process.env.BOT_TOKEN + '/sendPhoto', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body, signal: AbortSignal.timeout(15000)
  });
  return res.json();
}
/* ── АВТОЗАКРЕПКА ЧЁРНОГО ФОНА ──
   Для каждого нового улучшения читаем атрибуты экземпляра (t.me/nft/<slug>-<num>,
   поле Backdrop в og:description). Чёрный фон (Black, Onyx Black…) — редкость:
   карточка автоматически закрепляется сверху чата бота (предыдущая чёрная
   снимается — сверху всегда самая свежая, искать не нужно). */
const BLACK_BACKDROP_RE = /black/i;
async function getBackdrop(slug, num){
  /* Кэш — главный путь: Backdrop извлечён из ТОГО ЖЕ запроса, которым обнаружен
     апгрейд (exists() уже скачал страницу t.me/nft/<slug>-<n> и распарсил её).
     Значит для свежего апгрейда фон уже лежит в памяти — дочитывать нечего и
     падать нечему. Прямой запрос — только запасной путь с ретраями. */
  const key = slug + '#' + num;
  if (bdCache.has(key)) return bdCache.get(key);
  for (let attempt = 0; attempt < 3; attempt++){
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch('https://t.me/nft/' + String(slug).toLowerCase() + '-' + num, { headers: { 'User-Agent': UA }, signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('http ' + res.status);
      const html = await res.text();
      const bd = extractBackdrop(html);
      if (bd){ bdCache.set(key, bd); return bd; }
      return null; // страница прочитана, но Backdrop в ней нет — ретраи бессмысленны
    } catch(e){
      if (attempt === 2) return null;
      await new Promise(r => setTimeout(r, 500 + Math.random()*500));
    }
  }
  return null;
}
/* Пин создаёт служебное сообщение «X закрепил(а) ...» в чате — оно занимает ровно
   СЛЕДУЮЩИЙ message_id после закреплённого (проверено живым тестом: gap=2 между
   двумя соседними sendMessage, когда между ними был pinChatMessage). Удаляем его
   сразу же, пока в чат не успело прийти что-то ещё — остаётся только сама закрепка
   сверху чата, без мусорной строки внутри ленты. */
async function pinAndCleanServiceMsg(chat, mid){
  const p = await tg('pinChatMessage', { chat_id: chat, message_id: mid, disable_notification: true });
  if (p.ok){
    await new Promise(r => setTimeout(r, 350)); // дать Telegram время создать служебное сообщение
    await tg('deleteMessage', { chat_id: chat, message_id: mid + 1 }).catch(()=>{});
  }
  return p.ok;
}
/* ═══ АСИНХРОННЫЙ ПУШ: скан НИКОГДА не ждёт Telegram ═══
   Раньше pushUpgrades блокировал цикл: пока Telegram принимал карточки
   (лимит ~1/сек на чат + 429-ожидания по 3-8 сек), детект стоял. При урагане
   задержка росла снежным комом — бот «тормозил» именно в моменты всплесков.
   Теперь: события мгновенно падают в персистентную очередь state.pending
   (живёт в state.json, рестарт воркера ничего не теряет), скан продолжается
   на полной скорости, а drainPending в КОНЦЕ цикла рассылает очередь в темпе
   Telegram с честным бюджетом времени. Недоставленное остаётся в очереди и
   уходит первым же следующим циклом. Бот работает 24/7/365 без торможений. */
function enqueuePush(events, state){
  try {
    state.pending = state.pending || [];
    state.pushed = state.pushed || {};
    const pendingKeys = new Set(state.pending.map(e => e.slug + '#' + e.number));
    let added = 0;
    for (const e of events){
      const k = e.slug + '#' + e.number;
      if (state.pushed[k] || pendingKeys.has(k)) continue;
      state.pending.push({ slug: e.slug, gift: e.gift || null, number: e.number, art: e.art || null, bd: e.bd || null, bdChecked: !!e.bdChecked });
      pendingKeys.add(k);
      added++;
    }
    const keys = Object.keys(state.pushed);
    if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(k => delete state.pushed[k]);
    if (added) console.log('queued=' + added + ' (queue=' + state.pending.length + ')');
    /* канал-витрина: те же события в отдельную очередь канала */
    if (process.env.CHANNEL_ID){
      state.pendingChan = state.pendingChan || [];
      state.pushedChan = state.pushedChan || {};
      const pk2 = new Set(state.pendingChan.map(e => e.slug + '#' + e.number));
      for (const e of events){
        const k = e.slug + '#' + e.number;
        if (state.pushedChan[k] || pk2.has(k)) continue;
        state.pendingChan.push({ slug: e.slug, gift: e.gift || null, number: e.number, art: e.art || null, bd: e.bd || null, bdChecked: !!e.bdChecked });
        pk2.add(k);
      }
      const kc = Object.keys(state.pushedChan);
      if (kc.length > 600) kc.slice(0, kc.length - 600).forEach(k => delete state.pushedChan[k]);
    }
  } catch(e){ console.log('::warning::enqueue: ' + e.message); }
}

async function drainPending(state, budgetMs){
  if (!state.pending || !state.pending.length) return 0;
  const chat = process.env.TG_CHAT_ID || '8396883978';
  /* закреп чёрных живёт ТОЛЬКО в канале: снимаем старый закреп из бота, если остался */
  if (state.blackPin){
    await tg('unpinChatMessage', { chat_id: chat, message_id: state.blackPin }).catch(()=>{});
    delete state.blackPin;
    console.log('bot_pin_removed (закреп теперь только в канале)');
  }
  const deadline = Date.now() + budgetMs;
  state.pushed = state.pushed || {};
  let sent = 0, black = 0;
  {
    const me = await tg('getMe', {}).catch(e => ({ ok: false, description: 'net:' + e.message }));
    console.log('DIAG tg.getMe ok=' + me.ok + ' user=' + ((me.result && me.result.username) || me.description || '?'));
  }
  const SEND_GAP = 1100; /* ~1/сек на чат: НЕ дразним 429, вместо ретраев после */
  const markSent = e => {
    state.pushed[e.slug + '#' + e.number] = 1;
    const i = state.pending.findIndex(x => x.slug === e.slug && x.number === e.number);
    if (i >= 0) state.pending.splice(i, 1);
  };
  const sendOne = async (e) => {
    if (Date.now() >= deadline) return false;
    const nm = e.gift || e.slug;
    const em = emojiOf(e.slug, state);
    const nftUrl = 'https://t.me/nft/' + e.slug.toLowerCase() + '-' + e.number;
    const bd = e.bd;
    const isBlack = bd && BLACK_BACKDROP_RE.test(bd);
    let cap;
    if (isBlack){
      cap = '🖤 <b>ЧЁРНЫЙ ФОН</b>\n' + em + ' <b>' + esc_(nm) + '</b> #' + e.number +
        '\n⚡ улучшен\n🎨 Фон: ' + esc_(bd) + ' · <b>РЕДКИЙ</b>\n' + nftUrl;
    } else {
      cap = em + ' <b>' + esc_(nm) + '</b> #' + e.number + '\n⚡ улучшен';
      if (bd) cap += '\n🎨 Фон: ' + esc_(bd);
      cap += '\n' + nftUrl;
    }
    const kb = { inline_keyboard: [[{ text: 'NFT ↗', url: nftUrl }]] };
    const r = await tg('sendMessage', { chat_id: chat, text: cap, parse_mode: 'HTML', reply_markup: kb,
      link_preview_options: { url: nftUrl, prefer_large_media: true } });
    if (r.ok){ markSent(e); if (isBlack) black++; else sent++; }
    else console.log('::warning::sendMessage failed: ' + (r.description||'?'));
    await new Promise(r => setTimeout(r, SEND_GAP));
    return true;
  };
  try {
    /* ФАЗА 1: всё, у чего фон УЖЕ известен (bdChecked=true — захвачен в момент
       обнаружения, той же страницей, что нашла номер) — шлём немедленно, без
       единого доп. запроса. Чёрные — первыми, строго по возрастанию номера. */
    let ready = state.pending.filter(e => e.bdChecked);
    const isBlackE = e => e.bd && BLACK_BACKDROP_RE.test(e.bd);
    ready.sort((a,b) => (isBlackE(b) - isBlackE(a)) || (a.number - b.number));
    for (const e of ready){
      if (Date.now() >= deadline) break;
      await sendOne(e);
    }
    /* ФАЗА 2: остатком бюджета — fallback-проверка фона для старых элементов
       очереди без bdChecked (до этого фикса фон не сохранялся в очереди).
       Жёсткий потолок 6с: раньше без потолка такая проверка съедала ВЕСЬ
       бюджет и ни одна карточка не уходила (push=0 подтверждено логами 7
       циклов подряд). Теперь даже при полном сбое — максимум 6с простоя,
       остальное время уже потрачено на фазу 1 (свежие карточки идут всегда). */
    const stale = state.pending.filter(e => !e.bdChecked);
    if (stale.length && Date.now() < deadline){
      const batch = stale.slice(0, 15);
      const queue = batch.slice();
      const worker = async () => {
        while (queue.length){
          const e = queue.shift();
          e.bd = await getBackdrop(e.slug, e.number);
          e.bdChecked = true;
          await new Promise(r => setTimeout(r, 30));
        }
      };
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(6, batch.length) }, worker)),
        new Promise(r => setTimeout(r, 6000))
      ]);
      const resolved = batch.filter(e => e.bdChecked);
      resolved.sort((a,b) => (isBlackE(b) - isBlackE(a)) || (a.number - b.number));
      for (const e of resolved){
        if (Date.now() >= deadline) break;
        await sendOne(e);
      }
    }
    const left = state.pending.length;
    if (sent || black) console.log('push=' + (sent + black) + ' black=' + black + ' left=' + left);
    else if (left) console.log('push=0 left=' + left + ' (бюджет времени исчерпан — доотправит следующий цикл)');
  } catch(e){
    console.log('::warning::drain failed: ' + e.message);
  }
  return sent + black;
}
/* ─ КАНАЛ-ВИТРИНА: один пост доходит до ВСЕХ подписчиков канала за один вызов API
   (масштаб без потолка). Включается vars.CHANNEL_ID. Чёрные фоны закрепляются,
   шторм уходит сводками, дедуп отдельный (state.pushedChan), CTA-кнопка на бота. ─ */
async function drainChannel(state, budgetMs){
  const chan = String(process.env.CHANNEL_ID || '').trim();
  if (!chan || !state.pendingChan || !state.pendingChan.length) return 0;
  const deadline = Date.now() + budgetMs;
  state.pushedChan = state.pushedChan || {};
  let sent = 0, black = 0;
  const SEND_GAP = 1100;
  const markSent = e => {
    state.pushedChan[e.slug + '#' + e.number] = 1;
    const i = state.pendingChan.findIndex(x => x.slug === e.slug && x.number === e.number);
    if (i >= 0) state.pendingChan.splice(i, 1);
  };
  const sendOne = async (e) => {
    if (Date.now() >= deadline) return false;
    const nm = e.gift || e.slug;
    const em = emojiOf(e.slug, state);
    const nftUrl = 'https://t.me/nft/' + e.slug.toLowerCase() + '-' + e.number;
    const bd = e.bd;
    const isBlack = bd && BLACK_BACKDROP_RE.test(bd);
    let cap;
    if (isBlack){
      cap = '🖤 <b>ЧЁРНЫЙ ФОН</b>\n' + em + ' <b>' + esc_(nm) + '</b> #' + e.number +
        '\n⚡ улучшен\n🎨 Фон: ' + esc_(bd) + ' · <b>РЕДКИЙ</b>\n' + nftUrl;
    } else {
      cap = em + ' <b>' + esc_(nm) + '</b> #' + e.number + '\n⚡ улучшен';
      if (bd) cap += '\n🎨 Фон: ' + esc_(bd);
      cap += '\n' + nftUrl;
    }
    const kb = { inline_keyboard: [[{ text: 'NFT ↗', url: nftUrl }]] };
    const r = await tg('sendMessage', { chat_id: chan, text: cap, parse_mode: 'HTML', reply_markup: kb,
      link_preview_options: { url: nftUrl, prefer_large_media: true } });
    if (r.ok){ markSent(e); if (isBlack) black++; else sent++; }
    if (isBlack){
      const mid = r.ok && r.result ? r.result.message_id : null;
      if (mid){
        try {
          if (state.blackPinChan) await tg('unpinChatMessage', { chat_id: chan, message_id: state.blackPinChan }).catch(()=>{});
          const pinned = await pinAndCleanServiceMsg(chan, mid);
          if (pinned){ state.blackPinChan = mid; console.log('chan_pinned_black=' + e.slug + '#' + e.number); }
          else console.log('::warning::chan pin failed for ' + e.slug + '#' + e.number);
        } catch(e2){ console.log('::warning::chan pin failed: ' + e2.message); }
      }
    }
    await new Promise(r => setTimeout(r, SEND_GAP));
    return true;
  };
  try {
    /* ФАЗА 1: фон уже известен (bdChecked) — шлём немедленно, без запросов.
       Чёрные — первыми (закреп + авточистка служебной надписи), по возрастанию. */
    let ready = state.pendingChan.filter(e => e.bdChecked);
    const isBlackE = e => e.bd && BLACK_BACKDROP_RE.test(e.bd);
    ready.sort((a,b) => (isBlackE(b) - isBlackE(a)) || (a.number - b.number));
    for (const e of ready){
      if (Date.now() >= deadline) break;
      await sendOne(e);
    }
    /* ФАЗА 2: остатком бюджета — fallback для старых элементов без bdChecked,
       потолок 6с (см. комментарий в drainPending — тот же баг, тот же фикс). */
    const stale = state.pendingChan.filter(e => !e.bdChecked);
    if (stale.length && Date.now() < deadline){
      const batch = stale.slice(0, 15);
      const queue = batch.slice();
      const worker = async () => {
        while (queue.length){
          const e = queue.shift();
          e.bd = await getBackdrop(e.slug, e.number);
          e.bdChecked = true;
          await new Promise(r => setTimeout(r, 30));
        }
      };
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(6, batch.length) }, worker)),
        new Promise(r => setTimeout(r, 6000))
      ]);
      const resolved = batch.filter(e => e.bdChecked);
      resolved.sort((a,b) => (isBlackE(b) - isBlackE(a)) || (a.number - b.number));
      for (const e of resolved){
        if (Date.now() >= deadline) break;
        await sendOne(e);
      }
    }
    const left = state.pendingChan.length;
    if (sent || black) console.log('chan_push=' + (sent + black) + ' chan_black=' + black + ' chan_left=' + left);
  } catch(e){ console.log('::warning::drainChannel failed: ' + e.message); }
  return sent + black;
}
function esc_(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
/* премиум-стикер на коллекцию: один и тот же символ для одной коллекции всегда,
   разный для разных — чтобы узнавать коллекцию в ленте с одного взгляда, без чтения названия */
/* премиум-стикер на коллекцию: закрепляется за коллекцией НАВСЕГДА в state.json
   (emojiOfSlug: slug -> эмодзи). Новая коллекция берёт свободный эмодзи из пула —
   все 121+ коллекций получают РАЗНЫЕ стикеры, и у каждой свой навсегда. */
const EMOJI_POOL = ['🏮','💎','🔮','🌟','✨','🪄','👑','🎆','🧿','🔱','🫧','🪩','🎇','🌙','⚜️','🥇','🔥','🌌','🪬','💫','🎖️','🧨','🌠','🎐','🪅','🏆','🔆','🪞','🎊','🧊','🪆','🎏','🌃','🪔','🎉','💠','🍊','🕯️','🌷','🌺','🌻','🍀','🌿','🥀','🪷','💐','🌹','🦋','🐝','🐞','🦜','🦚','🦩','🕊️','🐇','🐿️','🦔','🐾','🐉','🐲','🦄','🐎','🦋',' 🐬','🐳','🦈','🦀','🐚','🪸','🐚','⚡','❄️','⛄','🌪️','🌊','💧','🫧','🌈','☀️','🌤️','⭐','🌠','☄️','🪐','🌌','🌠','🎧',' 🎼','🎹','🥁','🎺','🎸','🎻','♟️','🎯','🎲','🧩','🎴','🎭','🎪','🎡','🎢','🎠','⛱️','🎁','🎈','🎏','🎀','🛍️','👑',' 🥂','🍾','🍹','🍸','🍷','🍰','🎂','🧁','🍩','🍪','🍫','🍬','🍭','🍯','☕','🍵','🧊','🏺','⛩️','🏰','🏯','🗽','🗼',' 🗿','🛕','⚡','🔋','💡','🔦','📈','💰','🪙','💳','💹','💠','🔱','⚛️','🔬','🧬','🧪','🧲','🔭','📡','🛰️','🚀','🛸','🛎️','🗝️','🔑','🗝️','⚔️','🛡️','🏹','🔭','🧿'];
function emojiOf(slug, state){
  state.emojiSticker = state.emojiSticker || {};
  const s = String(slug).trim();
  if (state.emojiSticker[s]) return state.emojiSticker[s];
  const used = new Set(Object.values(state.emojiSticker));
  const pool = Array.from(new Set(EMOJI_POOL)).filter(e => e && !/\s/.test(e));
  const free = pool.filter(e => !used.has(e));
  let em;
  if (free.length){
    let h = 0; const str = s.toLowerCase();
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    em = free[h % free.length];
  } else {
    em = pool[(EMOJI_POOL.length + hOf(s)) % pool.length]; // пул кончился — редко, fallback
  }
  state.emojiSticker[s] = em;
  return em;
}
function hOf(s){ let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0; return h; }

/* ═══ DISCOVERY: автообнаружение новых коллекций с Fragment ═══
   Fragment /gifts первым показывает свежие коллекции; каждый полный цикл сверяем
   список с реестром. Новый слаг: (1) проверяем оракулом t.me/nft (первоисточник),
   (2) находим точный выпуск экспонентой+бинаркой, (3) добавляем в реестр,
   (4) тянем арт в собственное зеркало img/. Тираж Telegram объявляет отдельно —
   до этого total=0 и сайт показывает ∞. */
async function discoverCollections(registry, state, fragCache, now){
  if (process.env.HOT === '1') return;   /* только в полных проходах */
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch('https://fragment.com/gifts', { headers: { 'User-Agent': UA }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const html = await res.text();
    const blocks = html.match(/<a href="\/gifts\/([A-Za-z0-9]+)"[^>]*data-keywords="([^"]*)"/g) || [];
    const known = {};
    registry.forEach(c => { known[String(c.slug||c.name).trim().toLowerCase()] = 1; });
    let added = 0;
    for (const b of blocks){
      if (added >= 3) break;                      /* ≤3 новых за цикл — остальное потом */
      const m = b.match(/href="\/gifts\/([A-Za-z0-9]+)"/); if (!m) continue;
      const slugRaw = m[1];
      const km = b.match(/data-keywords="([^"]*)"/);
      const title = km ? km[1] : slugRaw;
      if (known[slugRaw.toLowerCase()]) continue;
      /* (1) оракул: номер #1 существует? нет — коллекция ещё не выпущена */
      const one = await safeExists(slugRaw, 1, SCAN.s1);
      if (!one) continue;
      /* (2) точный выпуск: экспонента вверх + бинарный поиск */
      let hi = 4;
      while (hi < 5e6){
        const r = await safeExists(slugRaw, hi, SCAN.s1);
        if (r !== true) break;
        hi *= 4;
      }
      let lo = 1;
      while (lo < hi){
        const mid = Math.ceil((lo + hi) / 2);
        const r = await safeExists(slugRaw, mid, SCAN.s1);
        if (r === null) break;
        if (r) lo = mid; else hi = mid - 1;
      }
      /* (3) в реестр; счётчик сразу точный — Phase 1 возьмёт дешёвый S2-путь */
      registry.push({ slug: slugRaw, name: title, total: 0 });
      known[slugRaw.toLowerCase()] = 1;
      state.c[slugRaw] = { i: lo, ts: now };
      fragCache[slugRaw] = { name: title, img: 'https://nft.fragment.com/collection/' + slugRaw.toLowerCase() + '.webp', ts: now };
      /* (4) арт в собственное зеркало (как остальные 121) */
      try {
        const ic = new AbortController();
        const it = setTimeout(() => ic.abort(), 10000);
        const ires = await fetch('https://fragment.com/file/gifts/' + slugRaw.toLowerCase() + '/thumb.webp', { headers: { 'User-Agent': UA }, signal: ic.signal });
        clearTimeout(it);
        if (ires.ok){
          const buf = Buffer.from(await ires.arrayBuffer());
          if (buf.length > 200 && buf.length < 60000){
            fs.writeFileSync(path.join(DOCS, 'img', slugRaw.toLowerCase() + '.webp'), buf);
          }
        }
      } catch(e){ /* арт не критичен: будет монограмма-фолбэк до след. попытки */ }
      console.log('discovered=' + slugRaw + '#' + lo + ' (total: неизвестен, ∞)');
      added++;
    }
  } catch(e){
    console.log('::warning::discovery failed: ' + e.message);
  }
}

/* ═══ main ═══ */
(async () => {
  const t0 = Date.now();
  const HOT = process.env.HOT === '1';
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

  /* горячий режим: только коллекции с событиями за последние 15 мин (до 12 шт) */
  const hotSlugs = [];
  if (HOT){
    const seen = {};
    for (const e of (state.recent||[])){
      if (!e) continue;
      if (now - Number(e.mint||0) <= 900 && !seen[e.slug]){ seen[e.slug] = 1; hotSlugs.push(e.slug); }
      if (hotSlugs.length >= 12) break;
    }
    if (!hotSlugs.length){ console.log('hot=0 new=0 frag=0 fix=0'); process.exit(0); }
    console.log('HOT lane: ' + hotSlugs.join(','));
  }
  const hotSet = new Set(hotSlugs);
  const scanList = HOT ? registry.filter(c => hotSet.has(String(c.slug||c.name).trim())) : registry;

  /* Фаза 0: автообнаружение новых коллекций (только полные проходы) */
  if (!HOT) await discoverCollections(registry, state, fragCache, now);

  /* Фаза 1: S2+S1 сканируют все коллекции */
  await pool(scanList, POOL, async (col) => {
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
  if (!HOT){ SCAN.s1.ok = true; SCAN.s2.ok = true; }

  const MIN_OK = HOT ? 1 : Number(process.env.MIN_OK || 10);
  if (Object.keys(result).length < MIN_OK){
    console.log('::error::oracle unusable, keep previous state (' + Object.keys(result).length + ' ok)');
    process.exit(1);
  }

  /* Фаза 2: S5 сторож аномалий (до записи событий) */
  const spikeList = HOT ? [] : scanSentinel(result, state, state.prevDeltas || {});

  /* Фаза 3: S3 контроль диапазонов + S4 перепроверка (в горячем режиме не нужны) */
  const hotRanges = HOT ? [] : await scanRangeCheck(result);
  const corrections = HOT ? [] : await scanVerify(result, registry);

  /* Фаза 4: Fragment-имена (доп. данные; в горячем режиме сеть не трогаем) */
  const fragFetched = HOT ? 0 : await fetchFragment(fragCache, registry, now);

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
      /* фон забираем ЗДЕСЬ, пока он горячий (та же страница, что обнаружила номер) —
         и кладём в сам объект события. Так он переживёт рестарт процесса и уйдёт
         в очередь уже готовым, без повторных HTTP-запросов на отправке. */
      state.recent.unshift({ slug: slug, gift: null, number: n, mint: now, art: artCache.get(artKey) || null, bd: bdCache.get(artKey) || null, bdChecked: true });
      addedEvents++;
    }
  }
  const nameBySlug = {};
  registry.forEach(c => nameBySlug[String(c.slug||c.name).trim()] = c.name || c.slug);
  state.recent.forEach(e => { if (!e.gift) e.gift = (fragCache[e.slug] && fragCache[e.slug].name) || nameBySlug[e.slug] || e.slug; });
  state.recent = state.recent.slice(0, 200);
  if (addedEvents > 0 && process.env.BOT_TOKEN){
    enqueuePush(state.recent.slice(0, addedEvents), state); /* в очередь мгновенно, скан не ждёт */
  }

  /* состояние коллекций (имена — из Fragment, если есть) */
  let mintedTotal = 0, finished = 0;
  const gifts = registry.map(c => {
    const slug = String(c.slug||c.name).trim();
    const r = result[slug] || { issued: state.c[slug] ? state.c[slug].i : 0 };
    const i = Math.max(0, r.issued);
    let total = c.total;
    if (!total) total = 0;                        /* тираж неизвестен — сайт покажет ∞ */
    else if (r.issued > total) total = r.issued;  /* Telegram расширил тираж */
    mintedTotal += i;
    if (total && i >= total) finished++;
    state.c[slug] = { i: i, ts: now };
    const fname = (fragCache[slug] && fragCache[slug].name) || null;
    return { slug: slug, name: fname || c.name || slug, issued: i, total: total, added: c.added || 0 };
  });

  /* выборки скорости */
  for (const g of gifts){
    if (HOT && !hotSet.has(g.slug)) continue;
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

  /* рассылка очереди — ПОСЛЕ скана: детект никогда не ждёт Telegram;
     бюджет: полный проход 45с, горячая полоса 20с, недоставленное — в очереди
     (персистится ниже в state.json) и уходит первым следующим циклом */
  /* лечение очереди: убираем дубли (две копии одного номера от пересечения
     воркеров при рестартах) и то, что уже было отправлено в прошлых циклах;
     из пары дублей оставляем копию с проверенным фоном (bdChecked) */
  const healQueue = (arr, pushed) => {
    if (!Array.isArray(arr) || !arr.length) return arr;
    const seen = new Map();
    for (const e of arr){
      const k = e.slug + '#' + e.number;
      if (pushed && pushed[k]) continue;
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, e);
      else if (!prev.bdChecked && e.bdChecked) seen.set(k, e);
    }
    return [...seen.values()];
  };
  if (state.pending) state.pending = healQueue(state.pending, state.pushed);
  if (state.pendingChan) state.pendingChan = healQueue(state.pendingChan, state.pushedChan);

  if (process.env.BOT_TOKEN && state.pending && state.pending.length){
    await drainPending(state, HOT ? 20000 : 45000);
    if (process.env.CHANNEL_ID) await drainChannel(state, HOT ? 15000 : 40000);
  }

  state.ts = now;
  state.v = 2;
  writeJSON(STATE_PATH, state);
  writeJSON(SAMPLES_PATH, samples);
  registry.forEach(c => { const slug = String(c.slug||c.name).trim(); if (c.total && result[slug] && result[slug].issued > c.total) c.total = result[slug].issued; });
  writeJSON(REG_PATH, registry);

  const sc = scanOut.map(s => s.id + '(' + s.req + 'req/' + s.found + ')').join(' ');
  console.log('MARK new=' + addedEvents + ' frag=' + fragFetched + ' fix=' + corrections + ' events_h=' + upgPerHour);
  console.log('cycle ok: ' + Object.keys(result).length + '/' + registry.length + ' cols, +' + addedEvents + ' new, minted=' + mintedTotal + ', spikes=' + spikeList.length + ', verify-fix=' + corrections + ', frag+' + fragFetched + ', scanners=[' + sc + '], failed=' + failed.length + ', ' + (Date.now()-t0) + 'ms');
})().catch(e => { console.log('::error::' + (e && e.message || e)); process.exit(1); });
