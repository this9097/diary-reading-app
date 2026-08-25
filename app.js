/* ===================================================================
   기록장 — 일기 · 독서노트 PWA
   심상현
   =================================================================== */
'use strict';

const LS_ENTRIES  = 'rb_entries_v1';
const LS_SETTINGS = 'rb_settings_v1';
const LS_PIN      = 'rb_pin_v1';
const LS_FP_CRED  = 'rb_fpcred_v1';

let state = {
  entries: [],
  settings: { theme: 'paper', syncCode: '', firebaseConfig: null, fpEnabled: false },
  activeTab: 'diary',
  search: '',
  editingId: null,
  editingType: null,
  rating: 0,
  unlocked: false,
  pinBuffer: '',
};

let fbApp = null, fbDb = null, unsub = null;
const pendingLocalPush = new Map(); // id -> updatedAt, to ignore our own echo

/* ---------------- utils ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const todayISO = () => new Date().toISOString().slice(0, 10);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2200);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function loadLocal() {
  try { state.entries = JSON.parse(localStorage.getItem(LS_ENTRIES)) || []; } catch { state.entries = []; }
  try { state.settings = Object.assign(state.settings, JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}); } catch {}
}
function saveEntriesLocal() { localStorage.setItem(LS_ENTRIES, JSON.stringify(state.entries)); }
function saveSettingsLocal() { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); }

/* ---------------- theme ---------------- */
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name === 'paper' ? '' : name);
  $$('.swatch').forEach(s => s.classList.toggle('active', s.dataset.theme === name));
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
}

/* =====================================================================
   LOCK SCREEN (PIN + WebAuthn biometric)
   ===================================================================== */
function b64uToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function webauthnAvailable() {
  return !!(window.PublicKeyCredential &&
    (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false)));
}

async function registerBiometric() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: '기록장' },
        user: { id: userId, name: '상현님', displayName: '상현님' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
      }
    });
    localStorage.setItem(LS_FP_CRED, bufToB64u(cred.rawId));
    return true;
  } catch (e) {
    console.error('biometric register failed', e);
    return false;
  }
}

async function verifyBiometric() {
  const credId = localStorage.getItem(LS_FP_CRED);
  if (!credId) return false;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: b64uToBuf(credId), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      }
    });
    return true;
  } catch (e) {
    console.warn('biometric verify failed/cancelled', e);
    return false;
  }
}

function pinDotsRender() {
  $$('#pinDots span').forEach((el, i) => el.classList.toggle('filled', i < state.pinBuffer.length));
}

async function handlePinComplete() {
  const storedHash = localStorage.getItem(LS_PIN);
  const enteredHash = await sha256(state.pinBuffer);
  if (!storedHash) {
    // first-time setup
    localStorage.setItem(LS_PIN, enteredHash);
    $('#lockErr').textContent = '';
    unlockApp();
    return;
  }
  if (enteredHash === storedHash) {
    $('#lockErr').textContent = '';
    unlockApp();
  } else {
    $('#lockErr').textContent = '번호가 일치하지 않습니다';
    state.pinBuffer = '';
    pinDotsRender();
    navigator.vibrate?.(80);
  }
}

function initLock() {
  const storedHash = localStorage.getItem(LS_PIN);
  $('#lockSetupNote').textContent = storedHash ? '' : '처음 오셨네요. 사용할 6자리 번호를 입력해 등록해주세요.';

  $$('#pinPad button').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k;
      if (k === 'clear') { state.pinBuffer = ''; }
      else if (k === 'back') { state.pinBuffer = state.pinBuffer.slice(0, -1); }
      else if (state.pinBuffer.length < 6) { state.pinBuffer += k; }
      pinDotsRender();
      if (state.pinBuffer.length === 6) setTimeout(handlePinComplete, 120);
    });
  });

  // 물리 키보드로도 PIN 입력 가능하게 (숫자 0-9, Backspace, Escape로 지우기)
  document.addEventListener('keydown', (ev) => {
    if (state.unlocked) return;
    if (ev.key >= '0' && ev.key <= '9') {
      if (state.pinBuffer.length < 6) state.pinBuffer += ev.key;
      pinDotsRender();
      if (state.pinBuffer.length === 6) setTimeout(handlePinComplete, 120);
    } else if (ev.key === 'Backspace') {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      pinDotsRender();
    } else if (ev.key === 'Escape' || ev.key === 'Delete') {
      state.pinBuffer = '';
      pinDotsRender();
    }
  });

  webauthnAvailable().then(async avail => {
    if (avail && state.settings.fpEnabled && localStorage.getItem(LS_FP_CRED)) {
      $('#fpBtn').style.display = 'inline-flex';
      $('#fpBtn').onclick = async () => {
        const ok = await verifyBiometric();
        if (ok) unlockApp();
        else $('#lockErr').textContent = '지문 인식에 실패했습니다. PIN을 입력해주세요.';
      };
      // auto-prompt once on load
      setTimeout(async () => {
        const ok = await verifyBiometric();
        if (ok) unlockApp();
      }, 400);
    }
  });
}

