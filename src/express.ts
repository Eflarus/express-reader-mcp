// Domain layer: read-only access to the running eXpress desktop app via its
// in-memory Redux store. Reading metadata and the active chat is side-effect-free;
// opening another chat (readChat) marks it read and may send a read receipt.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { portOpen, evalRenderer } from "./cdp.js";

const exec = promisify(execFile);
const DAY_MS = 86_400_000;

// Per-tool eval budgets. These MUST exceed the renderer-side wait loops inside each
// tool, otherwise cdp.ts closes the socket while the app is still working (the old
// single 25s wall killed attachment downloads that fetch+decrypt from the server).
const DOWNLOAD_TIMEOUT_MS = 90_000; // open(≤7s) + loadMessageFile poll(≤40s) + server fetch/decrypt + base64
const SEARCH_TIMEOUT_MS = 45_000; // open(≤7s) + toggle retries + result poll(≤12s)
const THREAD_TIMEOUT_MS = 45_000; // open(≤6s) + navigateToThread waits + reply poll(≤9s)
const READ_BASE_TIMEOUT_MS = 20_000; // open + filtering + final scroll-to-bottom
const SCROLL_PAGE_BUDGET_MS = 2_000; // per history page scrolled (inner sleep is 1.5s)

// ---- Public result shapes ------------------------------------------------

export interface Attachment {
  kind: string;
  fileName: string | null;
  size: number | null;
  mime: string | null;
  fileId: string | null;
  hasImagePreview: boolean;
}

export interface Message {
  syncId: string;
  time: string;
  from: string;
  text: string;
  attachment?: Attachment;
  hasThread?: boolean;
  isReply?: boolean;
}

export interface StatusResult {
  me: string | null;
  authStatus: string | null;
  chats: number;
  unread: number;
  activeChat: string | null;
}

export interface ChatInfo {
  id: string;
  name: string;
  type: string;
  members: number;
  unread: number;
  lastAt: string | null;
}

export interface Person {
  id: string;
  name: string;
  unread: number;
}

export interface SearchResult {
  chat: string | null;
  query: string;
  matched: number;
  count: number;
  truncated: boolean;
  messages: Message[];
}

export interface ReadResult {
  chat: string | null;
  loaded: boolean;
  count: number;
  scrolls: number;
  historyExhausted: boolean;
  oldestLoaded: string | null;
  coversWholeRange: boolean;
  messages: Message[];
}

export interface LinkResult {
  chat: string | null;
  found: boolean;
  loaded: boolean;
  target: Message | null;
  context: Message[];
}

export interface ThreadInfo {
  threadId: string;
  replies: number;
  subscribers: number;
}

export interface ThreadResult {
  chat: string | null;
  threadId: string;
  count: number;
  messages: Message[];
}

export interface ImageResult {
  found: boolean;
  path?: string;
  mime?: string;
  fileName?: string;
  width?: number;
  height?: number;
  note?: string;
}

export interface DownloadResult {
  path: string;
  size: number;
  mime: string;
  sizeMatches: boolean;
}

export interface CloseResult {
  closed: boolean;
  note: string;
}

export interface ErrorResult {
  error: string;
}

// Internal blob shapes returned from the renderer.
interface ImagePreviewBlob {
  mime: string;
  fileName: string;
  width: number;
  height: number;
  base64: string;
}

interface DownloadBlob {
  fileName: string;
  mime: string;
  size: number;
  declared: number;
  base64: string;
}

// ---- Options -------------------------------------------------------------

