<script>
"use strict";
/* ═══ GIFT RADAR — собственная система уведомлений внутри мини-апа ═══
   Полностью свой контур: цели хранятся локально, вотчер работает на каждом тике данных
   (5 с), события дедуплицируются, уведомления показываются баннером + звуком (WebAudio,
   синтез, без файлов) + вибрацией Telegram. Плюс кнопка «в бот» — серверные пуши @lvlonebot. */
var NQ = { list: [], unread: 0, cfg: { sound: true, vibro: true, banners: true } };

function nqLoad(){
  try {
    var l = JSON.parse(localStorage.getItem('radar_nq') || '[]');
    if (Object.prototype.toString.call(l) === '[object Array]') NQ.list = l.slice(0, 60);
  } catch(e){}
  try {
    var c = JSON.parse(localStorage.getItem('radar_ncfg') || 'null');
    if (c) NQ.cfg = { sound: c.sound !== false, vibro: c.vibro !== false, banners: c.banners !== false };
  } catch(e){}
}
function nqSave(){
  try { localStorage.setItem('radar_nq', JSON.stringify(NQ.list.slice(0, 60))); } catch(e){}
  try { localStorage.setItem('radar_ncfg', JSON.stringify(NQ.cfg)); } catch(e){}
}
function nqAgo(ts){
  var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'сейчас';
  if (m < 60) return m + ' мин';
  return Math.round(m / 60) + ' ч';
}
function nqSound(kind){
  if (!NQ.cfg.sound) return;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = nqSound.ctx || (nqSound.ctx = new AC());
    if (ctx.state === 'suspended') ctx.resume();
    var t = ctx.currentTime;
    /* двухтональный синт-сигнал: до-мажорная терция, у «готово» — третий тон вверх */
    var freqs = kind === 'done' ? [523.25, 659.25, 783.99] : [523.25, 659.25];
    freqs.forEach(function(f, i){
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * .12);
      g.gain.exponentialRampToValueAtTime(.18, t + i * .12 + .02);
      g.gain.exponentialRampToValueAtTime(.0001, t + i * .12 + .28);
      o.connect(g); g.connect(ctx.destination);
      o.start(t + i * .12); o.stop(t + i * .12 + .3);
    });
  } catch(e){}
}
function nqVibro(){
  if (!NQ.cfg.vibro) return;
  try { if (tg && tg.HapticFeedback) { tg.HapticFeedback.notificationOccurred('success'); return; } } catch(e){}
  try { if (navigator.vibrate) navigator.vibrate([40, 60, 40]); } catch(e){}
}
function nqPush(type, ico, title, msg, slug, num){
  var n = { id: type + '-' + slug + '-' + num + '-' + Date.now(), type: type, ico: ico, title: title, msg: msg, slug: slug, num: num, ts: Date.now(), read: false };
  NQ.list.unshift(n);
  if (NQ.list.length > 60) NQ.list.length = 60;
  NQ.unread++;
  nqSave();
  nqBadge();
  nqRender();
  if (NQ.cfg.banners) nqBanner(n);
  nqSound(type === 'done' ? 'done' : 'near');
  nqVibro();
}
function nqBadge(){
  var b = document.getElementById('nbadge');
  if (!b) return;
  b.textContent = NQ.unread > 99 ? '99+' : (NQ.unread > 0 ? String(NQ.unread) : '');
  var bell = document.getElementById('btnBell');
  if (bell) bell.classList.toggle('on', NQ.unread > 0);
}
function nqBanner(n){
  var wrap = document.getElementById('nbanners');
  if (!wrap) return;
  var d = document.createElement('div');
  d.className = 'nban ' + n.type;
  d.innerHTML = '<div class="ico">' + n.ico + '</div><div class="bd"><div class="t">' + esc(n.title) + '</div><div class="m">' + esc(n.msg) + '</div></div>';
  d.addEventListener('click', function(){ d.remove(); if (n.slug) openColSheet(n.slug); });
  wrap.appendChild(d);
  setTimeout(function(){ d.classList.add('out'); setTimeout(function(){ d.remove(); }, 320); }, 5200);
}
function nqRender(){
  var list = document.getElementById('nlist');
  if (!list) return;
  if (!NQ.list.length){ list.innerHTML = '<div class="np-empty">Пока тихо на радаре.<br>Добавь цель — и следи за номером.</div>'; return; }
  list.innerHTML = NQ.list.map(function(n){
    return '<div class="ntf ' + n.type + (n.read ? '' : ' unread') + '" data-id="' + esc(n.id) + '">' +
      '<div class="ico">' + n.ico + '</div>' +
      '<div class="bd"><div class="t">' + esc(n.title) + '</div><div class="m">' + esc(n.msg) + '</div></div>' +
      '<div class="tm">' + nqAgo(n.ts) + '</div></div>';
  }).join('');
  Array.prototype.forEach.call(list.querySelectorAll('.ntf'), function(el){
    el.addEventListener('click', function(){
      var n = null;
      for (var i = 0; i < NQ.list.length; i++) if (NQ.list[i].id === el.getAttribute('data-id')) { n = NQ.list[i]; break; }
      if (!n) return;
      n.read = true; nqSave();
      var el2 = el; el2.classList.remove('unread');
      if (n.slug) { nqPanelClose(); openColSheet(n.slug); }
      nqBadge();
    });
  });
}
function nqPanelToggle(){
  var p = document.getElementById('npanel');
  if (!p) return;
  var on = p.classList.toggle('on');
  haptic();
  if (on){
    NQ.list.forEach(function(n){ n.read = true; });
    NQ.unread = 0; nqSave(); nqBadge(); nqRender();
  }
}
function nqPanelClose(){ var p = document.getElementById('npanel'); if (p) p.classList.remove('on'); }
function nqClear(){
  NQ.list = []; NQ.unread = 0; nqSave(); nqBadge(); nqRender(); haptic();
}

