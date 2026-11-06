'use strict';
/* 회의 녹음·전사 — 정적 웹앱(PWA). 서버 없음.
 * 녹음 → (구간별) IndexedDB 즉시 보관 → Google Drive 업로드 → 무료 전사 → 녹취록(Google Docs) 저장
 */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const hms = ms => { ms = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(ms / 3600))}:${pad(Math.floor(ms % 3600 / 60))}:${pad(ms % 60)}`; };
const clock = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const dstamp = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/* ---------- 설정 ---------- */
const DEF = { client: '', folder: '회의녹음', engine: 'groq', key: '', model: 'gemini-2.5-flash', gkey: '', gmodel: 'whisper-large-v3', hint: '', rot: 5 };
let cfg = { ...DEF };
try { cfg = { ...DEF, ...JSON.parse(localStorage.getItem('vr_cfg') || '{}') }; } catch (e) {}
function loadSettingsUI() {
  $('s_client').value = cfg.client; $('s_folder').value = cfg.folder; $('s_engine').value = cfg.engine;
  $('s_key').value = cfg.key; $('s_model').value = cfg.model; $('s_rot').value = cfg.rot;
  $('s_gkey').value = cfg.gkey; $('s_gmodel').value = cfg.gmodel; $('s_hint').value = cfg.hint;
}
$('savesettings').onclick = () => {
  cfg = {
    client: $('s_client').value.trim(), folder: $('s_folder').value.trim() || DEF.folder, engine: $('s_engine').value,
    key: $('s_key').value.trim(), model: $('s_model').value.trim() || DEF.model,
    gkey: $('s_gkey').value.trim(), gmodel: $('s_gmodel').value.trim() || DEF.gmodel, hint: $('s_hint').value.trim(),
    rot: Math.min(10, Math.max(1, parseInt($('s_rot').value) || 5)),
  };
  try { localStorage.setItem('vr_cfg', JSON.stringify(cfg)); } catch (e) {}
  tokenClient = null; loadSettingsUI(); setStatus('설정을 저장했습니다'); updateAuthUI();
};
loadSettingsUI();
if (!cfg.client) $('settings').open = true;

/* ---------- IndexedDB ---------- */
const dbp = new Promise((res, rej) => {
  const rq = indexedDB.open('vr', 1);
  rq.onupgradeneeded = () => {
    const d = rq.result;
    const c = d.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true }); c.createIndex('k', ['sid', 'seg']);
    d.createObjectStore('segs', { keyPath: 'key' });
    d.createObjectStore('sess', { keyPath: 'sid' });
  };
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
const rq2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const d = await dbp; const t = d.transaction(stores, mode);
  const out = await fn(t); await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return out;
}
const idbAll = s => tx(s, 'readonly', t => rq2p(t.objectStore(s).getAll()));
const idbGet = (s, k) => tx(s, 'readonly', t => rq2p(t.objectStore(s).get(k)));
const idbPut = (s, v) => tx(s, 'readwrite', t => rq2p(t.objectStore(s).put(v)));
const idbDel = (s, k) => tx(s, 'readwrite', t => rq2p(t.objectStore(s).delete(k)));
// 읽고-수정-쓰기를 한 트랜잭션에서 (동시 갱신 충돌 방지)
const idbUpdate = (s, k, fn) => tx(s, 'readwrite', async t => {
  const st = t.objectStore(s); const v = await rq2p(st.get(k)); if (!v) return null; fn(v); await rq2p(st.put(v)); return v;
});
const addChunk = c => tx('chunks', 'readwrite', t => rq2p(t.objectStore('chunks').add(c)));
const chunksOf = (sid, seg) => tx('chunks', 'readonly', t => rq2p(t.objectStore('chunks').index('k').getAll([sid, seg])));
const delChunks = (sid, seg) => tx('chunks', 'readwrite', t => new Promise((res, rej) => {
  const rq = t.objectStore('chunks').index('k').openKeyCursor(IDBKeyRange.only([sid, seg]));
  rq.onsuccess = () => { const c = rq.result; if (c) { t.objectStore('chunks').delete(c.primaryKey); c.continue(); } else res(); };
  rq.onerror = () => rej(rq.error);
}));

/* ---------- UI 보조 ---------- */
function setStatus(t) { $('status').textContent = t; }
function banner(kind, text) { const b = $('banner'); b.className = 'banner ' + (kind || ''); b.textContent = text || ''; }
$('banner').onclick = () => tryResume();
function log(...a) { console.warn('[vr]', ...a); }

/* ---------- 녹음 ---------- */
const R = { active: false, interrupted: false, resuming: false, muted: false, cur: null, stream: null, track: null, sess: null, seg: 0, mime: '', timers: {}, wake: null, actx: null };

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
const extOf = m => /mp4|m4a/.test(m) ? 'm4a' : /ogg/.test(m) ? 'ogg' : /mpeg|mp3/.test(m) ? 'mp3' : /wav/.test(m) ? 'wav' : /flac/.test(m) ? 'flac' : /aac/.test(m) ? 'aac' : 'webm';

async function acquire() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });   // 노이즈 억제는 먼 목소리를 깎아 전사 정확도를 떨어뜨림
  R.stream = stream; R.track = stream.getAudioTracks()[0];
  R.track.onended = () => handleInterruption('ended');
  R.track.onmute = () => { if (!R.interrupted && !R.muted) { R.muted = true; R.muteStart = Date.now(); banner('warn', '마이크가 잠시 다른 앱(전화 등)에 넘어갔습니다. 돌아오면 이어집니다.'); } };
  R.track.onunmute = () => { if (R.muted) { R.muted = false; addGap(R.muteStart, Date.now()); banner('', ''); } };
  startMeter(stream);
}
function startMeter(stream) {
  try {
    R.actx = R.actx || new (window.AudioContext || window.webkitAudioContext)();
    const an = R.actx.createAnalyser(); an.fftSize = 512;
    R.actx.createMediaStreamSource(stream).connect(an); R.an = an; R.buf = new Uint8Array(an.fftSize);
  } catch (e) { R.an = null; }
}
function meterTick() {
  if (!R.an) { $('lvl').style.width = '0'; return; }
  R.an.getByteTimeDomainData(R.buf); let m = 0; for (const v of R.buf) m = Math.max(m, Math.abs(v - 128));
  $('lvl').style.width = Math.min(100, m / 128 * 220) + '%';
}

function beginSegment() {
  const seg = ++R.seg;
  const opts = { audioBitsPerSecond: 64000 }; if (R.mime) opts.mimeType = R.mime;
  const rec = new MediaRecorder(R.stream, opts);
  const c = { rec, seg, startedAt: Date.now(), pending: [], mime: rec.mimeType || R.mime || 'audio/webm' };
  rec.ondataavailable = e => { if (e.data && e.data.size) c.pending.push(addChunk({ sid: R.sess.sid, seg, t: Date.now(), blob: e.data }).catch(log)); };
  rec.onerror = () => handleInterruption('recorder-error');
  c.stopped = new Promise(res => {
    rec.onstop = async () => {
      await Promise.all(c.pending);
      try { await finalizeSegment(R.sess.sid, seg, c.mime, c.startedAt, Date.now()); } catch (e) { log(e); }
      res();
    };
  });
  rec.start(2000);
  R.cur = c;
}
function endSegment(c) { if (c.rec.state !== 'inactive') { try { c.rec.stop(); } catch (e) {} } return c.stopped; }

async function finalizeSegment(sid, seg, mime, startedAt, endedAt) {
  const ch = await chunksOf(sid, seg); if (!ch.length) return;
  ch.sort((a, b) => a.id - b.id);
  const blob = new Blob(ch.map(x => x.blob), { type: mime });
  await idbPut('segs', { key: `${sid}-${seg}`, sid, seg, mime, startedAt, endedAt, blob, uploaded: false, text: null });
  await delChunks(sid, seg);
  pump();
}

async function rotate() {
  if (!R.active || R.interrupted || !R.cur || R.cur.rec.state !== 'recording') return;
  const old = R.cur; beginSegment(); endSegment(old);   // 새 구간을 먼저 시작해 빈틈을 최소화
}

function addGap(from, to) {
  if (!R.sess) return;
  idbUpdate('sess', R.sess.sid, s => { (s.gaps = s.gaps || []).push({ from, to }); });
}

async function handleInterruption(reason) {
  if (!R.active || R.interrupted) return;
  R.interrupted = true; R.gapStart = Date.now(); R.an = null;
  const c = R.cur; R.cur = null;
  if (c) await endSegment(c);
  try { R.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  banner('err', '마이크가 끊겼습니다(전화·다른 앱 등). 지금까지의 녹음은 안전하게 저장되었습니다. 돌아오면 자동으로 이어서 녹음합니다. 안 되면 여기를 탭하세요.');
  setStatus('녹음 일시 중단 — 재개 대기 중');
  clearInterval(R.timers.retry); R.timers.retry = setInterval(tryResume, 2500);
}
async function tryResume() {
  if (!R.active || !R.interrupted || R.resuming) return;
  R.resuming = true;
  try {
    await acquire();
    R.interrupted = false; addGap(R.gapStart, Date.now());
    beginSegment(); clearInterval(R.timers.retry);
    banner('', ''); setStatus('녹음 중'); requestWake();
  } catch (e) { /* 아직 마이크 사용 불가 */ } finally { R.resuming = false; }
}
async function requestWake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') R.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (!R.active) return;
  if (document.visibilityState === 'visible') { requestWake(); if (R.interrupted) tryResume(); }
});
window.addEventListener('beforeunload', e => { if (R.active) { e.preventDefault(); e.returnValue = ''; } });

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { banner('err', '이 브라우저는 녹음을 지원하지 않습니다. (Chrome/Safari 최신 버전을 사용하세요)'); return; }
  try { await acquire(); } catch (e) { banner('err', '마이크 권한이 필요합니다: ' + (e.message || e)); return; }
  R.mime = pickMime(); R.seg = 0; R.interrupted = false; R.muted = false;
  const now = Date.now();
  R.sess = { sid: 's' + now, title: $('title').value.trim(), startedAt: now, endedAt: null, status: 'rec', mime: R.mime, gaps: [], folderId: null, docId: null, docText: '' };
  await idbPut('sess', R.sess);
  R.active = true; beginSegment(); requestWake();
  R.timers.rot = setInterval(rotate, cfg.rot * 60000);
  R.timers.tick = setInterval(() => { $('timer').textContent = hms(Date.now() - R.sess.startedAt); meterTick(); }, 200);
  R.timers.dog = setInterval(() => {   // 감시: 트랙/녹음기가 조용히 죽었는지 확인
    if (!R.active || R.interrupted) return;
    if (R.track && R.track.readyState === 'ended') handleInterruption('watchdog-track');
    else if (R.cur && R.cur.rec.state === 'inactive') handleInterruption('watchdog-recorder');
  }, 4000);
  $('recbtn').textContent = '정지'; $('recbtn').classList.add('on'); $('title').disabled = true;
  setStatus('녹음 중'); banner('', '');
}
async function stopRecording() {
  R.active = false;
  Object.values(R.timers).forEach(t => clearInterval(t)); R.timers = {};
  const c = R.cur; R.cur = null;
  if (c) await endSegment(c);
  try { R.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { R.wake && R.wake.release(); } catch (e) {}
  if (R.interrupted) addGap(R.gapStart, Date.now());
  R.an = null; $('lvl').style.width = '0';
  await idbUpdate('sess', R.sess.sid, s => { s.status = 'done'; s.endedAt = Date.now(); });
  $('recbtn').textContent = '녹음 시작'; $('recbtn').classList.remove('on'); $('title').disabled = false; $('title').value = '';
  banner('', ''); setStatus('녹음 종료 — 저장·전사 처리 중…');
  pump();
}
$('recbtn').onclick = () => (R.active ? stopRecording() : startRecording());

/* ---------- Google 인증 (GIS 토큰 방식, 서버 불필요) ---------- */
let tokenClient = null, tok = null, lastSilent = 0;
try { tok = JSON.parse(localStorage.getItem('vr_tok') || 'null'); } catch (e) {}
function ensureTC() {
  if (tokenClient) return true;
  if (!cfg.client || !window.google || !google.accounts) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({ client_id: cfg.client, scope: SCOPE, callback: () => {} });
  return true;
}
function tokenValid() { return tok && tok.exp - 60000 > Date.now(); }
function requestToken(prompt) {
  return new Promise(res => {
    if (!ensureTC()) return res(null);
    const to = setTimeout(() => res(null), prompt === '' ? 12000 : 120000);
    tokenClient.callback = r => {
      clearTimeout(to);
      if (r && r.access_token) {
        tok = { t: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
        try { localStorage.setItem('vr_tok', JSON.stringify(tok)); localStorage.setItem('vr_signed', '1'); } catch (e) {}
        res(tok.t);
      } else res(null);
    };
    tokenClient.error_callback = () => { clearTimeout(to); res(null); };
    tokenClient.requestAccessToken({ prompt });
  });
}
async function getToken() {
  if (tokenValid()) return tok.t;
  let signed = false; try { signed = localStorage.getItem('vr_signed') === '1'; } catch (e) {}
  if (signed && Date.now() - lastSilent > 60000) { lastSilent = Date.now(); const t = await requestToken(''); updateAuthUI(); return t; }
  return null;
}
function updateAuthUI() {
  const ok = tokenValid(); const p = $('authpill');
  p.textContent = ok ? 'Drive 연결됨' : 'Drive 미연결'; p.className = 'pill ' + (ok ? 'ok' : 'bad');
  $('drivestate').textContent = ok ? `저장 폴더: 내 드라이브 / ${cfg.folder}` : (cfg.client ? '로그인하면 자동 저장됩니다 (로그인 전에도 녹음은 이 기기에 안전하게 보관)' : '설정에서 OAuth 클라이언트 ID를 먼저 입력하세요');
}
$('loginbtn').onclick = async () => {
  if (!cfg.client) { $('settings').open = true; banner('warn', 'OAuth 클라이언트 ID를 먼저 입력하세요 (README 참고)'); return; }
  if (!ensureTC()) { banner('warn', 'Google 로그인 스크립트를 불러오는 중입니다. 잠시 후 다시 시도하세요.'); return; }
  const t = await requestToken(''); const t2 = t || await requestToken('consent');
  updateAuthUI(); if (t2) pump();
};
$('logoutbtn').onclick = () => {
  try { if (tok && window.google) google.accounts.oauth2.revoke(tok.t, () => {}); localStorage.removeItem('vr_tok'); localStorage.removeItem('vr_signed'); } catch (e) {}
  tok = null; updateAuthUI();
};
setInterval(updateAuthUI, 20000);

/* ---------- Drive ---------- */
async function dfetch(url, opts = {}, token) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401) { tok = null; try { localStorage.removeItem('vr_tok'); } catch (e) {} updateAuthUI(); throw new Error('Google 로그인이 만료되었습니다'); }
  if (!r.ok) throw new Error('Drive 오류 ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}
const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function ensureFolder(name, parent, token) {
  let qq = `name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parent) qq += ` and '${parent}' in parents`;
  const r = await (await dfetch('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(qq), {}, token)).json();
  if (r.files && r.files[0]) return r.files[0].id;
  const body = { name, mimeType: 'application/vnd.google-apps.folder' }; if (parent) body.parents = [parent];
  return (await (await dfetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, token)).json()).id;
}
function sessName(s) { return `${dstamp(s.startedAt)} ${s.title || '회의'}`; }
async function ensureSessionFolder(s, token) {
  if (s.folderId) return s.folderId;
  const root = await ensureFolder(cfg.folder, null, token);
  const id = await ensureFolder(sessName(s), root, token);
  await idbUpdate('sess', s.sid, x => { x.folderId = id; }); s.folderId = id; return id;
}
async function multipart(meta, blob, mime, token) {
  const b = 'vrb' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await dfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body }, token);
  return (await r.json()).id;
}
async function uploadSeg(s, g, token) {
  const name = g.name || `${sessName(s)}_${pad(g.seg)}.${extOf(g.mime)}`;
  return multipart({ name, parents: [s.folderId] }, g.blob, g.mime.split(';')[0], token);
}
async function upsertDoc(s, text, token) {
  const folder = await ensureSessionFolder(s, token);
  if (!s.docId) {
    const id = await multipart({ name: `${sessName(s)} 녹취록`, parents: [folder], mimeType: 'application/vnd.google-apps.document' }, new Blob([text], { type: 'text/plain' }), 'text/plain', token);
    await idbUpdate('sess', s.sid, x => { x.docId = id; }); s.docId = id;
  } else {
    await dfetch(`https://www.googleapis.com/upload/drive/v3/files/${s.docId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: new Blob([text], { type: 'text/plain' }) }, token);
  }
}

/* ---------- 전사 ---------- */
async function decode16k(blob) {
  const ab = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  let ac; try { ac = new AC({ sampleRate: 16000 }); } catch (e) { ac = new AC(); }   // 16kHz로 바로 디코딩해 긴 파일의 메모리 사용을 줄임
  const buf = await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  try { ac.close(); } catch (e) {}
  if (buf.sampleRate === 16000) {
    const n = buf.numberOfChannels, out = new Float32Array(buf.length);
    for (let c = 0; c < n; c++) { const d = buf.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += d[i] / n; }
    return out;
  }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
function normalizeVolume(pcm) {
  let sum = 0, n = 0; for (let i = 0; i < pcm.length; i += 7) { sum += pcm[i] * pcm[i]; n++; }
  const rms = Math.sqrt(sum / Math.max(1, n)); if (!rms) return;
  const gain = Math.min(8, 0.08 / rms); if (gain < 1.2) return;
  for (let i = 0; i < pcm.length; i++) { const v = pcm[i] * gain; pcm[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
}
function toWav(f32) {
  const b = new ArrayBuffer(44 + f32.length * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) { const x = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([b], { type: 'audio/wav' });
}
const b64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

async function transcribeGemini(g, prevTail) {
  if (!cfg.key) throw new Error('설정에서 Gemini API 키를 입력하세요');
  const wav = toWav(await decode16k(g.blob));
  if (wav.size > 14.5e6) throw new Error('구간이 너무 깁니다. 설정에서 분할 간격을 줄이세요');
  const prompt = '다음은 한국어 회의 녹음의 일부입니다. 들리는 그대로 정확하게 받아 적으세요. ' +
    '화자가 바뀔 때마다 줄을 바꾸고 "화자1:", "화자2:" 형식으로 표기하며, 같은 사람은 같은 번호를 유지하세요. ' +
    '요약하거나 내용을 지어내지 말고, 말이 없거나 알아들을 수 없는 부분은 생략하세요. 음성이 전혀 없으면 "(음성 없음)"만 출력하세요.' +
    (prevTail ? `\n\n[직전 구간의 마지막 부분 — 화자 번호를 이어가기 위한 참고용, 출력하지 말 것]\n${prevTail}` : '');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: await b64(wav) } }] }], generationConfig: { temperature: 0 } }),
  });
  if (!r.ok) throw new Error('Gemini 오류 ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
  if (!t) throw new Error('Gemini가 빈 응답을 반환했습니다');
  return t;
}
async function transcribeGroq(g, prevTail) {
  if (!cfg.gkey) throw new Error('설정에서 Groq API 키를 입력하세요');
  if (g.blob.size > 24e6) throw new Error('구간 파일이 너무 큽니다. 분할 간격을 줄이세요');
  const fd = new FormData();
  fd.append('file', g.blob, `seg.${g.ext || extOf(g.mime)}`);
  fd.append('model', cfg.gmodel);
  fd.append('language', 'ko');
  fd.append('temperature', '0');
  fd.append('response_format', 'verbose_json');
  // 직전 전사문을 prompt로 넘기면 반복 환각이 번지기 쉬워서, 사용자가 적은 용어 힌트만 사용
  fd.append('prompt', ('회의 녹음입니다. ' + (cfg.hint ? '용어: ' + cfg.hint : '')).slice(0, 220));
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.gkey }, body: fd });
  if (r.status === 429) throw new Error('Groq 무료 한도에 도달했습니다. 잠시 후 자동 재시도합니다');
  if (!r.ok) throw new Error('Groq 오류 ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  // 무음 구간에서 Whisper가 지어내는 문장(환각) 제거
  // 무음 환각 + 같은 말이 반복되는 구간(compression_ratio 높음) 제거
  const parts = (j.segments || []).filter(s => !(s.no_speech_prob > 0.7) && !(s.compression_ratio > 2.4)).map(s => s.text.trim()).filter(Boolean);
  const t = (j.segments ? parts.join(' ') : (j.text || '')).trim();
  return t || '(음성 없음)';
}
let asr = null;
async function transcribeWhisper(g) {
  if (!asr) {
    setStatus('Whisper 모델 준비 중… (최초 1회 약 250MB 다운로드)');
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/+esm');
    asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
      device: navigator.gpu ? 'webgpu' : 'wasm',
      progress_callback: p => { if (p.status === 'progress') setStatus(`모델 다운로드 ${Math.round(p.progress || 0)}%`); },
    });
  }
  setStatus('전사 중…');
  const out = await asr(await decode16k(g.blob), { language: 'korean', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return (out.text || '').trim() || '(음성 없음)';
}

function buildTranscript(s, segs) {
  const done = segs.filter(g => g.text);
  if (!done.length) return '';
  let t = `${s.title || '회의'}\n` + (s.srcName ? `원본 파일: ${s.srcName}\n\n` : `녹음 시작: ${new Date(s.startedAt).toLocaleString('ko-KR')}\n\n`);
  for (const g of done) t += `[${hms(g.startedAt - s.startedAt)}]\n${g.text.trim()}\n\n`;
  if (s.gaps && s.gaps.length) t += '※ 녹음 중단 구간(전화·다른 앱 등): ' + s.gaps.map(x => `${clock(x.from)}~${clock(x.to)}`).join(', ') + '\n';
  return t.trim() + '\n';
}

/* ---------- 파이프라인: 업로드 → 전사 → 녹취록 ---------- */
let pumping = false, again = false;
async function pump() {
  if (pumping) { again = true; return; }
  pumping = true;
  try { do { again = false; await pumpOnce(); } while (again); } catch (e) { log(e); } finally { pumping = false; renderSessions(); }
}
async function pumpOnce() {
  const sessions = (await idbAll('sess')).sort((a, b) => a.startedAt - b.startedAt);
  const allSegs = await idbAll('segs');
  for (const s0 of sessions) {
    let s = s0;
    const segs = allSegs.filter(x => x.sid === s.sid).sort((a, b) => a.seg - b.seg);
    // 1) Drive 업로드
    for (const g of segs) {
      if (g.uploaded) continue;
      const token = await getToken(); if (!token) break;
      try {
        await ensureSessionFolder(s, token);
        g.driveId = await uploadSeg(s, g, token); g.uploaded = true; await idbPut('segs', g);
      } catch (e) { log(e); $('queue').textContent = 'Drive 저장 재시도 대기: ' + e.message; break; }
    }
    // 2) 전사 (Whisper는 녹음 중 부하 때문에 종료 후 실행)
    if (cfg.engine !== 'none') {
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        if (g.text != null) continue;
        if (g.errAt && Date.now() - g.errAt < 60000) continue;
        if (cfg.engine === 'whisper' && R.active) break;
        try {
          setStatus(`전사 중… (구간 ${g.seg}/${segs.filter(x => !x.src).length})`);
          const prev = i > 0 && segs[i - 1].text ? segs[i - 1].text.slice(-400) : '';
          g.text = cfg.engine === 'groq' ? await transcribeGroq(g, prev)
            : cfg.engine === 'gemini' ? await transcribeGemini(g, prev) : await transcribeWhisper(g);
          g.err = null; if (g.slice) g.blob = null;   // 가져온 파일의 임시 WAV 조각은 전사 후 삭제(원본은 보관)
          await idbPut('segs', g);
          renderSessions();
        } catch (e) { g.err = String(e.message || e); g.errAt = Date.now(); await idbPut('segs', g); banner('warn', '전사 오류: ' + g.err + ' (1분 후 자동 재시도)'); }
      }
    }
    // 3) 녹취록 Google Docs
    s = await idbGet('sess', s.sid);
    const text = buildTranscript(s, segs.map(g => allSegs.find(x => x.key === g.key) && g));
    if (text && text !== s.docText) {
      const token = await getToken();
      if (token) {
        try { await upsertDoc(s, text, token); await idbUpdate('sess', s.sid, x => { x.docText = text; }); }
        catch (e) { log(e); $('queue').textContent = '녹취록 저장 재시도 대기: ' + e.message; }
      }
    }
  }
  const pend = (await idbAll('segs')).filter(g => !g.uploaded).length;
  $('queue').textContent = pend ? `Drive 업로드 대기 ${pend}건` : '';
  if (!R.active) setStatus('대기 중');
}
setInterval(() => { if (!pumping) pump(); }, 30000);
window.addEventListener('online', pump);

/* ---------- 기록 목록 ---------- */
const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
async function renderSessions() {
  const box = $('sessions'); const sessions = (await idbAll('sess')).sort((a, b) => b.startedAt - a.startedAt);
  const allSegs = await idbAll('segs'); box.textContent = '';
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '아직 기록이 없습니다.'; box.appendChild(p); return; }
  for (const s of sessions) {
    const segs = allSegs.filter(g => g.sid === s.sid).sort((a, b) => a.seg - b.seg);
    const text = buildTranscript(s, segs);
    const up = segs.filter(g => g.uploaded).length, tr = segs.filter(g => g.text).length;
    const card = document.createElement('div'); card.className = 'card sess';
    const h = document.createElement('h3'); h.textContent = sessName(s); card.appendChild(h);
    const sm = document.createElement('small');
    sm.textContent = `${s.status === 'rec' ? '녹음 중 · ' : ''}${hms((s.endedAt || Date.now()) - s.startedAt)} · 구간 ${segs.length}개`; card.appendChild(sm);
    const pills = document.createElement('div'); pills.className = 'row'; pills.style.margin = '8px 0';
    const pill = (t, ok) => { const p = document.createElement('span'); p.className = 'pill ' + (ok ? 'ok' : ''); p.textContent = t; pills.appendChild(p); };
    pill(`Drive ${up}/${segs.length}`, up === segs.length && segs.length > 0);
    if (cfg.engine !== 'none') pill(`전사 ${tr}/${segs.length}`, tr === segs.length && segs.length > 0);
    if (s.docId) pill('녹취록 Docs 저장됨', true);
    card.appendChild(pills);
    const row = document.createElement('div'); row.className = 'row';
    const btn = (label, fn, sec) => { const b = document.createElement('button'); b.textContent = label; if (sec !== false) b.className = 'sec'; b.onclick = fn; row.appendChild(b); return b; };
    if (text) {
      const pre = document.createElement('pre'); pre.textContent = text; pre.hidden = true;
      btn('녹취록 보기', () => { pre.hidden = !pre.hidden; });
      btn('녹취록 .txt', () => dl(new Blob([text], { type: 'text/plain' }), sessName(s) + ' 녹취록.txt'));
      card.appendChild(row); card.appendChild(pre);
    } else card.appendChild(row);
    const row2 = document.createElement('div'); row2.className = 'row'; row2.style.marginTop = '8px'; card.appendChild(row2);
    segs.filter(g => !g.slice).forEach(g => { const b = document.createElement('button'); b.className = 'sec'; b.textContent = g.src ? '원본 파일' : `음성 ${g.seg}`; b.onclick = () => dl(g.blob, g.name || `${sessName(s)}_${pad(g.seg)}.${extOf(g.mime)}`); row2.appendChild(b); });
    if (s.folderId) { const a = document.createElement('a'); a.href = 'https://drive.google.com/drive/folders/' + s.folderId; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Drive 폴더 열기'; a.className = 'hint'; row2.appendChild(a); }
    const row3 = document.createElement('div'); row3.className = 'row'; row3.style.marginTop = '8px'; card.appendChild(row3);
    const b1 = document.createElement('button'); b1.className = 'sec'; b1.textContent = '다시 전사';
    b1.onclick = async () => { for (const g of segs) { g.text = null; g.errAt = 0; await idbPut('segs', g); } await idbUpdate('sess', s.sid, x => { x.docText = ''; }); pump(); renderSessions(); };
    const b2 = document.createElement('button'); b2.className = 'sec'; b2.textContent = '이 기기에서 삭제';
    b2.onclick = async () => {
      if (!confirm('이 기기에 저장된 사본만 삭제합니다 (Drive에 올라간 파일은 유지). 업로드되지 않은 구간이 있으면 영구 손실됩니다. 삭제할까요?')) return;
      for (const g of segs) await idbDel('segs', g.key); await idbDel('sess', s.sid); renderSessions();
    };
    if (s.status !== 'rec') { if (!segs.some(g => g.slice)) row3.appendChild(b1); row3.appendChild(b2); }
    box.appendChild(card);
  }
}

/* ---------- 음성 파일 가져와 전사 ---------- */
$('filebtn').onclick = () => $('fileinp').click();
$('fileinp').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); };
async function importFile(f) {
  if (R.active) { banner('warn', '녹음 중에는 파일을 가져올 수 없습니다.'); return; }
  if (cfg.engine === 'none') { banner('warn', '설정에서 전사 방식을 먼저 선택하세요.'); $('settings').open = true; return; }
  banner('', ''); setStatus('파일 분석 중… (긴 파일은 몇 분 걸릴 수 있습니다)');
  const now = Date.now(), sid = 's' + now, mimeSrc = f.type || 'audio/mpeg', ext = (f.name.split('.').pop() || 'mp3').toLowerCase();
  let slices = [], dur = 0;
  try {
    const pcm = await decode16k(f); dur = pcm.length / 16000 * 1000;
    normalizeVolume(pcm);   // 작게 녹음된(멀리서 녹음한) 파일의 음량을 키워 인식률 개선
    const step = Math.round((cfg.engine === 'gemini' ? Math.min(cfg.rot, 6) : cfg.rot) * 60 * 16000);
    for (let o = 0, i = 1; o < pcm.length; o += step, i++) slices.push({ i, off: o / 16000 * 1000, blob: toWav(pcm.subarray(o, Math.min(pcm.length, o + step))) });
  } catch (err) {
    if (cfg.engine === 'groq' && f.size <= 24e6) slices = [{ i: 1, off: 0, raw: true }];   // 디코딩 실패 시 원본을 그대로 전송
    else { banner('err', '파일을 읽을 수 없습니다 (지원하지 않는 형식이거나 메모리 부족): ' + (err.message || err)); setStatus('대기 중'); return; }
  }
  if (!slices.length) { banner('err', '오디오 내용이 비어 있습니다.'); setStatus('대기 중'); return; }
  await idbPut('sess', { sid, title: f.name.replace(/\.[^.]+$/, ''), startedAt: now, endedAt: now + dur, status: 'done', mime: mimeSrc, gaps: [], folderId: null, docId: null, docText: '', srcName: f.name });
  const raw = slices[0].raw;
  if (!raw) await idbPut('segs', { key: `${sid}-0`, sid, seg: 0, mime: mimeSrc, startedAt: now, endedAt: now, blob: f, uploaded: false, text: '', src: true, name: f.name });
  for (const sl of slices) {
    await idbPut('segs', raw
      ? { key: `${sid}-1`, sid, seg: 1, mime: mimeSrc, ext, startedAt: now, endedAt: now, blob: f, uploaded: false, text: null, name: f.name }
      : { key: `${sid}-${sl.i}`, sid, seg: sl.i, mime: 'audio/wav', ext: 'wav', startedAt: now + sl.off, endedAt: now + sl.off, blob: sl.blob, uploaded: true, slice: true, text: null });
  }
  await renderSessions(); setStatus(`전사 대기 — ${slices.length}개 구간`); pump();
}

/* ---------- 시작 시: 비정상 종료 복구 ---------- */
async function recover() {
  const chunks = await tx('chunks', 'readonly', t => rq2p(t.objectStore('chunks').getAll()));
  const groups = {};
  chunks.forEach(c => { (groups[c.sid + '|' + c.seg] = groups[c.sid + '|' + c.seg] || []).push(c); });
  for (const k of Object.keys(groups)) {
    const [sid, seg] = k.split('|'); const g = groups[k]; const s = await idbGet('sess', sid);
    const t0 = Math.min(...g.map(c => c.t)) - 2000, t1 = Math.max(...g.map(c => c.t));
    await finalizeSegment(sid, Number(seg), (s && s.mime) || 'audio/webm', t0, t1);
  }
  for (const s of await idbAll('sess')) {
    if (s.status === 'rec' && !R.active) {
      const segs = (await idbAll('segs')).filter(x => x.sid === s.sid);
      await idbUpdate('sess', s.sid, x => { x.status = 'done'; x.endedAt = Math.max(x.startedAt, ...segs.map(y => y.endedAt || 0)); });
    }
  }
}
(async () => {
  try { await recover(); } catch (e) { log(e); }
  updateAuthUI(); await renderSessions(); pump();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
})();