export interface ListChatsOptions {
  query?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface SearchOptions {
  chatId: string;
  query: string;
  sinceDays?: number;
  limit?: number;
}

export interface ReadChatOptions {
  chatId: string;
  sinceDays?: number;
  fromOpponentOnly?: boolean;
  limit?: number;
  maxScrolls?: number;
}

export interface OpenLinkOptions {
  url: string;
  context?: number;
}

export interface ReadThreadOptions {
  chatId: string;
  threadId: string;
  limit?: number;
}

export interface DownloadOptions {
  chatId: string;
  syncId: string;
  folder?: string;
}

// ---- Inspector bootstrap -------------------------------------------------

async function eXpressPid(): Promise<string | null> {
  try {
    const { stdout } = await exec("pgrep", ["-x", "eXpress"]);
    return stdout.toString().trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

// Open the Node inspector on the running app if it is not already listening.
export async function ensureInspector(): Promise<void> {
  if (await portOpen()) return;
  const pid = await eXpressPid();
  if (!pid) throw new Error("eXpress is not running — open the desktop app and sign in first.");
  process.kill(Number(pid), "SIGUSR1");
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (await portOpen()) return;
  }
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

async function boot(): Promise<void> {
  await ensureInspector();
  const r = await evalRenderer(BOOTSTRAP);
  if (r !== "ok") throw new Error(`Could not read app state (${String(r)}). Make sure eXpress is open and signed in.`);
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

// ---- Read-only queries ---------------------------------------------------

export async function status(): Promise<StatusResult> {
  await boot();
  return evalRenderer<StatusResult>(`(() => { const st = window.__exr.store.getState();
    return { me: st.user?.name ?? null, authStatus: st.user?.authStatus ?? null, chats: st.chats.length,
      unread: st.chats.filter(c => c.unreadCounter > 0).length,
      activeChat: st.chats.find(c => c.groupChatId === st.chatRouting?.activeChatId)?.name || null }; })()`);
}

export async function listChats(opts: ListChatsOptions = {}): Promise<ChatInfo[]> {
  const { query = "", unreadOnly = false, limit = 40 } = opts;
  await boot();
  return evalRenderer<ChatInfo[]>(`(() => { const st = window.__exr.store.getState(); const q = ${JSON.stringify(query.toLowerCase())};
    let cs = st.chats.filter(c => c.active !== false);
    if (${String(unreadOnly)}) cs = cs.filter(c => c.unreadCounter > 0);
    if (q) cs = cs.filter(c => (c.fastSearchString || '').includes(q) || (c.name || '').toLowerCase().includes(q));
    cs = cs.sort((a, b) => (b.sortingInsertedAt || 0) - (a.sortingInsertedAt || 0)).slice(0, ${Number(limit)});
    return cs.map(c => ({ id: c.groupChatId, name: c.name, type: c.chatType, members: c.membersCount,
      unread: c.unreadCounter, lastAt: c.lastEventInsertedAt ? new Date(c.lastEventInsertedAt).toISOString().slice(0, 16) : null })); })()`);
}

// Resolve a direct-chat partner by name/transliteration. Returns 0..n candidates (no side effects).
export async function resolvePeople(query: string): Promise<Person[]> {
  await boot();
  return evalRenderer<Person[]>(`(() => { const st = window.__exr.store.getState(); const q = ${JSON.stringify(String(query).toLowerCase())};
    return st.chats.filter(c => c.chatType === 'chat' && ((c.fastSearchString || '').includes(q) || (c.name || '').toLowerCase().includes(q)))
      .map(c => ({ id: c.groupChatId, name: c.name, unread: c.unreadCounter })); })()`);
}

// Native server-side search within a chat (drives the app's in-chat search UI). Searches ALL history,
// not just loaded messages. SIDE EFFECT: opens the chat (marks it read).
export async function searchMessages(opts: SearchOptions): Promise<SearchResult | ErrorResult> {
  const { chatId, query, sinceDays = 0, limit = 100 } = opts;
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)}; const q = ${JSON.stringify(String(query))};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); if (S.getState().messages[0]?.groupChatId === id) break; }
    const restore = () => { if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } }); };
    const roots = [document.getElementById('root'), ...document.body.children].filter(Boolean);
    const grab = (name, prop) => { let f = null; for (const el of roots) { const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')); if (k) { f = el[k]; break; } }
      while (f && f.return) f = f.return; let hit = null; const stk = [f]; let n = 0;
      while (stk.length && n < 200000 && !hit) { const x = stk.pop(); if (!x) continue; n++; const p = x.memoizedProps; const nm = typeof x.type === 'function' ? (x.type.displayName || x.type.name) : null;
        if (nm === name && p && typeof p[prop] === 'function') hit = p; if (x.child) stk.push(x.child); if (x.sibling) stk.push(x.sibling); } return hit; };
    const header = grab('ChatHeader', 'onToggleSearchChatHistory');
    if (!header) { restore(); return { error: 'Search unavailable (chat header not mounted). Try again.' }; }
    // Toggle until the search input is visible (robust to the box already being open/closed).
    let si = null;
    for (let t = 0; t < 4 && !si; t++) {
      const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null);
      si = inputs.find(el => /поиск|search|найти/i.test((el.placeholder || '') + (el.getAttribute('aria-label') || '')));
      if (si) break;
      try { header.onToggleSearchChatHistory(true); } catch (e) {}
      await new Promise(r => setTimeout(r, 700));
    }
    if (!si) { restore(); return { error: 'Search input not found.' }; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(si, q); si.dispatchEvent(new Event('input', { bubbles: true }));
    si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    si.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    // Wait for results to arrive and stabilize.
    let arr = [], stable = 0, last = -1;
    for (let i = 0; i < 24; i++) { await new Promise(r => setTimeout(r, 500)); arr = S.getState().searchMessages[id] || []; if (arr.length === last) { if (++stable >= 3) break; } else { stable = 0; last = arr.length; } }
    ${MSG_HELPERS}
    const st = S.getState(); const me = st.user?.huid; const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const since = ${Number(sinceDays)} > 0 ? Date.now() - ${Number(sinceDays)} * ${DAY_MS} : 0;
    let matches = arr.filter(m => m.eventType === 'message_new' && !m.deletedAt && (!since || m.insertedAt >= since));
    matches.sort((a, b) => a.insertedAt - b.insertedAt);
    const out = matches.slice(-${Number(limit)}).map(m => mapMsg(m, me, nameOf));
    try { header.onToggleSearchChatHistory(false); } catch (e) {}
    restore();
    return { chat: st.chats.find(c => c.groupChatId === id)?.name ?? null, query: q, matched: matches.length, count: out.length, truncated: matches.length > out.length, messages: out }; })()`;
  return evalRenderer<SearchResult | ErrorResult>(code, SEARCH_TIMEOUT_MS);
}

// Open a chat and read its recent messages (incl. attachment metadata). Scrolls back to cover `sinceDays`
// (beyond the ~1 week initial load) by paging the app's infinite-scroll. SIDE EFFECT: marks the chat read.
export async function readChat(opts: ReadChatOptions): Promise<ReadResult> {
  const { chatId, sinceDays = 7, fromOpponentOnly = false, limit = 200, maxScrolls = 40 } = opts;
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
    // Page older history by scrolling the virtualized message list to the top. Prefer the
    // app's own infinite-scroll container (reliable trigger); fall back to climbing from a
    // message row only if it is not mounted yet.
    const findScroll = () => {
      const inf = document.querySelector('.infinite-scroll--chat');
      if (inf && inf.scrollHeight > inf.clientHeight + 10) return inf;
      const row = document.querySelector('.chat-message-row, [class*="chat-message-row"]'); let sc = row;
      while (sc && sc !== document.body) { const st = getComputedStyle(sc); if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight + 10) return sc; sc = sc.parentElement; }
      return inf || null;
    };
    // A single page that does not grow can be a slow network fetch, not the end of history.
    // Require several consecutive no-growth passes (with extra grace) before concluding it.
    const STALE_LIMIT = 3;
    let scrolls = 0, exhausted = false, stale = 0;
    while (oldestTs() > since && scrolls < ${Number(maxScrolls)}) {
      const sc = findScroll();
      if (!sc) { await new Promise(r => setTimeout(r, 700)); if (++stale >= STALE_LIMIT) break; continue; }
      const before = msgsOf().length;
      sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll', { bubbles: true })); sc.dispatchEvent(new WheelEvent('wheel', { deltaY: -3000, bubbles: true }));
      await new Promise(r => setTimeout(r, 1500)); scrolls++;
      if (msgsOf().length > before) { stale = 0; }
      else { await new Promise(r => setTimeout(r, 1200)); if (++stale >= STALE_LIMIT) { exhausted = true; break; } }
    }
    const scEnd = findScroll(); if (scEnd) scEnd.scrollTop = scEnd.scrollHeight; // leave it scrolled to newest
    const st = S.getState();
    ${MSG_HELPERS}
    const me = st.user?.huid; const nameOf = h => st.profiles[h]?.rtsProfile?.name || null;
    const all = msgsOf();
    let msgs = all.filter(m => m.eventType === 'message_new' && m.insertedAt >= since && !m.deletedAt);
    if (${String(fromOpponentOnly)}) msgs = msgs.filter(m => m.sender !== me);
    msgs = msgs.sort((a, b) => a.insertedAt - b.insertedAt).slice(-${Number(limit)});
    const out = msgs.map(m => mapMsg(m, me, nameOf));
    const oldest = all.length ? Math.min(...all.map(m => m.insertedAt)) : null;
    if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } });
    return { chat: st.chats.find(c => c.groupChatId === id)?.name ?? null, loaded: ok, count: out.length, scrolls, historyExhausted: exhausted,
      oldestLoaded: oldest ? new Date(oldest).toISOString().slice(0, 16) : null,
      coversWholeRange: oldest ? oldest <= since || exhausted : false, messages: out }; })()`;
  // Budget scales with how many history pages we may scroll (each page sleeps ~1.5s).
  return evalRenderer<ReadResult>(code, READ_BASE_TIMEOUT_MS + maxScrolls * SCROLL_PAGE_BUDGET_MS);
}