function unlockApp() {
  state.unlocked = true;
  $('#lock').style.display = 'none';
  $('#app').classList.add('show');
  renderAll();
}

/* =====================================================================
   FIREBASE SYNC
   ===================================================================== */
function syncDotSet(status) {
  const dot = $('#syncDot');
  const ind = $('#syncIndicator');
  if (!dot) return;
  dot.classList.remove('on', 'err');
  if (status === 'on') { dot.classList.add('on'); ind.title = '동기화 연결됨'; }
  else if (status === 'err') { dot.classList.add('err'); ind.title = '동기화 오류'; }
  else { ind.title = '동기화 꺼짐'; }
}

function initFirebaseSync() {
  if (!state.settings.firebaseConfig || !state.settings.syncCode) { syncDotSet('off'); return; }
  try {
    if (!fbApp) {
      fbApp = firebase.initializeApp(state.settings.firebaseConfig);
    }
    const auth = firebase.auth();
    auth.signInAnonymously().catch(err => { console.error(err); syncDotSet('err'); });
    fbDb = firebase.firestore();

    if (unsub) unsub();
    const col = fbDb.collection('recordbook').doc(state.settings.syncCode).collection('entries');
    unsub = col.onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const remote = change.doc.data();
        const id = change.doc.id;
        const pendingTs = pendingLocalPush.get(id);
        if (pendingTs && pendingTs >= (remote.updatedAt || 0)) {
          // this is our own echo, ignore
          return;
        }
        pendingLocalPush.delete(id);
        if (change.type === 'removed') {
          state.entries = state.entries.filter(e => e.id !== id);
        } else {
          const idx = state.entries.findIndex(e => e.id === id);
          const entry = Object.assign({ id }, remote);
          if (idx === -1) state.entries.push(entry);
          else if ((entry.updatedAt || 0) >= (state.entries[idx].updatedAt || 0)) state.entries[idx] = entry;
        }
      });
      saveEntriesLocal();
      renderAll();
      syncDotSet('on');
    }, err => { console.error('sync error', err); syncDotSet('err'); });

    syncDotSet('on');
  } catch (e) {
    console.error('firebase init failed', e);
    syncDotSet('err');
  }
}

function pushEntryToCloud(entry) {
  if (!fbDb || !state.settings.syncCode) return;
  pendingLocalPush.set(entry.id, entry.updatedAt);
  fbDb.collection('recordbook').doc(state.settings.syncCode).collection('entries').doc(entry.id)
    .set(entry).catch(err => { console.error(err); syncDotSet('err'); });
}
function deleteEntryFromCloud(id) {
  if (!fbDb || !state.settings.syncCode) return;
  pendingLocalPush.set(id, Date.now());
  fbDb.collection('recordbook').doc(state.settings.syncCode).collection('entries').doc(id)
    .delete().catch(err => console.error(err));
}

/* =====================================================================
   ENTRY CRUD
   ===================================================================== */
function upsertEntry(entry) {
  entry.updatedAt = Date.now();
  const idx = state.entries.findIndex(e => e.id === entry.id);
  if (idx === -1) { entry.createdAt = entry.updatedAt; state.entries.push(entry); }
  else state.entries[idx] = entry;
  saveEntriesLocal();
  pushEntryToCloud(entry);
  renderAll();
}
function deleteEntry(id) {
  state.entries = state.entries.filter(e => e.id !== id);
  saveEntriesLocal();
  deleteEntryFromCloud(id);
  renderAll();
}

