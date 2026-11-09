// Domain layer: read-only access to the running eXpress desktop app via its
// in-memory Redux store. Reading metadata and the active chat is side-effect-free;
// opening another chat (readChat) marks it read and may send a read receipt.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { portOpen, evalRenderer } from "./cdp.mjs";

const exec = promisify(execFile);
const DAY_MS = 86_400_000;

async function eXpressPid() {
  try { const { stdout } = await exec("pgrep", ["-x", "eXpress"]); return stdout.trim().split("\n")[0] || null; }
  catch { return null; }
}

// Open the Node inspector on the running app if it is not already listening.
export async function ensureInspector() {
  if (await portOpen()) return;
  const pid = await eXpressPid();
  if (!pid) throw new Error("eXpress is not running — open the desktop app and sign in first.");
  process.kill(Number(pid), "SIGUSR1");
  for (let i = 0; i < 20; i++) { await sleep(400); if (await portOpen()) return; }
  throw new Error("Could not open the eXpress debug inspector.");
}

// Locate the Redux store by walking the React fiber tree and stash it on window.__exr.
const BOOTSTRAP = `(() => {
  if (window.__exr && window.__exr.store) return 'ok';
  const roots = [document.getElementById('root'), ...document.body.children].filter(Boolean);
  let fiber = null;
  for (const el of roots) { const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')); if (k) { fiber = el[k]; break; } }
  while (fiber && fiber.return) fiber = fiber.return;
  let store = null; const stack = [fiber]; let n = 0;
  while (stack.length && n < 200000 && !store) { const f = stack.pop(); if (!f) continue; n++;
    const p = f.memoizedProps;
    if (p && p.store && typeof p.store.getState === 'function' && typeof p.store.dispatch === 'function') store = p.store;
    if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
  }
  if (!store) return 'nostore';
  window.__exr = { store };
  return 'ok';
})()`;

async function boot() {
  await ensureInspector();
  const r = await evalRenderer(BOOTSTRAP);
  if (r !== "ok") throw new Error(`Could not read app state (${r}). Make sure eXpress is open and signed in.`);
}

export async function status() {
  await boot();
  return evalRenderer(`(() => { const st = window.__exr.store.getState();
    return { me: st.user?.name, authStatus: st.user?.authStatus, chats: st.chats.length,
      unread: st.chats.filter(c => c.unreadCounter > 0).length,
      activeChat: st.chats.find(c => c.groupChatId === st.chatRouting?.activeChatId)?.name || null }; })()`);
}

export async function listChats({ query = "", unreadOnly = false, limit = 40 } = {}) {
  await boot();
  return evalRenderer(`(() => { const st = window.__exr.store.getState(); const q = ${JSON.stringify(query.toLowerCase())};
    let cs = st.chats.filter(c => c.active !== false);
    if (${!!unreadOnly}) cs = cs.filter(c => c.unreadCounter > 0);
    if (q) cs = cs.filter(c => (c.fastSearchString || '').includes(q) || (c.name || '').toLowerCase().includes(q));
    cs = cs.sort((a, b) => (b.sortingInsertedAt || 0) - (a.sortingInsertedAt || 0)).slice(0, ${Number(limit)});
    return cs.map(c => ({ id: c.groupChatId, name: c.name, type: c.chatType, members: c.membersCount,
      unread: c.unreadCounter, lastAt: c.lastEventInsertedAt ? new Date(c.lastEventInsertedAt).toISOString().slice(0, 16) : null })); })()`);
}

// Resolve a direct-chat partner by name/transliteration. Returns 0..n candidates (no side effects).
export async function resolvePeople(query) {
  await boot();
  return evalRenderer(`(() => { const st = window.__exr.store.getState(); const q = ${JSON.stringify(String(query).toLowerCase())};
    return st.chats.filter(c => c.chatType === 'chat' && ((c.fastSearchString || '').includes(q) || (c.name || '').toLowerCase().includes(q)))
      .map(c => ({ id: c.groupChatId, name: c.name, unread: c.unreadCounter })); })()`);
}