// Open a deep link (xlnk.ms/open/message?sync_id=&chat_id=) and return the target message + surrounding context.
// SIDE EFFECT: opens (marks read) the linked chat.
export async function openLink(opts: OpenLinkOptions): Promise<LinkResult> {
  const { url, context = 5 } = opts;
  const u = new URL(url);
  const chatId = u.searchParams.get("chat_id") ?? u.searchParams.get("group_chat_id");
  const syncId = u.searchParams.get("sync_id") ?? u.searchParams.get("message_id");
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
    return { chat: st.chats.find(c => c.groupChatId === id)?.name ?? null, found: idx >= 0, loaded: ok,
      target: idx >= 0 ? mapMsg(all[idx], me, nameOf) : null, context: slice.map(m => mapMsg(m, me, nameOf)) }; })()`;
  return evalRenderer<LinkResult>(code);
}

// List the threads that belong to a chat (thread ids + reply counts). Side-effect-free.
export async function listThreads(opts: { chatId: string }): Promise<ThreadInfo[]> {
  const { chatId } = opts;
  await boot();
  return evalRenderer<ThreadInfo[]>(`(() => { const st = window.__exr.store.getState(); const cid = ${JSON.stringify(chatId)};
    const tl = st.threads.threadList || {};
    return Object.entries(tl).filter(([id, t]) => t.parentChatId === cid)
      .map(([id, t]) => ({ threadId: id, replies: t.counter, subscribers: (t.subscribers || []).length })); })()`);
}

// Read a thread's replies. SIDE EFFECT: opens the parent chat (marks it read) and navigates into the thread view.
export async function readThread(opts: ReadThreadOptions): Promise<ThreadResult | ErrorResult> {
  const { chatId, threadId, limit = 200 } = opts;
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
    return { chat: st.chats.find(c => c.groupChatId === chatId)?.name ?? null, threadId, count: out.length, messages: out }; })()`;
  return evalRenderer<ThreadResult | ErrorResult>(code, THREAD_TIMEOUT_MS);
}