/* =====================================================================
   RENDER
   ===================================================================== */
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} (${days[d.getDay()]})`;
}
function monthLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}
function starsStr(n) { return '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n); }

function highlight(text, q) {
  const safe = escapeHtml(text || '');
  if (!q) return safe;
  const esc = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(esc, 'gi'), (m) => `<mark>${m}</mark>`);
}
function snippetAround(body, q, radius) {
  const text = body || '';
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function buildCopyText(e) {
  if (e.type === 'reading') {
    let s = `📖 ${e.title || '(제목 없음)'}`;
    if (e.author) s += ` — ${e.author}`;
    s += `\n${fmtDate(e.date)}`;
    if (e.rating) s += `\n평점: ${starsStr(e.rating)}`;
    s += `\n\n${e.body || ''}`;
    if (e.tags?.length) s += `\n\n${e.tags.map(t => '#' + t).join(' ')}`;
    return s;
  }
  let s = `📅 ${fmtDate(e.date)}`;
  if (e.title) s += `\n${e.title}`;
  s += `\n\n${e.body || ''}`;
  if (e.tags?.length) s += `\n\n${e.tags.map(t => '#' + t).join(' ')}`;
  return s;
}

async function copyEntry(e) {
  const text = buildCopyText(e);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }
  toast('블로그용 텍스트가 복사되었습니다');
}

function renderAll() {
  if (!state.unlocked) return;
  $$('.ribbon').forEach(r => r.dataset.active = String(r.dataset.tab === state.activeTab));
  document.documentElement.style.setProperty('--accent', `var(--${state.activeTab === 'diary' ? 'diary' : 'reading'})`);
  document.documentElement.style.setProperty('--accent-soft', `var(--${state.activeTab === 'diary' ? 'diary' : 'reading'}-soft)`);

  const list = $('#entryList');
  const q = state.search.trim();
  const searching = q.length > 0;
  const ql = q.toLowerCase();

  // While searching, look across BOTH 일기 and 독서노트; otherwise stick to the active tab.
  let items = searching ? state.entries.slice() : state.entries.filter(e => e.type === state.activeTab);
  if (searching) {
    items = items.filter(e =>
      (e.title || '').toLowerCase().includes(ql) ||
      (e.body || '').toLowerCase().includes(ql) ||
      (e.author || '').toLowerCase().includes(ql) ||
      (e.tags || []).some(t => t.toLowerCase().includes(ql))
    );
  }
  items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);

  $('#searchClear').style.display = searching ? 'flex' : 'none';
  const info = $('#searchInfo');
  if (searching) {
    info.style.display = 'block';
    info.textContent = items.length ? `"${q}" 검색결과 ${items.length}건 (일기·독서노트 전체)` : `"${q}" 검색결과 없음`;
  } else {
    info.style.display = 'none';
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
      <p>${searching ? '검색 결과가 없습니다' : (state.activeTab === 'diary' ? '아직 쓴 일기가 없습니다.\n오늘 하루는 어떠셨나요?' : '아직 기록한 책이 없습니다.\n최근 읽은 책을 남겨보세요.')}</p>
    </div>`;
    return;
  }

  let html = '';
  let lastMonth = '';
  for (const e of items) {
    const m = monthLabel(e.date);
    if (m !== lastMonth) { html += `<div class="month-divider">${m}</div>`; lastMonth = m; }
    const bodyText = searching ? snippetAround(e.body, q, 40) : (e.body || '');
    html += `<div class="card" data-id="${e.id}" style="border-top-color:var(--${e.type === 'diary' ? 'diary' : 'reading'})">
      <div class="card-head">
        <div>
          <div class="card-date">${fmtDate(e.date)}</div>
          ${e.title ? `<div class="card-title">${highlight(e.title, searching ? q : '')}</div>` : ''}
        </div>
        ${searching ? `<span class="type-badge ${e.type}">${e.type === 'diary' ? '일기' : '독서노트'}</span>` : ''}
      </div>
      ${e.type === 'reading' ? `<div class="card-meta">${e.author ? highlight(e.author, searching ? q : '') : ''}${e.rating ? ` · <span class="stars">${starsStr(e.rating)}</span>` : ''}</div>` : ''}
      <div class="card-body">${highlight(bodyText, searching ? q : '')}</div>
      <div class="card-foot">
        <button class="chip copy-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>블로그 복사</button>
        <button class="chip edit-btn">수정</button>
        ${(e.tags || []).map(t => `<span class="chip">#${highlight(t, searching ? q : '')}</span>`).join('')}
      </div>
    </div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.card-body').forEach(body => {
    body.addEventListener('click', () => body.classList.toggle('expanded'));
  });
  list.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.closest('.card').dataset.id;
      copyEntry(state.entries.find(e => e.id === id));
    });
  });
  list.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.closest('.card').dataset.id;
      openEditor(state.entries.find(e => e.id === id));
    });
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* =====================================================================
   EDITOR
   ===================================================================== */
