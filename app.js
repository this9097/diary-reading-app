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
  bookFilter: null, // { title, author } — 독서노트에서 특정 책 기록만 볼 때
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
  const grid = $('#bookGrid');
  const q = state.search.trim();
  const searching = q.length > 0;
  const ql = q.toLowerCase();
  const filteringBook = !searching && state.activeTab === 'reading' && state.bookFilter;
  const showBookGrid = state.activeTab === 'reading' && !searching && !state.bookFilter;

  // While searching, look across BOTH 일기 and 독서노트; otherwise stick to the active tab.
  let items = searching ? state.entries.slice() : state.entries.filter(e => e.type === state.activeTab);
  if (searching) {
    items = items.filter(e =>
      (e.title || '').toLowerCase().includes(ql) ||
      (e.body || '').toLowerCase().includes(ql) ||
      (e.author || '').toLowerCase().includes(ql) ||
      (e.tags || []).some(t => t.toLowerCase().includes(ql))
    );
  } else if (filteringBook) {
    items = items.filter(e => e.title === state.bookFilter.title);
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

  const filterBar = $('#bookFilterBar');
  if (filteringBook) {
    $('#bfb_title').textContent = state.bookFilter.title;
    $('#bfb_meta').textContent = `${state.bookFilter.author ? state.bookFilter.author + ' · ' : ''}기록 ${items.length}건`;
    filterBar.style.display = 'flex';
  } else {
    filterBar.style.display = 'none';
  }

  if (showBookGrid) {
    list.style.display = 'none';
    renderBookGrid();
    return;
  }
  grid.style.display = 'none';
  list.style.display = 'block';

  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
      <p>${searching ? '검색 결과가 없습니다' : (filteringBook ? '이 책에 남긴 기록이 없습니다' : (state.activeTab === 'diary' ? '아직 쓴 일기가 없습니다.\n오늘 하루는 어떠셨나요?' : '아직 기록한 책이 없습니다.\n최근 읽은 책을 남겨보세요.'))}</p>
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
// 독서노트 탭 위쪽에 "기존 책에 기록 추가" 버튼을 보여줄지 결정한다.
// 실제 목록은 버튼을 눌렀을 때 뜨는 검색 가능한 시트에서 고른다 (책이 수백 권이어도
// 스크롤/검색으로 찾을 수 있어야 하므로 가로 칩 나열 방식은 쓰지 않는다).
function getBookList() {
  const map = new Map(); // title -> {title, author, count, latestUpdatedAt, coverUrl}
  state.entries.filter(e => e.type === 'reading' && e.title).forEach(e => {
    const cur = map.get(e.title);
    if (!cur) {
      map.set(e.title, { title: e.title, author: e.author || '', count: 1, latestUpdatedAt: e.updatedAt, coverUrl: e.coverUrl || null });
    } else {
      cur.count++;
      if (e.updatedAt > cur.latestUpdatedAt) cur.latestUpdatedAt = e.updatedAt;
      if (!cur.coverUrl && e.coverUrl) cur.coverUrl = e.coverUrl;
    }
  });
  return [...map.values()].sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt);
}

const bookCoverIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`;

// 독서노트 탭의 기본 화면: 책 표지·제목·저자·기록 개수를 보여주는 책장.
// 책을 누르면 그 책의 기록만 걸러서 보여주고(bookFilter), 연필로 제목을 고칠 수 있다.
function renderBookGrid() {
  const grid = $('#bookGrid');
  const books = getBookList();
  if (!books.length) {
    grid.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
      <p>아직 기록한 책이 없습니다.\n최근 읽은 책을 남겨보세요.</p>
    </div>`;
    grid.style.display = 'block';
    return;
  }
  grid.innerHTML = books.map(b => `
    <div class="book-row">
      <button class="book-row-main" data-title="${escapeHtml(b.title)}" data-author="${escapeHtml(b.author)}">
        <div class="book-cover" data-cover-for="${escapeHtml(b.title)}">${b.coverUrl ? `<img src="${escapeHtml(b.coverUrl)}" alt="">` : bookCoverIcon}</div>
      </button>
      <button class="book-row-main" data-title="${escapeHtml(b.title)}" data-author="${escapeHtml(b.author)}" style="flex:1;">
        <span class="br-title">${escapeHtml(b.title)}</span>
        ${b.author ? `<span class="br-author">${escapeHtml(b.author)}</span>` : ''}
        <span class="br-count">기록 ${b.count}건</span>
      </button>
      <button class="book-edit-btn" data-title="${escapeHtml(b.title)}" data-author="${escapeHtml(b.author)}" title="책 제목 수정">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>
      </button>
    </div>
  `).join('');
  // 표지가 없는 책은 조용히 웹에서 찾아와서 채워넣는다 (실패해도 아이콘 그대로 유지)
  books.filter(b => !b.coverUrl).forEach(b => ensureBookCover(b));
  grid.querySelectorAll('.book-row-main').forEach(row => {
    row.addEventListener('click', () => {
      state.search = ''; $('#searchInput').value = '';
      state.bookFilter = { title: row.dataset.title, author: row.dataset.author };
      renderAll();
    });
  });
  grid.querySelectorAll('.book-edit-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      renameBook(btn.dataset.title, btn.dataset.author);
    });
  });
  grid.style.display = 'flex';
}

// 책 제목(과 저자)을 한 번에 고쳐서, 그 책으로 묶인 기록 전체에 반영한다.
function renameBook(oldTitle, oldAuthor) {
  const newTitleRaw = prompt('책 제목 수정', oldTitle);
  if (newTitleRaw === null) return; // 취소
  const newTitle = newTitleRaw.trim();
  if (!newTitle) { toast('제목을 입력해주세요'); return; }
  const newAuthorRaw = prompt('저자 수정 (그대로 두려면 확인만 눌러주세요)', oldAuthor || '');
  const newAuthor = newAuthorRaw === null ? oldAuthor : newAuthorRaw.trim();

  if (newTitle === oldTitle && newAuthor === oldAuthor) return;

  let changed = 0;
  state.entries.forEach(e => {
    if (e.type === 'reading' && e.title === oldTitle) {
      e.title = newTitle;
      e.author = newAuthor;
      e.updatedAt = Date.now();
      pushEntryToCloud(e);
      changed++;
    }
  });
  saveEntriesLocal();
  if (state.bookFilter && state.bookFilter.title === oldTitle) state.bookFilter = { title: newTitle, author: newAuthor };
  renderAll();
  toast(`기록 ${changed}건에 반영했습니다`);
}

// 기존 책 제목/저자를 미리 채운 채로 새 독서노트 작성창을 연다.
function openEditorForBook(title, author) {
  const book = getBookList().find(b => b.title === title);
  selectedBookCover = book?.coverUrl || null;
  openEditor(null);
  $('#f_title').value = title || '';
  $('#f_author').value = author || '';
  setTimeout(() => $('#f_body').focus(), 60);
}