// Shared renderer-side helpers (message text + attachment descriptor), injected into eval strings.
const MSG_HELPERS = `
  const FILE_KINDS = ['image','document','video','audio','voice','file'];
  const msgText = m => (m.decryptionStatus === 'confirmed' && m.payload && typeof m.payload.body === 'string' && m.payload.body)
    ? m.payload.body : (m.payload && m.payload.body === '' ? '' : '[undecryptable]');
  const attInfo = m => { const t = m.payload && m.payload.type; if (!FILE_KINDS.includes(t)) return null; const f = m.payload.payload || {};
    return { kind: t, fileName: f.fileName || null, size: f.fileSize || null, mime: f.fileMimeType || null, fileId: f.fileId || null, hasImagePreview: !!f.filePreviewBlob }; };
  const mapMsg = (m, me, nameOf) => { const a = attInfo(m); const r = { syncId: m.syncId, time: new Date(m.insertedAt).toISOString().slice(0,16),
    from: m.sender === me ? 'me' : (nameOf(m.sender) || '?'), text: msgText(m) }; if (a) r.attachment = a; if (m.meta && m.meta.threadStarted) r.hasThread = true;
    if (m.payload && m.payload.reply) r.isReply = true; return r; };`;

// Open a chat and read its recent messages (incl. attachment metadata). Scrolls back to cover `sinceDays`
// (beyond the ~1 week initial load) by paging the app's infinite-scroll. SIDE EFFECT: marks the chat read.
export async function readChat({ chatId, sinceDays = 7, fromOpponentOnly = false, limit = 200, maxScrolls = 40 }) {
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    let ok = false;
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); const s = S.getState(); if (s.messages.length && s.messages[0].groupChatId === id) { ok = true; break; } }
    const since = Date.now() - ${Number(sinceDays)} * ${DAY_MS};
    const msgsOf = () => S.getState().messages.filter(m => m.groupChatId === id);
    const oldestTs = () => { const t = msgsOf().map(m => m.insertedAt); return t.length ? Math.min(...t) : Date.now(); };
    // Page older history by scrolling the virtualized message list to the top.
    const findScroll = () => { const row = document.querySelector('.chat-message-row, [class*="chat-message-row"]'); let sc = row;
      while (sc && sc !== document.body) { const st = getComputedStyle(sc); if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight + 10) return sc; sc = sc.parentElement; } return null; };
    let scrolls = 0, exhausted = false;
    while (oldestTs() > since && scrolls < ${Number(maxScrolls)}) {
      const sc = findScroll(); if (!sc) break;
      const before = msgsOf().length;
      sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll', { bubbles: true })); sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -3000, bubbles: true }));
      await new Promise(r => setTimeout(r, 1500)); scrolls++;
      if (msgsOf().length === before) { exhausted = true; break; }
    }
    const scEnd = findScroll(); if (scEnd) scEnd.scrollTop = scEnd.scrollHeight; // leave it scrolled to newest
    const st = S.getState();
    ${MSG_HELPERS}
    const me = st.user?.huid; const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const all = msgsOf();
    let msgs = all.filter(m => m.eventType === 'message_new' && m.insertedAt >= since && !m.deletedAt);
    if (${!!fromOpponentOnly}) msgs = msgs.filter(m => m.sender !== me);
    msgs = msgs.sort((a, b) => a.insertedAt - b.insertedAt).slice(-${Number(limit)});
    const out = msgs.map(m => mapMsg(m, me, nameOf));
    const oldest = all.length ? Math.min(...all.map(m => m.insertedAt)) : null;
    if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return { chat: st.chats.find(c => c.groupChatId === id)?.name, loaded: ok, count: out.length, scrolls, historyExhausted: exhausted,
      oldestLoaded: oldest ? new Date(oldest).toISOString().slice(0, 16) : null,
      coversWholeRange: oldest ? oldest <= since || exhausted : false, messages: out }; })()`;
  return evalRenderer(code);
}

// Open a deep link (xlnk.ms/open/message?sync_id=&chat_id=) and return the target message + surrounding context.
// SIDE EFFECT: opens (marks read) the linked chat.
export async function openLink({ url, context = 5 }) {
  const u = new URL(url);
  const chatId = u.searchParams.get("chat_id") || u.searchParams.get("group_chat_id");
  const syncId = u.searchParams.get("sync_id") || u.searchParams.get("message_id");
  if (!chatId) throw new Error("Link has no chat_id");
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)}; const sync = ${JSON.stringify(syncId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    let st, ok = false;
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); st = S.getState(); if (st.messages.length && st.messages[0].groupChatId === id) { ok = true; break; } }
    st = S.getState();
    ${MSG_HELPERS}
    const me = st.user?.huid; const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const all = st.messages.filter(m => m.groupChatId === id).sort((a,b)=>a.insertedAt-b.insertedAt);
    const idx = all.findIndex(m => m.syncId === sync);
    const ctx = ${Number(context)};
    const slice = idx >= 0 ? all.slice(Math.max(0, idx-ctx), idx+ctx+1) : all.slice(-ctx*2);
    if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return { chat: st.chats.find(c => c.groupChatId === id)?.name, found: idx >= 0, loaded: ok,
      target: idx >= 0 ? mapMsg(all[idx], me, nameOf) : null, context: slice.map(m => mapMsg(m, me, nameOf)) }; })()`;
  return evalRenderer(code);
}