function openEditor(entry) {
  const editType = entry ? entry.type : state.activeTab;
  const isReading = editType === 'reading';
  state.editingId = entry ? entry.id : null;
  state.editingType = editType;
  $('#editorTitle').textContent = entry ? '기록 수정' : (isReading ? '새 독서노트' : '오늘의 기록');
  $('#f_date').value = entry ? entry.date : todayISO();
  $('#f_title').value = entry ? (entry.title || '') : '';
  $('#titleLabel').textContent = isReading ? '책 제목' : '제목';
  $('#f_title').placeholder = isReading ? '책 제목' : '제목 (선택)';
  $('#bodyLabel').textContent = isReading ? '느낀 점 / 메모' : '내용';
  $('#f_body').placeholder = isReading ? '읽으면서 느낀 점, 인상 깊은 구절 등을 적어보세요' : '오늘 있었던 일, 생각을 자유롭게 적어보세요';
  $('#f_body').value = entry ? (entry.body || '') : '';
  $('#f_tags').value = entry ? (entry.tags || []).join(', ') : '';
  $('#f_author').value = entry ? (entry.author || '') : '';
  state.rating = entry ? (entry.rating || 0) : 0;
  renderStars();
  $('#bookFields').style.display = isReading ? 'grid' : 'none';
  $('#deleteEntryBtn').style.display = entry ? 'block' : 'none';
  $('#editorOverlay').classList.add('show');
  setTimeout(() => $('#f_title').focus(), 50);
}
function closeEditor() { stopVoice(); $('#editorOverlay').classList.remove('show'); state.editingId = null; }

function renderStars() {
  $$('#starPicker span').forEach(s => s.classList.toggle('on', +s.dataset.v <= state.rating));
}

function saveEditor() {
  stopVoice();
  const editType = state.editingType || state.activeTab;
  const isReading = editType === 'reading';
  const body = $('#f_body').value.trim();
  const title = $('#f_title').value.trim();
  if (!body && !title) { toast('내용을 입력해주세요'); return; }
  const entry = {
    id: state.editingId || uid(),
    type: editType,
    date: $('#f_date').value || todayISO(),
    title,
    body,
    tags: $('#f_tags').value.split(',').map(t => t.trim()).filter(Boolean),
    createdAt: (state.entries.find(e => e.id === state.editingId)?.createdAt) || Date.now(),
  };
  if (isReading) {
    entry.author = $('#f_author').value.trim();
    entry.rating = state.rating;
  }
  upsertEntry(entry);
  closeEditor();
  toast('저장되었습니다');
}

/* =====================================================================
   BACKUP / RESTORE
   ===================================================================== */
function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), settings: { theme: state.settings.theme }, entries: state.entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `기록장_백업_${todayISO()}.json`;
  a.click();
  toast('백업 파일을 내려받았습니다');
}
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = data.entries || [];
      let added = 0, updated = 0;
      incoming.forEach(e => {
        const idx = state.entries.findIndex(x => x.id === e.id);
        if (idx === -1) { state.entries.push(e); added++; }
        else if ((e.updatedAt || 0) > (state.entries[idx].updatedAt || 0)) { state.entries[idx] = e; updated++; }
      });
      saveEntriesLocal();
      incoming.forEach(pushEntryToCloud);
      renderAll();
      toast(`복원 완료: 신규 ${added}건 · 갱신 ${updated}건`);
    } catch (e) {
      toast('파일을 읽을 수 없습니다');
    }
  };
  reader.readAsText(file);
}

/* =====================================================================
   SETTINGS SHEET
   ===================================================================== */
function openSettings() {
  applyTheme(state.settings.theme);
  $('#fpToggle').classList.toggle('on', !!state.settings.fpEnabled);
  $('#f_syncCode').value = state.settings.syncCode || '';
  $('#f_firebaseConfig').value = state.settings.firebaseConfig ? JSON.stringify(state.settings.firebaseConfig, null, 2) : '';
  $('#settingsOverlay').classList.add('show');
}
function closeSettings() { $('#settingsOverlay').classList.remove('show'); }

/* =====================================================================
   VOICE INPUT (Web Speech API — 한국어 음성 인식)
   ===================================================================== */
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRecognition = null;
let activeMicBtn = null;

function setupVoiceButton(btnId, fieldId) {
  const btn = $(btnId), field = $(fieldId);
  if (!btn || !field) return;
  if (!SpeechRecognitionCtor) { btn.classList.add('unsupported'); return; }

  btn.addEventListener('click', () => {
    if (activeMicBtn === btn) { stopVoice(); return; }
    if (activeRecognition) stopVoice();
    startVoice(btn, field);
  });
}

