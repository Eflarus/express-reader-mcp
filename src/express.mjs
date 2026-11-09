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

// Open a chat and read its recent messages (incl. attachment metadata). SIDE EFFECT: marks the chat read.
export async function readChat({ chatId, sinceDays = 7, fromOpponentOnly = false, limit = 200 }) {
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    let st, ok = false;
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); st = S.getState(); if (st.messages.length && st.messages[0].groupChatId === id) { ok = true; break; } }
    st = S.getState();
    ${MSG_HELPERS}
    const me = st.user?.huid; const since = Date.now() - ${Number(sinceDays)} * ${DAY_MS};
    const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const all = st.messages.filter(m => m.groupChatId === id);
    let msgs = all.filter(m => m.eventType === 'message_new' && m.insertedAt >= since && !m.deletedAt);
    if (${!!fromOpponentOnly}) msgs = msgs.filter(m => m.sender !== me);
    msgs = msgs.sort((a, b) => a.insertedAt - b.insertedAt).slice(-${Number(limit)});
    const out = msgs.map(m => mapMsg(m, me, nameOf));
    const oldest = all.length ? Math.min(...all.map(m => m.insertedAt)) : null;
    if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return { chat: st.chats.find(c => c.groupChatId === id)?.name, loaded: ok, count: out.length,
      oldestLoaded: oldest ? new Date(oldest).toISOString().slice(0, 16) : null,
      coversWholeRange: oldest ? oldest <= since : false, messages: out }; })()`;
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

// Gracefully quit and relaunch the app to unbind the debug port (inspector.close() does not in Electron main).
export async function closeDebug() {
  await exec("osascript", ["-e", 'quit app "eXpress"']);
  for (let i = 0; i < 20; i++) { if (!(await eXpressPid())) break; await sleep(500); }
  await exec("open", ["-a", "eXpress"]);
  return { closed: true, note: "eXpress relaunched; debug port closed." };
}
