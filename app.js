const state = {
  batches: [],
  settings: { defaultF1: 7, defaultF2: 2 },
  queue: JSON.parse(localStorage.getItem('kb_sync_queue') || '[]'),
  deferredPrompt: null,
  syncing: false,
  dbReady: false,
  lastSyncAt: localStorage.getItem('kb_last_sync_at') || '',
};
const faces = ['😖','😕','😐','🙂','🤩'];
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'kb_local_state_v7';
const DB_NAME='kombucha-tracker'; const DB_VERSION=1; const DB_STATE='state'; const DB_QUEUE='queue';

function apiUrl(params) {
  const base = window.KOMBUCHA_CONFIG?.API_URL || '';
  if (!base || base.includes('PASTE_YOUR')) throw new Error('URL Apps Script non configurée dans config.js.');
  return `${base}?${new URLSearchParams(params)}`;
}

function jsonp(params, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const cb = `kb_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const s = document.createElement('script');
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      delete window[cb];
      s.remove();
      fn(value);
    };
    const t = setTimeout(() => finish(reject, new Error('Serveur indisponible pour le moment.')), timeoutMs);
    window[cb] = d => finish(resolve, d);
    s.onerror = () => finish(reject, new Error('Connexion impossible avec Google Sheets.'));
    params.callback = cb;
    s.src = apiUrl(params);
    document.head.appendChild(s);
  });
}

async function api(action, payload = {}) {
  const response = await jsonp({ action, payload: encodeURIComponent(JSON.stringify(payload)) });
  if (!response?.ok) throw new Error(response?.error || 'Erreur inconnue');
  return response.data;
}

let dbPromise;
function openDB(){if(!('indexedDB' in window))return Promise.resolve(null);if(dbPromise)return dbPromise;dbPromise=new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(DB_STATE))db.createObjectStore(DB_STATE);if(!db.objectStoreNames.contains(DB_QUEUE))db.createObjectStore(DB_QUEUE,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}).catch(()=>null);return dbPromise}
async function idbGet(store,key){const db=await openDB();if(!db)return null;return new Promise(res=>{const t=db.transaction(store,'readonly');const r=t.objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)})}
async function idbPut(store,value,key){const db=await openDB();if(!db)return;await new Promise(res=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put(value,key);t.oncomplete=res;t.onerror=res})}
async function idbReplaceQueue(q){const db=await openDB();if(!db)return;await new Promise(res=>{const t=db.transaction(DB_QUEUE,'readwrite');const os=t.objectStore(DB_QUEUE);os.clear();q.forEach(op=>os.put(op));t.oncomplete=res;t.onerror=res})}
async function hydrateFromIDB(){const saved=await idbGet(DB_STATE,'snapshot');const queued=await idbGet(DB_QUEUE,'all');if(saved&&Array.isArray(saved.batches)){state.batches=saved.batches;state.settings={...state.settings,...(saved.settings||{})}}if(Array.isArray(queued))state.queue=queued;state.dbReady=true;persist();$('defaultF1').value=state.settings.defaultF1;$('defaultF2').value=state.settings.defaultF2;render();ticks()}
function persistLocal(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify({batches:state.batches,settings:state.settings}));localStorage.setItem('kb_sync_queue',JSON.stringify(state.queue));if(state.lastSyncAt)localStorage.setItem('kb_last_sync_at',state.lastSyncAt)}catch(_){}}
function persist(){persistLocal();if(state.dbReady){idbPut(DB_STATE,{batches:state.batches,settings:state.settings},'snapshot');idbReplaceQueue(state.queue)}}
function loadLocal(){try{const raw=localStorage.getItem(STORAGE_KEY)||localStorage.getItem('kb_local_state_v6');if(!raw)return false;const saved=JSON.parse(raw);state.batches=Array.isArray(saved.batches)?saved.batches:[];state.settings={...state.settings,...(saved.settings||{})};return true}catch(_){return false}}
function toast(t, tone='info') {
  const e = $('toast');
  e.textContent = t;
  e.dataset.tone = tone;
  e.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => e.classList.remove('show'), 2800);
}

function banner(t, k='info') {
  const e = $('connectionBanner');
  e.textContent = t;
  e.className = `banner ${k}`;
}

function setSyncStatus(text, tone='info') { banner(text, tone); }

function esc(v='') {
  return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function duration(ms) {
  if (ms <= 0) return 'Terminé';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms / 3600000) % 24;
  const m = Math.floor(ms / 60000) % 60;
  return `${d}j ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m`;
}

function dataFor(b) {
  return b.phase === 'F2'
    ? { start: b.f2StartAt, end: b.f2EndAt, days: b.f2Days }
    : { start: b.f1StartAt, end: b.f1EndAt, days: b.f1Days };
}

function ringPct(start, end, done=false) {
  if (done) return 100;
  const s = new Date(start).getTime(), e = new Date(end).getTime(), now = Date.now();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.min(100, Math.max(0, ((now - s) / (e - s)) * 100));
}

function upsertLocal(batch) {
  const i = state.batches.findIndex(b => b.id === batch.id);
  if (i >= 0) state.batches[i] = batch;
  else state.batches.push(batch);
  persist();
  render();
  ticks();
}

function removeLocal(id) {
  state.batches = state.batches.filter(b => b.id !== id);
  persist();
  render();
}

function queueOp(action,payload){const op={id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,action,payload,attempts:0,nextAttemptAt:0,createdAt:Date.now()};state.queue.push(op);persist();updateSyncBanner();syncQueue({silent:true})}
function backoffMs(a){return Math.min(120000,Math.max(1500,2000*Math.pow(2,Math.min(a,6))))}
function updateSyncBanner(){if(!navigator.onLine)return setSyncStatus(`Hors connexion · ${state.queue.length} modification${state.queue.length>1?'s':''} en attente`,'warn');if(state.syncing)return setSyncStatus('Synchronisation en cours…','info');if(state.queue.length)return setSyncStatus(`${state.queue.length} modification${state.queue.length>1?'s':''} en attente`,'warn');if(state.lastSyncAt){const d=new Date(state.lastSyncAt);return setSyncStatus(`Synchronisé à ${d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}`,'ok')}setSyncStatus('Prêt','ok')}
async function syncQueue({silent=true}={}){if(state.syncing||!state.queue.length||!navigator.onLine||document.visibilityState==='hidden')return;state.syncing=true;updateSyncBanner();try{while(state.queue.length&&navigator.onLine){const op=state.queue[0];if(op.nextAttemptAt&&Date.now()<op.nextAttemptAt)break;try{const data=await api(op.action,op.payload);if(op.action==='saveSettings'&&data)state.settings={...state.settings,...data};state.queue.shift();persist()}catch(err){op.attempts=(op.attempts||0)+1;op.nextAttemptAt=Date.now()+backoffMs(op.attempts);persist();break}}if(!state.queue.length){await refreshFromServer({silent:true});state.lastSyncAt=new Date().toISOString();persist()}}finally{state.syncing=false;updateSyncBanner()}}
async function refreshFromServer({silent=true}={}){if(!navigator.onLine||state.queue.length||state.syncing)return false;try{const d=await api('list');state.batches=d.batches||[];state.settings=d.settings||state.settings;state.lastSyncAt=new Date().toISOString();persist();$('defaultF1').value=state.settings.defaultF1;$('defaultF2').value=state.settings.defaultF2;render();ticks();updateSyncBanner();return true}catch(_){updateSyncBanner();return false}}

function card(b, done) {
  const d = dataFor(b);
  const rating = Number(b.rating || 0);
  const left = Math.max(0, new Date(d.end) - Date.now());
  const daysLeft = Math.max(0, Math.floor(left / 86400000));
  const pct = ringPct(d.start, d.end, done);
  const phaseClass = b.phase === 'F2' ? 'f2' : 'f1';
  const tags = (b.phase === 'F1' ? [
    b.liters !== '' && b.liters != null ? `<span class="mini-tag"><strong>${esc(b.liters)}</strong> L</span>` : '',
    b.teaGrams !== '' && b.teaGrams != null ? `<span class="mini-tag">Thé <strong>${esc(b.teaGrams)}g</strong></span>` : '',
    b.sugarGrams !== '' && b.sugarGrams != null ? `<span class="mini-tag">Sucre <strong>${esc(b.sugarGrams)}g</strong></span>` : ''
  ] : [b.flavor ? `<span class="mini-tag">${esc(b.flavor)}</span>` : '']).filter(Boolean).join('');
  const actions = `<div class="card-actions">
    ${!done && b.phase === 'F1' ? `<button class="secondary-action" data-action="f2" data-id="${esc(b.id)}">Passer en F2</button>` : ''}
    <button class="icon-action edit-action" data-action="edit" data-id="${esc(b.id)}" aria-label="Modifier">✎</button>
    <button class="icon-action delete-action" data-action="delete" data-id="${esc(b.id)}" aria-label="Supprimer">🗑</button>
  </div>`;
  const ratingHtml = done ? `<div class="rating-row"><span class="countdown-text">Votre note</span><div class="rating-buttons">${faces.map((f,i)=>`<button class="rating-btn ${rating===i+1?'selected':''}" data-action="rate" data-rating="${i+1}" data-id="${esc(b.id)}">${f}</button>`).join('')}</div></div>` : '';
  const date = d.start ? new Date(d.start).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'}) : '—';
  return `<article class="batch-card ${done ? 'is-done' : ''}">
    <div class="batch-main">
      <div class="phase-pill ${phaseClass}">${esc(b.phase)}</div>
      <div class="batch-copy">
        <p class="card-name">${esc(b.name || 'Batch')}</p>
        <div class="card-date">Démarré le ${date}</div>
        <div class="card-meta">${tags || '<span class="muted-text">Aucun détail</span>'}</div>
      </div>
      <div class="timer-ring ${done ? 'timer-done' : ''}" style="--pct:${pct}%" data-end="${esc(d.end)}">
        <div class="timer-content"><div class="timer-days">${done ? '✓' : daysLeft}</div><div class="timer-small">${done ? 'terminé' : 'jours'}</div></div>
      </div>
    </div>
    <div class="card-subrow"><span class="countdown-text">${done ? 'Fermentation terminée' : `Encore ${duration(left)}`}</span>${actions}</div>
    ${b.f1Notes && b.phase === 'F1' ? `<p class="card-note">${esc(b.f1Notes)}</p>` : ''}
    ${b.f2Notes && b.phase === 'F2' ? `<p class="card-note">${esc(b.f2Notes)}</p>` : ''}
    ${ratingHtml}
  </article>`;
}

function render() {
  const active = state.batches.filter(b => b.status !== 'COMPLETED');
  const completed = state.batches.filter(b => b.status === 'COMPLETED').sort((a,b) => new Date(b.completedAt || b.f2EndAt) - new Date(a.completedAt || a.f2EndAt));
  $('activeList').innerHTML = active.length ? active.map(b => card(b,false)).join('') : $('emptyTemplate').innerHTML;
  $('completedList').innerHTML = completed.length ? completed.map(b => card(b,true)).join('') : `<div class="empty-state"><div class="empty-icon">🌿</div><strong>Pas encore d’historique</strong><span>Les batchs terminés apparaîtront ici.</span></div>`;
}

function ticks() {
  document.querySelectorAll('.timer-ring[data-end]').forEach(e => {
    const diff = new Date(e.dataset.end) - Date.now();
    const done = diff <= 0;
    e.classList.toggle('timer-done', done);
    const d = e.querySelector('.timer-days');
    const s = e.querySelector('.timer-small');
    if (done) { if (d) d.textContent = '✓'; if (s) s.textContent = 'terminé'; }
    else { if (d) d.textContent = Math.floor(diff / 86400000); if (s) s.textContent = 'jours'; }
    const cardEl = e.closest('.batch-card');
    const text = cardEl?.querySelector('.countdown-text');
    if (text && !cardEl.classList.contains('is-done')) text.textContent = diff > 0 ? `Encore ${duration(diff)}` : 'Fermentation terminée';
  });
}

function page(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page'));
  $(`page-${name}`).classList.add('active-page');
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.toggle('active', n.dataset.page === name));
}
function show(id){const el=$(id);el.classList.remove('hidden');el.setAttribute('aria-hidden','false');}
function hide(id){const el=$(id);el.classList.add('hidden');el.setAttribute('aria-hidden','true');}
function closeAllModals(){document.querySelectorAll('.modal').forEach(m=>hide(m.id));}

function autoBatchName() {
  const now = new Date();
  const stamp = now.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  return `Batch ${stamp}`;
}

function extensionPicker(targetId) {
  return `<div class="extend-picker"><span>Prolonger de</span><div class="extend-options" data-target="${targetId}">
    <button type="button" data-add="0" class="extend-btn active">0</button><button type="button" data-add="1" class="extend-btn">+1</button><button type="button" data-add="2" class="extend-btn">+2</button><button type="button" data-add="3" class="extend-btn">+3</button><button type="button" data-add="7" class="extend-btn">+7</button>
  </div><input id="${targetId}" type="hidden" value="0"></div>`;
}

function openAdd() {
  $('batchForm').reset();
  $('batchId').value = crypto.randomUUID ? crypto.randomUUID() : `tmp-${Date.now()}`;
  $('batchName').value = autoBatchName();
  $('batchF1Days').value = state.settings.defaultF1;
  $('batchExtendDays').value = 0;
  document.querySelectorAll('#batchForm .extend-btn').forEach(b=>b.classList.toggle('active', b.dataset.add==='0'));
  $('batchModalTitle').textContent = 'Nouveau batch';
  show('batchModal');
  setTimeout(()=>$('batchName').focus(),50);
}

function openF2(id) {
  const b = state.batches.find(x=>x.id===id); if(!b) return;
  $('f2Form').reset();
  $('f2BatchId').value = id;
  $('f2Days').value = state.settings.defaultF2;
  $('f2Flavor').value = '';
  $('f2Notes').value = '';
  $('f2ExtendDays').value = 0;
  document.querySelectorAll('#f2Form .extend-btn').forEach(x=>x.classList.toggle('active', x.dataset.add==='0'));
  $('f2ModalTitle').textContent = `F2 · ${b.name}`;
  show('f2Modal');
}

function openEdit(id) {
  const b = state.batches.find(x=>x.id===id); if(!b) return;
  const d = dataFor(b);
  $('editId').value=b.id; $('editPhase').value=b.phase; $('editName').value=b.name||''; $('editDays').value=d.days||1;
  $('editLiters').value=b.liters??''; $('editTeaGrams').value=b.teaGrams??''; $('editSugarGrams').value=b.sugarGrams??'';
  $('editFlavor').value=b.flavor||''; $('editNotes').value=b.phase==='F2'?(b.f2Notes||''):(b.f1Notes||''); $('editExtendDays').value=0;
  $('editFlavorWrap').style.display=b.phase==='F2'?'grid':'none'; $('editMaterialWrap').style.display=b.phase==='F2'?'none':'grid';
  document.querySelectorAll('#editForm .extend-btn').forEach(x=>x.classList.toggle('active', x.dataset.add==='0'));
  $('editModalTitle').textContent=`Modifier · ${b.name} · ${b.phase}`; show('editModal');
}

function buildOptimisticF1(payload) {
  const now = new Date().toISOString();
  const days = Number(payload.f1Days);
  const end = new Date(Date.now() + days*86400000).toISOString();
  return { id: payload.id, name: payload.name, phase:'F1', status:'ACTIVE', createdAt:now, f1Days:days, f1StartAt:now, f1EndAt:end, f1Notes:payload.f1Notes||'', f1Liters:payload.liters||'', f1TeaGrams:payload.teaGrams||'', f1SugarGrams:payload.sugarGrams||'', liters:payload.liters||'', teaGrams:payload.teaGrams||'', sugarGrams:payload.sugarGrams||'', f2Days:'',f2StartAt:'',f2EndAt:'',flavor:'',f2Notes:'' };
}

function optimisticStartF2(b, payload) {
  const now = new Date().toISOString();
  const days = Number(payload.f2Days) + Number(payload.extendDays||0);
  const end = new Date(Date.now() + days*86400000).toISOString();
  return { ...b, phase:'F2', status:'ACTIVE', f2Days:days, f2StartAt:now, f2EndAt:end, flavor:payload.flavor||'', f2Notes:payload.f2Notes||'' };
}

function optimisticUpdate(b, payload) {
  const next = {...b, name:payload.name};
  const phase = payload.phase === 'F2' ? 'F2' : 'F1';
  const d = dataFor(b);
  const start = d.start ? new Date(d.start).getTime() : Date.now();
  const baseDays = Number(payload.days);
  const add = Number(payload.extendDays||0);
  const end = new Date(start + (baseDays + add)*86400000).toISOString();
  if (phase==='F1') Object.assign(next,{f1Days:baseDays+add,f1EndAt:end,f1Notes:payload.notes||'',f1Liters:payload.liters||'',f1TeaGrams:payload.teaGrams||'',f1SugarGrams:payload.sugarGrams||'',liters:payload.liters||'',teaGrams:payload.teaGrams||'',sugarGrams:payload.sugarGrams||''});
  else Object.assign(next,{f2Days:baseDays+add,f2EndAt:end,f2Notes:payload.notes||'',liters:payload.liters||'',teaGrams:payload.teaGrams||'',sugarGrams:payload.sugarGrams||'',flavor:payload.flavor||''});
  return next;
}

$('addBtn').addEventListener('click', openAdd);
$('refreshBtn').addEventListener('click', async ()=>{ await syncQueue({silent:false}); await refreshFromServer({silent:false}); });
document.querySelectorAll('.nav-btn').forEach(b=>b.addEventListener('click',()=>page(b.dataset.page)));
document.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click', closeAllModals));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)hide(m.id)}));

document.addEventListener('click', async e=>{
  const ext = e.target.closest('.extend-btn');
  if (ext) {
    const wrap = ext.closest('.extend-options');
    wrap.querySelectorAll('.extend-btn').forEach(b=>b.classList.remove('active'));
    ext.classList.add('active');
    $(wrap.dataset.target).value = ext.dataset.add;
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action, id=el.dataset.id;
  if (a==='f2') return openF2(id);
  if (a==='edit') return openEdit(id);
  if (a==='delete') {
    const b=state.batches.find(x=>x.id===id); if(!b) return;
    if (!confirm(`Supprimer définitivement « ${b.name} » ?`)) return;
    removeLocal(id); queueOp('deleteBatch',{id}); toast('Batch supprimé de cet appareil. Synchronisation en cours.', 'warn'); return;
  }
  if (a==='rate') {
    const rating=Number(el.dataset.rating);
    const b=state.batches.find(x=>x.id===id); if(!b)return;
    upsertLocal({...b,rating,ratingEmoji:faces[rating-1]});
    queueOp('rate',{id,rating});
    toast('Note enregistrée.');
  }
});

$('batchForm').addEventListener('submit', async e=>{
  e.preventDefault(); const btn=e.submitter; btn.disabled=true;
  const payload={id:$('batchId').value,name:$('batchName').value.trim(),f1Days:Number($('batchF1Days').value),liters:Number($('batchLiters').value||0),teaGrams:Number($('batchTeaGrams').value||0),sugarGrams:Number($('batchSugarGrams').value||0),f1Notes:$('batchNotes').value.trim()};
  try { const b=buildOptimisticF1(payload); upsertLocal(b); queueOp('createF1',payload); hide('batchModal'); toast('Batch créé. Il sera synchronisé en arrière-plan.'); }
  catch(err){toast(err.message,'warn')} finally {btn.disabled=false;}
});

$('f2Form').addEventListener('submit', async e=>{
  e.preventDefault(); const btn=e.submitter; btn.disabled=true;
  const id=$('f2BatchId').value, b=state.batches.find(x=>x.id===id); if(!b){btn.disabled=false;return;}
  const payload={id,f2Days:Number($('f2Days').value),flavor:$('f2Flavor').value.trim(),f2Notes:$('f2Notes').value.trim(),extendDays:Number($('f2ExtendDays').value||0)};
  try { upsertLocal(optimisticStartF2(b,payload)); queueOp('startF2',payload); hide('f2Modal'); toast('F2 démarrée. Synchronisation en arrière-plan.'); }
  catch(err){toast(err.message,'warn')} finally{btn.disabled=false;}
});

$('editForm').addEventListener('submit', async e=>{
  e.preventDefault(); const btn=e.submitter; btn.disabled=true;
  const id=$('editId').value,b=state.batches.find(x=>x.id===id); if(!b){btn.disabled=false;return;}
  const payload={id,phase:$('editPhase').value,name:$('editName').value.trim(),days:Number($('editDays').value),liters:Number($('editLiters').value||0),teaGrams:Number($('editTeaGrams').value||0),sugarGrams:Number($('editSugarGrams').value||0),flavor:$('editFlavor').value.trim(),notes:$('editNotes').value.trim(),extendDays:Number($('editExtendDays').value||0)};
  try { upsertLocal(optimisticUpdate(b,payload)); queueOp('updateBatch',payload); hide('editModal'); toast('Modifications enregistrées localement.'); }
  catch(err){toast(err.message,'warn')} finally{btn.disabled=false;}
});

$('settingsForm').addEventListener('submit', async e=>{
  e.preventDefault();
  const defaultF1=Number($('defaultF1').value), defaultF2=Number($('defaultF2').value);
  state.settings={defaultF1,defaultF2}; persist();
  queueOp('saveSettings',{defaultF1,defaultF2}); toast('Paramètres enregistrés localement.');
});

window.addEventListener('online',()=>{ setSyncStatus('Connexion retrouvée · synchronisation…','info'); syncQueue({silent:false}); });
window.addEventListener('offline',()=>setSyncStatus('Mode local · hors connexion','warn'));
window.addEventListener('beforeunload',persist);

document.addEventListener('keydown', e=>{if(e.key==='Escape')closeAllModals()});

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredPrompt=e;$('installBtn').classList.remove('hidden')});
$('installBtn').addEventListener('click',async()=>{if(!state.deferredPrompt)return;state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null;$('installBtn').classList.add('hidden')});

if('serviceWorker' in navigator) window.addEventListener('load',async()=>{try{const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.update())); await navigator.serviceWorker.register('./sw.js?v=7')}catch(_){}});

loadLocal();
$('defaultF1').value=state.settings.defaultF1;$('defaultF2').value=state.settings.defaultF2;render();ticks();updateSyncBanner();
(async()=>{await hydrateFromIDB();if(navigator.onLine){await syncQueue({silent:true});await refreshFromServer({silent:true})}})();
setInterval(ticks,60000);
setInterval(()=>{if(document.visibilityState!=='hidden'){syncQueue({silent:true});if(!state.queue.length)refreshFromServer({silent:true})}},30000);