function startVoice(btn, field) {
  const rec = new SpeechRecognitionCtor();
  rec.lang = 'ko-KR';
  rec.continuous = true;
  rec.interimResults = true;

  const baseValue = field.value ? field.value.replace(/\s+$/, '') + (field.value ? ' ' : '') : '';
  let finalText = '';

  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const chunk = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += chunk + ' ';
      else interim += chunk;
    }
    field.value = baseValue + finalText + interim;
  };
  rec.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      toast('마이크 권한을 허용해주세요');
    }
    stopVoice();
  };
  rec.onend = () => {
    if (activeRecognition === rec) stopVoice();
  };

  try {
    rec.start();
    activeRecognition = rec;
    activeMicBtn = btn;
    btn.classList.add('listening');
    toast('듣고 있습니다… 다시 누르면 멈춥니다');
  } catch (e) {
    console.error('voice start failed', e);
  }
}

function stopVoice() {
  if (activeRecognition) {
    try { activeRecognition.stop(); } catch {}
  }
  if (activeMicBtn) activeMicBtn.classList.remove('listening');
  activeRecognition = null;
  activeMicBtn = null;
}

/* =====================================================================
   PHOTO HIGHLIGHT IMPORT (사진 속 형광펜 표시 → 텍스트)
   ===================================================================== */
const pi = { img: null, chosenHue: 'auto' };

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return [h, s, l];
}

function detectAutoHue(data, w, h) {
  const bins = new Array(36).fill(0);
  for (let i = 0; i < data.length; i += 4 * 7) { // sample every ~7th pixel for speed
    const [hh, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    // 살구색/피부색(대략 5~35도)은 채도가 낮아도 형광펜처럼 잡히기 쉬워
    // 자동감지 후보에서 아예 제외한다. 정말 주황 형광펜이면 수동으로 '주황'을 고르면 됨.
    const isSkinish = hh >= 5 && hh <= 35;
    if (!isSkinish && s > 0.4 && l > 0.4 && l < 0.9) bins[Math.floor(hh / 10) % 36]++;
  }
  let best = 0, bestCount = -1;
  bins.forEach((c, i) => { if (c > bestCount) { bestCount = c; best = i; } });
  return bestCount > 0 ? best * 10 + 5 : null;
}

function buildHighlightMask(data, w, h, targetHue) {
  const mask = new Uint8Array(w * h);
  const tol = 26; // 색상 허용 오차(도) — 사진마다 색감이 달라 넉넉하게
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    const [hh, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    let dh = Math.abs(hh - targetHue);
    if (dh > 180) dh = 360 - dh;
    if (dh <= tol && s > 0.24 && l > 0.32 && l < 0.96) mask[p] = 1;
  }
  return mask;
}

function dilateMask(mask, w, h, iterations) {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (cur[idx]) { next[idx] = 1; continue; }
        let on = false;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny >= 0 && ny < h && nx >= 0 && nx < w && cur[ny * w + nx]) { on = true; break; }
          }
        }
        if (on) next[idx] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// 마스크가 있는 가로 줄들을 찾아서, 형광펜이 칠해진 '띠(band)' 단위로 묶는다.