function openEditor(entry) {
  const editType = entry ? entry.type : state.activeTab;
  const isReading = editType === 'reading';
  state.editingId = entry ? entry.id : null;
  state.editingType = editType;
  if (entry) selectedBookCover = entry.coverUrl || null;
  $('#editorTitle').textContent = entry ? '기록 수정' : (isReading ? '새 독서노트' : '오늘의 기록');
  $('#f_date').value = entry ? entry.date : todayISO();
  $('#f_title').value = entry ? (entry.title || '') : '';
  $('#titleLabel').textContent = isReading ? '책 제목' : '제목';
  $('#f_title').placeholder = isReading ? '책 제목 (검색하면 목록이 떠요)' : '제목 (선택)';
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
function closeEditor() {
  $('#editorOverlay').classList.remove('show');
  state.editingId = null;
}

// 예전에 적었던 책 제목/저자를 눌러서 고를 수 있는 자체 드롭다운 목록.
// (Android 브라우저의 <datalist>는 키보드에 붙은 예측입력 칩으로 뜨는 경우가 있어
//  스크롤 가능한 자체 목록으로 대신한다.)
function uniqueSorted(getFn) {
  return [...new Set(state.entries.filter(e => e.type === 'reading' && getFn(e)).map(getFn))].sort();
}

function setupAutocomplete(inputSel, listSel, getOptions, onPick, guard) {
  const input = $(inputSel), list = $(listSel);

  function positionList() {
    const rect = input.getBoundingClientRect();
    list.style.left = rect.left + 'px';
    list.style.top = (rect.bottom + 4) + 'px';
    list.style.width = rect.width + 'px';
  }

  function render() {
    if (guard && !guard()) { list.classList.remove('show'); return; }
    const q = input.value.trim().toLowerCase();
    const opts = getOptions().filter(o => !q || o.toLowerCase().includes(q));
    if (!opts.length) { list.classList.remove('show'); return; }
    list.innerHTML = opts.slice(0, 40).map(o => `<div class="ac-item"><div class="ac-item-title">${escapeHtml(o)}</div></div>`).join('');
    positionList();
    list.classList.add('show');
  }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => list.classList.remove('show'), 200));
  window.addEventListener('scroll', () => { if (list.classList.contains('show')) positionList(); }, true);
  list.addEventListener('click', (ev) => {
    const item = ev.target.closest('.ac-item');
    if (!item) return;
    input.value = item.textContent;
    list.classList.remove('show');
    onPick?.(item.textContent);
  });
}

function renderStars() {
  $$('#starPicker span').forEach(s => s.classList.toggle('on', +s.dataset.v <= state.rating));
}

/* =====================================================================
   책 제목 검색 — 네이버/구글처럼 몇 글자만 쳐도 실제 책 목록이 뜨고,
   눌러서 계속 이어서 고를 수 있게 한다 (구글 도서 API 사용, 무료·키 불필요).
   ===================================================================== */
let bookSearchTimer = null;
let bookSearchAbort = null;
let selectedBookCover = null; // 검색 결과에서 고른 책의 표지 URL — 저장할 때 entry에 붙는다