// List the threads that belong to a chat (thread ids + reply counts). Side-effect-free.
export async function listThreads({ chatId }) {
  await boot();
  return evalRenderer(`(() => { const st = window.__exr.store.getState(); const cid = ${JSON.stringify(chatId)};
    const tl = st.threads.threadList || {};
    return Object.entries(tl).filter(([id, t]) => t.parentChatId === cid)
      .map(([id, t]) => ({ threadId: id, replies: t.counter, subscribers: (t.subscribers || []).length })); })()`);
}

// Read a thread's replies. SIDE EFFECT: opens the parent chat (marks it read) and navigates into the thread view.
export async function readThread({ chatId, threadId, limit = 200 }) {
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const chatId = ${JSON.stringify(chatId)}; const threadId = ${JSON.stringify(threadId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + chatId] } });
    for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 500)); if (S.getState().messages[0]?.groupChatId === chatId) break; }
    // Find the mounted ChatContainer to reach navigateToThread.
    const grab = () => { const roots = [document.getElementById('root'), ...document.body.children].filter(Boolean); let fiber = null;
      for (const el of roots) { const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')); if (k) { fiber = el[k]; break; } }
      while (fiber && fiber.return) fiber = fiber.return; let cc = null; const stk = [fiber]; let n = 0;
      while (stk.length && n < 200000 && !cc) { const f = stk.pop(); if (!f) continue; n++; const p = f.memoizedProps; const nm = typeof f.type === 'function' ? (f.type.displayName || f.type.name) : null;
        if (nm === 'ChatContainer' && p && typeof p.navigateToThread === 'function') cc = p; if (f.child) stk.push(f.child); if (f.sibling) stk.push(f.sibling); } return cc; };
    const cc = grab();
    if (!cc) { if (prev) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } }); return { error: 'Could not open thread (chat view not mounted). Try again.' }; }
    // Two-step: bare id initializes the thread view, the object form loads its history.
    try { cc.navigateToThread(threadId); } catch {}
    await new Promise(r => setTimeout(r, 800));
    cc.navigateToThread({ threadId, parentChatId: chatId, chatId });
    const want = (S.getState().threads.threadList?.[threadId]?.counter) || 1;
    let tms = [];
    for (let i = 0; i < 18; i++) { await new Promise(r => setTimeout(r, 500)); tms = S.getState().messages.filter(m => m.groupChatId === threadId); if (tms.length >= want) break; }
    const st = S.getState();
    ${MSG_HELPERS}
    const me = st.user?.huid; const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const out = tms.filter(m => m.eventType === 'message_new' && !m.deletedAt).sort((a, b) => a.insertedAt - b.insertedAt).slice(-${Number(limit)}).map(m => mapMsg(m, me, nameOf));
    if (prev) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return { chat: st.chats.find(c => c.groupChatId === chatId)?.name, threadId, count: out.length, messages: out }; })()`;
  return evalRenderer(code);
}

// Extract an image message's already-decrypted preview thumbnail (base64). SIDE EFFECT: opens the chat if not active.
export async function getImagePreview({ chatId, syncId }) {
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)}; const sync = ${JSON.stringify(syncId)};
    const prev = S.getState().chatRouting?.activeChatId;
    if (prev !== id) { S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
      for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); if (S.getState().messages.some(m=>m.groupChatId===id)) break; } }
    const st = S.getState();
    const m = st.messages.find(x => x.syncId === sync && x.payload && x.payload.payload && x.payload.payload.filePreviewBlob);
    let data = null;
    if (m) { const f = m.payload.payload; const ab = await fetch(f.filePreviewBlob).then(r => r.arrayBuffer());
      let bin = ''; const u8 = new Uint8Array(ab); for (let i=0;i<u8.length;i++) bin += String.fromCharCode(u8[i]);
      data = { mime: f.fileMimeType, fileName: f.fileName, width: f.filePreviewWidth, height: f.filePreviewHeight, base64: btoa(bin) }; }
    if (prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return data; })()`;
  const data = await evalRenderer(code);
  if (!data) return { found: false, note: "No decrypted image preview for that message (only images have previews; must be currently loaded)." };
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = "/tmp/express-reader";
  await mkdir(dir, { recursive: true });
  const buf = Buffer.from(data.base64, "base64");
  // Previews are typically JPEG regardless of the original mime — pick the extension from content.
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : buf[0] === 0x89 && buf[1] === 0x50 ? "png" : "bin";
  const path = join(dir, `${syncId}.${ext}`);
  await writeFile(path, buf);
  return { found: true, path, mime: data.mime, fileName: data.fileName, width: data.width, height: data.height };
}