// 픽셀 단위로 지우는 대신 줄 단위 사각형을 원본에서 그대로 잘라 쓰기 때문에
// 글자 획이 중간에 끊기지 않는다.
// 또한 본문 옆 여백에 '세로줄'로만 표시해둔 경우(형광펜이 글자 위가 아니라
// 옆 여백에 세로로 그어진 경우)를 감지해서, 그 옆에 있는 문단 전체 줄을
// 포함하도록 가로 범위를 넓혀준다.
function findHighlightBands(mask, w, h, opts) {
  const { mergeGapPx, minRowHits, padY, padX } = opts;
  const rowHits = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    let c = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) c += mask[base + x];
    rowHits[y] = c;
  }
  const active = rowHits.map(c => c >= minRowHits);

  const raw = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    if (active[y] && start === -1) start = y;
    if (!active[y] && start !== -1) { raw.push([start, y - 1]); start = -1; }
  }
  if (start !== -1) raw.push([start, h - 1]);

  // 가까운 줄끼리 합치기
  const merged = [];
  for (const [s, e] of raw) {
    if (merged.length && s - merged[merged.length - 1][1] <= mergeGapPx) {
      merged[merged.length - 1][1] = e;
    } else merged.push([s, e]);
  }

  const bands = merged.map(([y0, y1]) => {
    let minX = w, maxX = -1;
    for (let y = y0; y <= y1; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[base + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
    }
    if (maxX < 0) return null;

    let strength = 0;
    for (let y = y0; y <= y1; y++) strength += rowHits[y];

    const barRatio = (maxX - minX) / w;
    let x0, x1;
    if (barRatio < 0.15) {
      // 표시된 색 너비가 좁다 → 글자 위가 아니라 옆 여백에 그은 '세로줄 표시'로 판단.
      // 표시가 있는 쪽 반대편(문단이 있는 쪽)으로 가로 범위를 넓게 잡는다.
      const barCenter = (minX + maxX) / 2;
      if (barCenter < w / 2) {
        x0 = Math.max(0, minX - padX);
        x1 = Math.min(w, Math.round(w * 0.97));
      } else {
        x0 = Math.max(0, Math.round(w * 0.03));
        x1 = Math.min(w, maxX + padX);
      }
    } else {
      x0 = Math.max(0, minX - padX);
      x1 = Math.min(w, maxX + padX);
    }

    const yy0 = Math.max(0, y0 - padY), yy1 = Math.min(h, y1 + padY);
    return { x: x0, y: yy0, w: x1 - x0, h: yy1 - yy0, strength, rowSpan: y1 - y0 + 1 };
  }).filter(Boolean);

  if (!bands.length) return [];

  // 아주 작은 잡티(피부색·조명 반사 등으로 잘못 걸린 점 몇 개)를 걸러낸다:
  // 실제 형광펜 줄에 비해 색칠된 양이 너무 적거나, 세로 폭이 너무 좁으면 노이즈로 간주.
  const maxStrength = Math.max(...bands.map(b => b.strength));
  const filtered = bands.filter(b => b.rowSpan >= 6 && b.strength >= maxStrength * 0.12);

  return (filtered.length ? filtered : bands).slice(0, 6);
}