/* ═══ ЦЕЛИ (таргеты) — свой локальный вотчер ═══ */
function tgtLoad(){
  try { return JSON.parse(localStorage.getItem('radar_targets') || '[]') || []; } catch(e){ return []; }
}
function tgtSave(list){ try { localStorage.setItem('radar_targets', JSON.stringify(list)); } catch(e){} }
function tgtState(dist){
  if (dist <= 0) return 'done';
  if (dist <= 3) return 'hot';
  if (dist <= 10) return 'near';
  return 'watch';
}
function tgtStateRu(st){
  return st === 'done' ? 'ГОТОВО' : st === 'hot' ? 'ГОРИТ' : st === 'near' ? 'БЛИЗКО' : 'СЛЕДИМ';
}
/* вотчер: вызывается на каждом тике данных. сравнивает issued с целями,
   дедуп по смене состояния (одна цель = максимум 1 уведомление на переход) */
function watcherTick(){
  var list = tgtLoad();
  if (!list.length) return;
  var changed = false;
  list.forEach(function(t){
    var g = null;
    for (var i = 0; i < giftsData.length; i++){
      if (String(giftsData[i].slug || giftsData[i].name).trim() === t.slug) { g = giftsData[i]; break; }
    }
    if (!g) return;
    var issued = Number(g.issued) || 0;
    var dist = Number(t.num) - issued;
    var st = tgtState(dist);
    if (t.st !== st){
      /* оповещаем только о переходе ВПЕРЁД (watch→near→hot→done); возвраты назад тихо фиксируем */
      var order = { watch: 0, near: 1, hot: 2, done: 3 };
      if (t.st && order[st] > order[t.st]){
        var nm = g.name || t.slug;
        if (st === 'near') nqPush('near', '⏰', 'БЛИЗКО: ' + nm, 'До №' + fmtNum(t.num) + ' осталось ' + dist + ' · сейчас №' + fmtNum(issued), t.slug, t.num);
        else if (st === 'hot') nqPush('hot', '🔥', 'ГОРИТ: ' + nm, 'Номер ' + fmtNum(t.num) + ' почти рядом — готовь апгрейд (сейчас №' + fmtNum(issued) + ')', t.slug, t.num);
        else if (st === 'done') nqPush('done', '🎯', 'ЦЕЛЬ ДОСТИГНУТА: ' + nm, 'Номер ' + fmtNum(t.num) + ' выпущен! Пора апгрейдить', t.slug, t.num);
      }
      t.st = st; t.i = issued; changed = true;
    } else if (t.i !== issued) { t.i = issued; changed = true; }
  });
  if (changed) { tgtSave(list); if (typeof renderTargets === 'function' && document.getElementById('tgtList')) renderTargets(); }
}
function renderTargets(){
  var el = document.getElementById('tgtList');
  if (!el) return;
  var list = tgtLoad();
  if (!list.length){ el.innerHTML = '<div class="np-empty" style="padding:16px 8px">Целей нет. Введи название коллекции и номер — радар начнёт следить сам.</div>'; return; }
  el.innerHTML = list.map(function(t, idx){
    var g = null;
    for (var i = 0; i < giftsData.length; i++){ if (String(giftsData[i].slug || giftsData[i].name).trim() === t.slug) { g = giftsData[i]; break; } }
    var issued = g ? (Number(g.issued) || 0) : Number(t.i) || 0;
    var st = t.st || tgtState(Number(t.num) - issued);
    var nm = g ? g.name : t.slug;
    return '<div class="tgt">' +
      '<img class="ph" loading="lazy" src="' + esc(IMG_MIRROR + t.slug + '.webp') + '" onerror="this.outerHTML=\'<div class=&quot;ph&quot;>🎁</div>\'">' +
      '<div class="bd"><div class="l1" style="font-size:13.5px">' + esc(nm) + ' <span class="num">#' + fmtNum(t.num) + '</span></div>' +
      '<div class="l2">выпущено №' + fmtNum(issued) + (t.stars ? ' · ≤' + t.stars + '★' : '') + '</div></div>' +
      '<span class="st ' + st + '">' + tgtStateRu(st) + '</span>' +
      (st !== 'done' ? '<button class="botlnk" data-t="' + idx + '">⚡ в бот</button>' : '') +
      '<button class="del" data-d="' + idx + '">✕</button></div>';
  }).join('');
  Array.prototype.forEach.call(el.querySelectorAll('.del'), function(b){
    b.addEventListener('click', function(){
      var l = tgtLoad(); l.splice(Number(b.getAttribute('data-d')), 1); tgtSave(l); renderTargets(); haptic();
    });
  });
  Array.prototype.forEach.call(el.querySelectorAll('.botlnk'), function(b){
    b.addEventListener('click', function(){
      var l = tgtLoad(); var t = l[Number(b.getAttribute('data-t'))]; if (!t) return;
      var link = 'https://t.me/lvlonebot?start=add_' + encodeURIComponent(t.slug) + '_' + t.num + (t.stars ? '_' + t.stars : '');
      openLink(link);
    });
  });
}
function tgtAdd(){
  var nameEl = document.getElementById('tgtName'), numEl = document.getElementById('tgtNum'), stEl = document.getElementById('tgtStars');
  if (!nameEl || !numEl) return;
  var name = String(nameEl.value || '').trim().toLowerCase();
  var num = parseInt(numEl.value, 10);
  var stars = stEl ? parseInt(stEl.value, 10) : 0;
  if (!name || !num || num < 1){ toast('Введи название и номер цели'); return; }
  var g = null;
  for (var i = 0; i < giftsData.length; i++){
    var s = String(giftsData[i].slug || giftsData[i].name || '').trim().toLowerCase();
    if (s === name || String(giftsData[i].name || '').toLowerCase() === name) { g = giftsData[i]; break; }
  }
  if (!g){ toast('Коллекция «' + name + '» не найдена'); return; }
  var slug = String(g.slug || g.name).trim();
  var list = tgtLoad();
  for (var j = 0; j < list.length; j++){
    if (list[j].slug === slug && list[j].num === num){ toast('Такая цель уже есть'); return; }
  }
  var issued = Number(g.issued) || 0;
  list.push({ slug: slug, num: num, stars: stars || 0, st: tgtState(num - issued), i: issued, ts: Date.now() });
  tgtSave(list);
  nameEl.value = ''; numEl.value = ''; if (stEl) stEl.value = '';
  renderTargets(); haptic();
  var st0 = tgtState(num - issued);
  toast(st0 === 'done' ? 'Цель уже выпущена — апгрейдай!' : 'Радар следит за №' + fmtNum(num));
}
/* лента апгрейдов по целям: событие «апгрейд пойман» тоже кладём в центр уведомлений */
var watchUpgrades_seen = null;
function watchUpgrades(){
  if (!feedEvents.length) return;
  if (!watchUpgrades_seen){
    watchUpgrades_seen = {};
    feedEvents.forEach(function(e){
      var key = String(e.slug || '').trim() + '#' + (e.number || e.counter_issued);
      watchUpgrades_seen[key] = 1;
    });
    return;
  }
  var fresh = feedEvents.filter(function(e){
    var key = String(e.slug || '').trim() + '#' + (e.number || e.counter_issued);
    return !watchUpgrades_seen[key];
  });
  fresh.forEach(function(e){
    var key = String(e.slug || '').trim() + '#' + (e.number || e.counter_issued);
    watchUpgrades_seen[key] = 1;
    if (isFav(String(e.slug || '').trim())){
      nqPush('upg', '🚀', 'Апгрейд: ' + (e.gift || e.slug), 'Номер #' + fmtNum(e.number || e.counter_issued) + ' улучшен до NFT', String(e.slug || '').trim(), Number(e.number || e.counter_issued));
    }
  });
}
nqLoad();
</script>