async function searchBooksOnline(query) {
  if (bookSearchAbort) bookSearchAbort.abort();
  bookSearchAbort = new AbortController();
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&langRestrict=ko`;
    const res = await fetch(url, { signal: bookSearchAbort.signal });
    if (!res.ok) return [];
    const data = await res.json();
    const seen = new Set();
    const out = [];
    for (const it of (data.items || [])) {
      const vi = it.volumeInfo || {};
      if (!vi.title || seen.has(vi.title)) continue;
      seen.add(vi.title);
      const cover = vi.imageLinks?.thumbnail?.replace(/^http:/, 'https:') || null;
      out.push({ title: vi.title, author: (vi.authors || []).join(', '), cover });
    }
    return out;
  } catch (e) {
    if (e.name === 'AbortError') return null; // 더 최신 검색이 이미 시작됨 → 이 결과는 버림
    return [];
  }
}

// 책장에서 표지가 없는 책은 조용히 웹(구글 도서)에서 찾아 채워넣는다.
// 같은 제목을 반복해서 검색하지 않도록 결과(성공/실패 모두)를 캐시해둔다.
const coverLookupCache = new Map(); // title -> coverUrl(string) | null(못 찾음)
const coverLookupInFlight = new Set();

async function ensureBookCover(book) {
  if (book.coverUrl || coverLookupInFlight.has(book.title)) return;
  if (coverLookupCache.has(book.title)) {
    const cached = coverLookupCache.get(book.title);
    if (cached) applyBookCover(book.title, cached);
    return;
  }
  coverLookupInFlight.add(book.title);
  try {
    const query = book.author ? `${book.title} ${book.author}` : book.title;
    const results = await searchBooksOnline(query);
    const found = (results || []).find(r => r.cover)?.cover || null;
    coverLookupCache.set(book.title, found);
    if (found) applyBookCover(book.title, found);
  } finally {
    coverLookupInFlight.delete(book.title);
  }
}

function applyBookCover(title, coverUrl) {
  let changed = false;
  state.entries.forEach(e => {
    if (e.type === 'reading' && e.title === title && !e.coverUrl) {
      e.coverUrl = coverUrl;
      pushEntryToCloud(e);
      changed = true;
    }
  });
  if (!changed) return;
  saveEntriesLocal();
  // 화면 전체를 다시 그리지 않고, 해당 책 표지 자리만 조용히 채워넣는다
  $$('.book-cover[data-cover-for]').forEach(el => {
    if (el.dataset.coverFor === title && !el.querySelector('img')) {
      el.innerHTML = `<img src="${escapeHtml(coverUrl)}" alt="">`;
    }
  });
}

function setupTitleBookSearch() {
  const input = $('#f_title'), list = $('#titleAcList');

  function positionList() {
    const rect = input.getBoundingClientRect();
    list.style.left = rect.left + 'px';
    list.style.top = (rect.bottom + 4) + 'px';
    list.style.width = rect.width + 'px';
  }

  function renderItems(items) {
    list._items = items;
    if (!items.length) { list.classList.remove('show'); return; }
    list.innerHTML = items.map((b, i) => `
      <div class="ac-item" data-i="${i}">
        <div class="ac-item-title">${escapeHtml(b.title)}</div>
        ${b.author ? `<div class="ac-item-sub">${escapeHtml(b.author)}</div>` : ''}
        ${b.mine ? `<div class="ac-item-mine">내가 예전에 적은 책</div>` : ''}
      </div>
    `).join('');
    positionList();
    list.classList.add('show');
  }

  function ownBooksMatching(q) {
    return uniqueSorted(e => e.title)
      .filter(t => !q || t.toLowerCase().includes(q.toLowerCase()))
      .map(t => {
        const m = state.entries.find(e => e.type === 'reading' && e.title === t);
        return { title: t, author: m?.author || '', cover: m?.coverUrl || null, mine: true };
      });
  }

  input.addEventListener('focus', () => {
    if (state.editingType !== 'reading') return;
    if (!input.value.trim()) renderItems(ownBooksMatching(''));
  });

  input.addEventListener('input', () => {
    if (state.editingType !== 'reading') return;
    const q = input.value.trim();
    clearTimeout(bookSearchTimer);
    if (!q) { renderItems(ownBooksMatching('')); return; }
    if (q.length < 2) { renderItems(ownBooksMatching(q)); return; }
    bookSearchTimer = setTimeout(async () => {
      const own = ownBooksMatching(q);
      const ownTitles = new Set(own.map(o => o.title));
      const online = await searchBooksOnline(q);
      if (online === null) return; // 취소된 요청 (더 최근 검색이 진행 중)
      renderItems([...own, ...online.filter(b => !ownTitles.has(b.title))]);
    }, 350);
  });

  input.addEventListener('blur', () => setTimeout(() => list.classList.remove('show'), 200));
  window.addEventListener('scroll', () => { if (list.classList.contains('show')) positionList(); }, true);

  list.addEventListener('click', (ev) => {
    const item = ev.target.closest('.ac-item');
    if (!item) return;
    const b = (list._items || [])[+item.dataset.i];
    if (!b) return;
    input.value = b.title;
    list.classList.remove('show');
    if (b.author && !$('#f_author').value.trim()) $('#f_author').value = b.author;
    selectedBookCover = b.cover || null;
  });
}


function saveEditor() {
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
    entry.coverUrl = selectedBookCover || null;
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
function closeSettings() {
  $('#settingsOverlay').classList.remove('show');
}

/* =====================================================================
   PHOTO 문장 가져오기 (사용자가 직접 드래그로 선택한 영역만 OCR)
   ===================================================================== */
const pi = { img: null, displayScale: 1, sel: null, mode: 'none', rect: null, grabCorner: null, grabOffset: null };

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

function piSetStatus(pct, label) {
  $('#pi_progress').style.display = 'block';
  $('#pi_progress_fill').style.width = pct + '%';
  $('#pi_progress_label').textContent = label;
}

function piDrawImage() {
  const wrap = $('#pi_imgwrap');
  const canvas = $('#pi_dispCanvas');
  // 실제 렌더링 너비를 재려면 먼저 보이는 상태여야 한다.
  // (이전 버그: 부모 요소의 clientWidth를 썼는데, 부모의 padding이 빠지지
  //  않은 값이라 화면에 그려지는 실제 폭보다 커서 좌표 변환에 오차가 생겼다)
  wrap.style.display = 'block';
  const maxW = Math.min(wrap.clientWidth || 600, 640);
  const scale = Math.min(1, maxW / pi.img.width);
  canvas.width = Math.round(pi.img.width * scale);
  canvas.height = Math.round(pi.img.height * scale);
  // 캔버스는 CSS로 wrap 폭의 100%로 렌더링되므로, 실제 화면 표시 폭 기준으로
  // 좌표 변환 비율을 다시 한번 정확히 맞춘다.
  pi.displayScale = canvas.width / pi.img.width;
  canvas.getContext('2d').drawImage(pi.img, 0, 0, canvas.width, canvas.height);
  $('#pi_hint').style.display = 'block';
}

function piWrapPoint(ev) {
  const wrap = $('#pi_imgwrap');
  const rect = wrap.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
  return { x, y, boundsW: rect.width, boundsH: rect.height };
}

// pi.rect: 화면 표시 좌표계의 현재 선택 사각형 {x0,y0,x1,y1} (x0<x1, y0<y1)
function piRenderRect() {
  const r = pi.rect;
  const box = $('#pi_selbox');
  if (!r) { box.style.display = 'none'; return; }
  box.style.left = r.x0 + 'px';
  box.style.top = r.y0 + 'px';
  box.style.width = (r.x1 - r.x0) + 'px';
  box.style.height = (r.y1 - r.y0) + 'px';
  box.style.display = 'block';
}

function piCommitSelFromRect() {
  const r = pi.rect;
  if (!r) { pi.sel = null; $('#pi_runBtn').disabled = true; return; }
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  if (w < 14 || h < 10) return;
  pi.sel = {
    x: Math.round(r.x0 / pi.displayScale),
    y: Math.round(r.y0 / pi.displayScale),
    w: Math.round(w / pi.displayScale),
    h: Math.round(h / pi.displayScale),
  };
  $('#pi_runBtn').disabled = false;
}

function piCornerAt(p) {
  if (!pi.rect) return null;
  const pts = {
    nw: { x: pi.rect.x0, y: pi.rect.y0 },
    ne: { x: pi.rect.x1, y: pi.rect.y0 },
    sw: { x: pi.rect.x0, y: pi.rect.y1 },
    se: { x: pi.rect.x1, y: pi.rect.y1 },
  };
  const R = 26; // 손가락으로 잡기 쉽게 넉넉한 반경
  for (const [corner, pt] of Object.entries(pts)) {
    if (Math.hypot(p.x - pt.x, p.y - pt.y) <= R) return corner;
  }
  return null;
}

function piInsideRect(p) {
  return pi.rect && p.x >= pi.rect.x0 && p.x <= pi.rect.x1 && p.y >= pi.rect.y0 && p.y <= pi.rect.y1;
}

function piWireSelection() {
  const wrap = $('#pi_imgwrap');

  const onDown = (ev) => {
    if (!pi.img) return;
    wrap.setPointerCapture?.(ev.pointerId);
    const p = piWrapPoint(ev);
    const corner = piCornerAt(p);
    if (corner) {
      pi.mode = 'resize';
      pi.grabCorner = corner;
    } else if (piInsideRect(p)) {
      pi.mode = 'move';
      pi.grabOffset = { x: p.x - pi.rect.x0, y: p.y - pi.rect.y0, w: pi.rect.x1 - pi.rect.x0, h: pi.rect.y1 - pi.rect.y0 };
    } else {
      pi.mode = 'draw';
      pi._drawStart = p;
      pi.rect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    piRenderRect();
  };

  const onMove = (ev) => {
    if (pi.mode === 'none') return;
    const p = piWrapPoint(ev);
    if (pi.mode === 'draw') {
      const sx = pi._drawStart.x, sy = pi._drawStart.y;
      pi.rect = { x0: Math.min(sx, p.x), y0: Math.min(sy, p.y), x1: Math.max(sx, p.x), y1: Math.max(sy, p.y) };
    } else if (pi.mode === 'resize') {
      const r = pi.rect;
      const fixed = {
        nw: { x: r.x1, y: r.y1 }, ne: { x: r.x0, y: r.y1 },
        sw: { x: r.x1, y: r.y0 }, se: { x: r.x0, y: r.y0 },
      }[pi.grabCorner];
      pi.rect = { x0: Math.min(fixed.x, p.x), y0: Math.min(fixed.y, p.y), x1: Math.max(fixed.x, p.x), y1: Math.max(fixed.y, p.y) };
    } else if (pi.mode === 'move') {
      const w = pi.grabOffset.w, h = pi.grabOffset.h;
      let nx0 = p.x - pi.grabOffset.x, ny0 = p.y - pi.grabOffset.y;
      nx0 = Math.max(0, Math.min(p.boundsW - w, nx0));
      ny0 = Math.max(0, Math.min(p.boundsH - h, ny0));
      pi.rect = { x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + h };
    }
    piRenderRect();
  };

  const onUp = () => {
    if (pi.mode === 'none') return;
    pi.mode = 'none';
    piCommitSelFromRect();
    piRenderRect();
  };

  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);
}

// 잘라낸 조각이 너무 작으면 OCR 정확도가 크게 떨어지므로, 글자 높이가 넉넉해지도록 확대.
// 대비 보정은 일부러 하지 않는다 — 그림자나 굴곡이 있는 사진에서는 억지 보정이
// 오히려 화질을 망가뜨려서, 자체적으로 대비를 처리하는 Tesseract에 맡기는 게 더 정확하다.
function cropAndUpscale(srcImg, box, targetMinHeight) {
  const scale = box.h < targetMinHeight ? targetMinHeight / box.h : 1;
  const outW = Math.round(box.w * scale), outH = Math.round(box.h * scale);
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(srcImg, box.x, box.y, box.w, box.h, 0, 0, outW, outH);
  return out;
}

async function piRun() {
  if (!pi.img || !pi.sel) { toast('먼저 인식할 부분을 드래그해서 선택해주세요'); return; }
  if (typeof Tesseract === 'undefined') { toast('문자 인식 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요'); return; }

  $('#pi_runBtn').disabled = true;
  $('#pi_resultField').style.display = 'none';
  $('#pi_insertBtn').style.display = 'none';
  piSetStatus(10, '선택한 부분 준비 중…');

  // 선택 상자 가장자리가 글자를 딱 걸치듯 자르면 그 글자를 엉뚱한 기호로
  // 잘못 읽는 경우가 많아, 사방으로 살짝 여백을 더 준 뒤 잘라낸다.
  // 여백은 아주 작게만 준다 — 너무 크면 위/아래 다른 줄 글자까지 끌려와서
  // 오히려 잡음이 생긴다. 글자 가장자리가 살짝 안 잘리는 정도면 충분하다.
  const padX = 10;
  const padY = 4;
  const paddedSel = {
    x: Math.max(0, pi.sel.x - padX),
    y: Math.max(0, pi.sel.y - padY),
    w: Math.min(pi.img.width, pi.sel.x + pi.sel.w + padX) - Math.max(0, pi.sel.x - padX),
    h: Math.min(pi.img.height, pi.sel.y + pi.sel.h + padY) - Math.max(0, pi.sel.y - padY),
  };

  const cropped = cropAndUpscale(pi.img, paddedSel, 200);

  let worker = null;
  try {
    piSetStatus(30, '글자 인식 중…');
    worker = await Tesseract.createWorker('kor+eng');
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    const { data } = await worker.recognize(cropped);
    await worker.terminate();
    worker = null;

    // 한글이 거의 없고 알파벳/숫자/기호만 뒤섞인 줄은 인식 오류(노이즈)일 확률이
    // 매우 높으므로 걸러낸다. 책 인용이 대부분 한글이라는 전제를 이용한 안전장치.
    function looksLikeNoise(line) {
      const stripped = line.replace(/[\s.,!?'"()\[\]·…\-]/g, '');
      if (stripped.length < 4) return false;
      const hangul = (stripped.match(/[가-힣]/g) || []).length;
      return (hangul / stripped.length) < 0.3;
    }

    // 책은 페이지 폭 때문에 줄이 꺾여 있을 뿐 실제 문장은 이어지므로,
    // 인식된 줄바꿈은 공백으로 이어붙여 하나의 문단으로 만든다.
    const text = (data.text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !looksLikeNoise(s))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    piSetStatus(100, '완료');
    $('#pi_resultText').value = text || '(텍스트를 찾지 못했습니다. 선택 영역을 조금 더 넉넉하게 잡거나 사진을 더 밝고 선명하게 찍어 다시 시도해보세요)';
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

let piSelectionWired = false;
function openPhotoImport() {
  pi.img = null; pi.sel = null; pi.rect = null; pi.mode = 'none';
  $('#pi_file').value = '';
  $('#pi_imgwrap').style.display = 'none';
  $('#pi_hint').style.display = 'none';
  $('#pi_selbox').style.display = 'none';
  $('#pi_progress').style.display = 'none';
  $('#pi_resultField').style.display = 'none';
  $('#pi_insertBtn').style.display = 'none';
  $('#pi_runBtn').disabled = true;
  if (!piSelectionWired) { piWireSelection(); piSelectionWired = true; }
  $('#photoImportOverlay').classList.add('show');
}
function closePhotoImport() {
  $('#photoImportOverlay').classList.remove('show');
}

/* =====================================================================
   EVENT WIRING
   ===================================================================== */
function wireEvents() {
  $$('.ribbon').forEach(r => r.addEventListener('click', () => {
    state.activeTab = r.dataset.tab; state.search = ''; $('#searchInput').value = ''; state.bookFilter = null; renderAll();
  }));
  $('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; state.bookFilter = null; renderAll(); });
  $('#searchClear').addEventListener('click', () => { state.search = ''; $('#searchInput').value = ''; $('#searchInput').focus(); renderAll(); });
  $('#bfb_clear').addEventListener('click', () => { state.bookFilter = null; renderAll(); });
  $('#fabAdd').addEventListener('click', () => {
    if (state.activeTab === 'reading' && state.bookFilter) {
      openEditorForBook(state.bookFilter.title, state.bookFilter.author);
    } else {
      selectedBookCover = null;
      openEditor(null);
    }
  });
  $('#cancelEditorBtn').addEventListener('click', () => closeEditor());
  $('#saveEntryBtn').addEventListener('click', saveEditor);
  $('#deleteEntryBtn').addEventListener('click', () => {
    if (state.editingId && confirm('이 기록을 삭제할까요?')) { deleteEntry(state.editingId); closeEditor(); toast('삭제되었습니다'); }
  });
  $('#editorOverlay').addEventListener('click', (e) => { if (e.target.id === 'editorOverlay') closeEditor(); });
  $$('#starPicker span').forEach(s => s.addEventListener('click', () => {
    state.rating = (state.rating === +s.dataset.v) ? 0 : +s.dataset.v; renderStars();
  }));

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', () => closeSettings());
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

  // 제목 칸: 몇 글자만 쳐도 실제 책 검색 결과(+내가 예전에 적은 책)가 뜬다.
  // 고르면 저자도 자동으로 채워진다 (저자 칸에 이미 값이 있으면 덮어쓰지 않음).
  setupTitleBookSearch();
  setupAutocomplete('#f_author', '#authorAcList', () => uniqueSorted(e => e.author));

  $('#openPhotoImportBtn').addEventListener('click', openPhotoImport);
  $('#pi_cancelBtn').addEventListener('click', () => closePhotoImport());
  $('#photoImportOverlay').addEventListener('click', (e) => { if (e.target.id === 'photoImportOverlay') closePhotoImport(); });
  $('#pi_file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pi.img = await piLoadImageFile(file);
      pi.sel = null; pi.rect = null; pi.mode = 'none';
      $('#pi_selbox').style.display = 'none';
      $('#pi_runBtn').disabled = true;
      piDrawImage();
      toast('인식하고 싶은 부분을 손가락으로 드래그해서 선택해주세요');
    } catch { toast('사진을 불러오지 못했습니다'); }
  });
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