// 자르기만 하고(색은 원본 그대로), 살짝 대비만 올려서 OCR 정확도를 높인다.
// 예전처럼 임계값으로 흑/백을 강제로 나누면 획이 끊겨서 오히려 인식률이 떨어졌다.
function enhanceForOcr(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  let min = 255, max = 0;
  const gray = new Float32Array(w * h);
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    gray[p] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    const v = Math.max(0, Math.min(255, ((gray[p] - min) / range) * 255));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// 잘라낸 조각이 너무 작으면 OCR 정확도가 크게 떨어지므로, 글자 높이가 넉넉해지도록 확대
function cropAndUpscale(srcCanvas, box, targetMinHeight) {
  const scale = box.h < targetMinHeight ? targetMinHeight / box.h : 1;
  const outW = Math.round(box.w * scale), outH = Math.round(box.h * scale);
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(srcCanvas, box.x, box.y, box.w, box.h, 0, 0, outW, outH);
  return out;
}

function piSetStatus(pct, label) {
  $('#pi_progress').style.display = 'block';
  $('#pi_progress_fill').style.width = pct + '%';
  $('#pi_progress_label').textContent = label;
}

function piLoadImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function piRun() {
  if (!pi.img) { toast('먼저 사진을 선택해주세요'); return; }
  if (typeof Tesseract === 'undefined') { toast('문자 인식 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요'); return; }

  $('#pi_runBtn').disabled = true;
  $('#pi_resultField').style.display = 'none';
  $('#pi_insertBtn').style.display = 'none';
  piSetStatus(5, '이미지 준비 중…');

  // 1) 원본을 작업용 캔버스에 넉넉한 해상도로 그리기 (너무 축소하면 인식률이 떨어짐)
  const MAXW = 1800;
  const scale0 = Math.min(1, MAXW / pi.img.width);
  const w = Math.round(pi.img.width * scale0), h = Math.round(pi.img.height * scale0);
  const work = document.createElement('canvas');
  work.width = w; work.height = h;
  const wctx = work.getContext('2d');
  wctx.drawImage(pi.img, 0, 0, w, h);
  const imgData = wctx.getImageData(0, 0, w, h);

  // 2) 형광펜 색 마스크 만들기
  piSetStatus(15, '형광펜 영역 찾는 중…');
  let hue = pi.chosenHue;
  if (hue === 'auto') {
    hue = detectAutoHue(imgData.data, w, h);
    if (hue === null) toast('형광펜 색을 찾지 못해 전체 이미지를 인식합니다');
  }
  let mask = hue !== null ? buildHighlightMask(imgData.data, w, h, hue) : new Uint8Array(w * h).fill(1);
  mask = dilateMask(mask, w, h, 6);

  // 3) 형광펜이 칠해진 '줄 띠' 단위로 영역을 나눈다 (픽셀 단위로 지우지 않음 → 글자가 안 끊김)
  const bands = findHighlightBands(mask, w, h, {
    mergeGapPx: Math.max(10, Math.round(h * 0.015)),
    minRowHits: Math.max(3, Math.round(w * 0.006)),
    padY: Math.round(h * 0.012),
    padX: Math.round(w * 0.01),
  });

  const regions = bands.length ? bands : [{ x: 0, y: 0, w, h }];

  // 미리보기: band들을 위아래로 이어붙여서 보여주기
  const previewCanvas = $('#pi_canvas');
  const gap = 10;
  const pw = Math.max(...regions.map(b => b.w));
  const ph = regions.reduce((s, b) => s + b.h, 0) + gap * (regions.length - 1);
  previewCanvas.width = pw; previewCanvas.height = ph;
  const pctx = previewCanvas.getContext('2d');
  pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, pw, ph);
  let py = 0;
  for (const b of regions) {
    pctx.drawImage(work, b.x, b.y, b.w, b.h, 0, py, b.w, b.h);
    py += b.h + gap;
  }
  previewCanvas.style.display = 'block';

  // 4) OCR 실행 — 영역별로 잘라서 하나씩 인식
  let worker = null;
  try {
    piSetStatus(30, '인식 준비 중…');
    worker = await Tesseract.createWorker('kor+eng');
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });

    const texts = [];
    for (let i = 0; i < regions.length; i++) {
      const box = regions[i];
      const cropped = cropAndUpscale(work, box, 130);
      enhanceForOcr(cropped);
      piSetStatus(30 + Math.round((i / regions.length) * 65), `글자 인식 중… (${i + 1}/${regions.length})`);
      const { data } = await worker.recognize(cropped);
      // 책은 페이지 폭 때문에 줄이 꺾여 있을 뿐 실제 문장은 이어지므로,
      // 인식된 줄바꿈은 공백으로 이어붙여 하나의 문단으로 만든다.
      const t = (data.text || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (t) texts.push(t);
    }
    await worker.terminate();
    worker = null;

    const text = texts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    piSetStatus(100, '완료');
    $('#pi_resultText').value = text || '(텍스트를 찾지 못했습니다. 형광펜 색을 바꾸거나 사진을 더 밝고 선명하게 찍어 다시 시도해보세요)';
    $('#pi_resultField').style.display = 'block';
    $('#pi_insertBtn').style.display = 'block';
  } catch (e) {
    console.error('OCR failed', e);
    toast('인식에 실패했습니다. 다시 시도해주세요');
    $('#pi_progress').style.display = 'none';
    if (worker) { try { await worker.terminate(); } catch {} }
  } finally {
    $('#pi_runBtn').disabled = false;
  }
}

function openPhotoImport() {
  pi.img = null; pi.chosenHue = 'auto';
  $('#pi_file').value = '';
  $('#pi_canvas').style.display = 'none';
  $('#pi_progress').style.display = 'none';
  $('#pi_resultField').style.display = 'none';
  $('#pi_insertBtn').style.display = 'none';
  $('#pi_runBtn').disabled = true;
  $$('.pi-color').forEach(b => b.classList.toggle('active', b.dataset.hue === 'auto'));
  $('#photoImportOverlay').classList.add('show');
}
function closePhotoImport() { $('#photoImportOverlay').classList.remove('show'); }

/* =====================================================================
   EVENT WIRING
   ===================================================================== */