// Resolve the save directory: explicit `folder` wins, else $EXPRESS_DOWNLOAD_DIR, else ~/Downloads/express-reader.
// A relative value is treated as a subfolder of ~/Downloads (never the Downloads root directly).
async function resolveDownloadDir(folder) {
  const { join, isAbsolute } = await import("node:path");
  const { homedir } = await import("node:os");
  const downloads = join(homedir(), "Downloads");
  const choice = folder || process.env.EXPRESS_DOWNLOAD_DIR || "express-reader";
  return isAbsolute(choice) ? choice : join(downloads, choice);
}

function safeBaseName(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/\x00/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "file";
}

// Download a document/file attachment: let the app decrypt it to an in-memory blob, fetch that blob,
// and save it to the configurable folder. Keys never leave the app. SIDE EFFECT: opens the chat (marks read).
export async function downloadFile({ chatId, syncId, folder }) {
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)}; const sync = ${JSON.stringify(syncId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); if (S.getState().messages.some(m => m.groupChatId === id)) break; }
    const restore = () => { if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } }); };
    let st = S.getState();
    let msg = st.messages.find(m => m.syncId === sync && m.payload && m.payload.payload && m.payload.payload.fileId);
    if (!msg) { restore(); return { error: 'Message not found or has no file attachment in the loaded history.' }; }
    const MAX = 25 * 1024 * 1024;
    if (msg.payload.payload.fileSize > MAX) { restore(); return { error: 'File too large (> 25 MiB).' }; }
    if (!msg.payload.payload.fileBlob) {
      // Find any mounted component exposing the bound loadAttachment action.
      const roots = [document.getElementById('root'), ...document.body.children].filter(Boolean);
      let fiber = null; for (const el of roots) { const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')); if (k) { fiber = el[k]; break; } }
      while (fiber && fiber.return) fiber = fiber.return;
      let la = null; { const stk = [fiber]; let n = 0; while (stk.length && n < 250000 && !la) { const f = stk.pop(); if (!f) continue; n++; const p = f.memoizedProps; if (p && typeof p.loadAttachment === 'function') la = p; if (f.child) stk.push(f.child); if (f.sibling) stk.push(f.sibling); } }
      if (!la) { restore(); return { error: 'Download action unavailable (open the chat first).' }; }
      try { la.loadAttachment({ message: msg }); } catch (e) { restore(); return { error: 'loadAttachment failed: ' + e.message }; }
      for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 500)); const m2 = S.getState().messages.find(m => m.syncId === sync); if (m2?.payload?.payload?.fileBlob) { msg = m2; break; } }
    }
    const f = msg.payload.payload;
    if (!f.fileBlob) { restore(); return { error: 'Download did not complete in time.' }; }
    const ab = await fetch(f.fileBlob).then(r => r.arrayBuffer());
    let bin = ''; const u8 = new Uint8Array(ab); const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    restore();
    return { fileName: f.fileName, mime: f.fileMimeType, size: f.fileSize, declared: ab.byteLength, base64: btoa(bin) }; })()`;
  const data = await evalRenderer(code);
  if (data?.error) return data;
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await resolveDownloadDir(folder);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeBaseName(data.fileName));
  const buf = Buffer.from(data.base64, "base64");
  await writeFile(path, buf);
  return { path, size: buf.length, mime: data.mime, sizeMatches: buf.length === data.size };
}

// Gracefully quit and relaunch the app to unbind the debug port (inspector.close() does not in Electron main).
export async function closeDebug() {
  await exec("osascript", ["-e", 'quit app "eXpress"']);
  for (let i = 0; i < 20; i++) { if (!(await eXpressPid())) break; await sleep(500); }
  await exec("open", ["-a", "eXpress"]);
  return { closed: true, note: "eXpress relaunched; debug port closed." };
}