// Extract an image message's already-decrypted preview thumbnail (base64). SIDE EFFECT: opens the chat if not active.
export async function getImagePreview(opts: { chatId: string; syncId: string }): Promise<ImageResult> {
  const { chatId, syncId } = opts;
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
  const data = await evalRenderer<ImagePreviewBlob | null>(code);
  if (!data) return { found: false, note: "No decrypted image preview for that message (only images have previews; must be currently loaded)." };
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
function resolveDownloadDir(folder?: string): string {
  const downloads = join(homedir(), "Downloads");
  const choice = folder || process.env["EXPRESS_DOWNLOAD_DIR"] || "express-reader";
  return isAbsolute(choice) ? choice : join(downloads, choice);
}

function safeBaseName(name: string): string {
  const base = ((name || "file").split(/[\\/]/).pop() ?? "").replace(/\x00/g, "").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 200) : "file";
}

// Download a document/file attachment: let the app decrypt it to an in-memory blob, fetch that blob,
// and save it to the configurable folder. Keys never leave the app. SIDE EFFECT: opens the chat (marks read).
export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult | ErrorResult> {
  const { chatId, syncId, folder } = opts;
  await boot();
  const code = `(async () => {
    const S = window.__exr.store; const id = ${JSON.stringify(chatId)}; const sync = ${JSON.stringify(syncId)};
    const prev = S.getState().chatRouting?.activeChatId;
    S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + id] } });
    for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 500)); if (S.getState().messages.some(m => m.groupChatId === id)) break; }
    const restore = () => { if (prev && prev !== id) S.dispatch({ type: '@@router/CALL_HISTORY_METHOD', payload: { method: 'push', args: ['/chats/' + prev] } }); };
    let st = S.getState();
    let msg = st.messages.find(m => m.syncId === sync && m.payload && m.payload.payload && m.payload.payload.fileId);
    if (!msg) { restore(); return { error: 'Message not in the loaded window (or it has no file attachment). Read/scroll the chat to it first, then retry.' }; }
    const MAX = 25 * 1024 * 1024;
    // Validate the size as a real number: an absent/NaN fileSize must NOT bypass the cap
    // (undefined > MAX is false), or a huge file would be pulled whole into a renderer blob + base64.
    const sz = Number(msg.payload.payload.fileSize);
    if (!Number.isFinite(sz) || sz <= 0) { restore(); return { error: 'Attachment has no known size (metadata not fully loaded) — refusing to download. Reopen the chat and retry.' }; }
    if (sz > MAX) { restore(); return { error: 'File too large (> 25 MiB).' }; }
    if (!msg.payload.payload.fileBlob) {
      // Trigger the app's own file-download saga via the bound loadMessageFile action.
      // It keys on payload.msgId (NOT syncId) and needs downloadToBlob:true to decrypt into
      // an in-memory blob; without that flag the app saves to disk and never sets fileBlob.
      // (loadAttachment/onLoadAttachment with the bare message are no-ops.)
      const messageId = msg.payload.msgId;
      if (!messageId) { restore(); return { error: 'Message has no payload.msgId; cannot trigger download.' }; }
      const threadId = (msg.meta && msg.meta.threadId) || msg.payload.threadId || null;
      const roots = [document.getElementById('root'), ...document.body.children].filter(Boolean);
      let fiber = null; for (const el of roots) { const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber')); if (k) { fiber = el[k]; break; } }
      while (fiber && fiber.return) fiber = fiber.return;
      let lmf = null; { const stk = [fiber]; let n = 0; while (stk.length && n < 250000 && !lmf) { const f = stk.pop(); if (!f) continue; n++; const p = f.memoizedProps; if (p && typeof p.loadMessageFile === 'function') lmf = p.loadMessageFile; if (f.child) stk.push(f.child); if (f.sibling) stk.push(f.sibling); } }
      if (!lmf) { restore(); return { error: 'Download action unavailable (open the chat first).' }; }
      try { lmf({ messageId, downloadToBlob: true, threadId }); } catch (e) { restore(); return { error: 'loadMessageFile failed: ' + e.message }; }
      for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 500)); const m2 = S.getState().messages.find(m => m.syncId === sync); if (m2?.payload?.payload?.fileBlob) { msg = m2; break; } }
    }
    const f = msg.payload.payload;
    if (!f.fileBlob) { restore(); return { error: 'Download did not complete in time — the attachment did not decrypt within the budget (slow server fetch, or this attachment type is not handled by the trigger).' }; }
    // Fetch the already-decrypted blob. Guard it so a revoked/dead blob restores the user's view
    // and fails fast (its own 30s timeout) instead of silently consuming the whole eval budget.
    let out;
    try {
      const ab = await fetch(f.fileBlob, { signal: AbortSignal.timeout(30000) }).then(r => r.arrayBuffer());
      let bin = ''; const u8 = new Uint8Array(ab); const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      out = { fileName: f.fileName, mime: f.fileMimeType, size: f.fileSize, declared: ab.byteLength, base64: btoa(bin) };
    } catch (e) { restore(); return { error: 'Reading the decrypted file failed: ' + (e && e.message ? e.message : String(e)) }; }
    restore();
    return out; })()`;
  const data = await evalRenderer<DownloadBlob | ErrorResult | null>(code, DOWNLOAD_TIMEOUT_MS);
  // The renderer can resolve to undefined if the app navigated/reloaded mid-download;
  // guard it so the caller gets a clean error instead of a thrown "in" on undefined.
  if (data == null) return { error: "Download failed: the app returned no result (it may have reloaded during the download). Try again." };
  if ("error" in data) return data;
  const dir = resolveDownloadDir(folder);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeBaseName(data.fileName));
  const buf = Buffer.from(data.base64, "base64");
  await writeFile(path, buf);
  return { path, size: buf.length, mime: data.mime, sizeMatches: buf.length === data.size };
}

// Gracefully quit and relaunch the app to unbind the debug port (inspector.close() does not in Electron main).
export async function closeDebug(): Promise<CloseResult> {
  await exec("osascript", ["-e", 'quit app "eXpress"']);
  for (let i = 0; i < 20; i++) {
    if (!(await eXpressPid())) break;
    await sleep(500);
  }
  await exec("open", ["-a", "eXpress"]);
  return { closed: true, note: "eXpress relaunched; debug port closed." };
}