function wireEvents() {
  $$('.ribbon').forEach(r => r.addEventListener('click', () => {
    state.activeTab = r.dataset.tab; state.search = ''; $('#searchInput').value = ''; renderAll();
  }));
  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderAll(); });
  $('#searchClear').addEventListener('click', () => { state.search = ''; $('#searchInput').value = ''; $('#searchInput').focus(); renderAll(); });
  $('#fabAdd').addEventListener('click', () => openEditor(null));
  $('#cancelEditorBtn').addEventListener('click', closeEditor);
  $('#saveEntryBtn').addEventListener('click', saveEditor);
  $('#deleteEntryBtn').addEventListener('click', () => {
    if (state.editingId && confirm('이 기록을 삭제할까요?')) { deleteEntry(state.editingId); closeEditor(); toast('삭제되었습니다'); }
  });
  $('#editorOverlay').addEventListener('click', (e) => { if (e.target.id === 'editorOverlay') closeEditor(); });
  $$('#starPicker span').forEach(s => s.addEventListener('click', () => {
    state.rating = (state.rating === +s.dataset.v) ? 0 : +s.dataset.v; renderStars();
  }));

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', closeSettings);
  $('#settingsOverlay').addEventListener('click', (e) => { if (e.target.id === 'settingsOverlay') closeSettings(); });

  $$('.swatch').forEach(s => s.addEventListener('click', () => {
    state.settings.theme = s.dataset.theme; saveSettingsLocal(); applyTheme(s.dataset.theme);
  }));

  $('#fpToggle').addEventListener('click', async () => {
    if (!state.settings.fpEnabled) {
      const avail = await webauthnAvailable();
      if (!avail) { toast('이 기기에서는 지문 인식을 사용할 수 없습니다'); return; }
      const ok = await registerBiometric();
      if (ok) { state.settings.fpEnabled = true; saveSettingsLocal(); $('#fpToggle').classList.add('on'); toast('지문 잠금이 설정되었습니다'); }
      else toast('지문 등록에 실패했습니다');
    } else {
      state.settings.fpEnabled = false; saveSettingsLocal(); $('#fpToggle').classList.remove('on');
      localStorage.removeItem(LS_FP_CRED);
    }
  });
  $('#changePinBtn').addEventListener('click', () => {
    if (confirm('PIN을 재설정할까요? 다음 잠금 시 새 번호를 등록합니다.')) {
      localStorage.removeItem(LS_PIN); toast('PIN이 초기화되었습니다. 다시 잠그면 새로 등록해주세요.');
    }
  });

  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  $('#saveSyncBtn').addEventListener('click', () => {
    const code = $('#f_syncCode').value.trim() || uid().slice(0, 6).toUpperCase();
    let cfg = null;
    const raw = $('#f_firebaseConfig').value.trim();
    if (raw) {
      try { cfg = JSON.parse(raw); } catch { toast('Firebase 설정 JSON 형식이 올바르지 않습니다'); return; }
    }
    state.settings.syncCode = code;
    state.settings.firebaseConfig = cfg;
    saveSettingsLocal();
    $('#f_syncCode').value = code;
    if (cfg) { initFirebaseSync(); toast(`동기화 코드: ${code} (다른 기기에도 같은 코드를 입력하세요)`); }
    else toast('설정이 저장되었습니다');
  });

  setupVoiceButton('#mic_title', '#f_title');
  setupVoiceButton('#mic_body', '#f_body');
  setupVoiceButton('#mic_author', '#f_author');

  $('#openPhotoImportBtn').addEventListener('click', openPhotoImport);
  $('#pi_cancelBtn').addEventListener('click', closePhotoImport);
  $('#photoImportOverlay').addEventListener('click', (e) => { if (e.target.id === 'photoImportOverlay') closePhotoImport(); });
  $('#pi_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pi.img = await piLoadImageFile(file);
      $('#pi_runBtn').disabled = false;
      toast('사진을 불러왔습니다. 형광펜 색을 고르고 인식을 눌러주세요');
    } catch { toast('사진을 불러오지 못했습니다'); }
  });
  $$('.pi-color').forEach(btn => btn.addEventListener('click', () => {
    $$('.pi-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pi.chosenHue = btn.dataset.hue === 'auto' ? 'auto' : Number(btn.dataset.hue);
  }));
  $('#pi_runBtn').addEventListener('click', piRun);
  $('#pi_insertBtn').addEventListener('click', () => {
    const text = $('#pi_resultText').value.trim();
    if (!text) { closePhotoImport(); return; }
    const cur = $('#f_body').value;
    $('#f_body').value = cur ? (cur.replace(/\s+$/, '') + '\n\n' + text) : text;
    closePhotoImport();
    toast('내용에 추가되었습니다');
  });
}

/* =====================================================================
   INIT
   ===================================================================== */
function init() {
  loadLocal();
  applyTheme(state.settings.theme);
  wireEvents();

  const params = new URLSearchParams(location.search);
  if (params.get('resetpin') === '1') {
    localStorage.removeItem(LS_PIN);
    localStorage.removeItem(LS_FP_CRED);
  }
  if (params.get('preview') === '1') {
    // 잠금을 건너뛰고 바로 미리보기 — 확인이 끝나면 이 링크는 쓰지 마세요.
    unlockApp();
  } else {
    initLock();
  }

  if (state.settings.firebaseConfig && state.settings.syncCode) initFirebaseSync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
