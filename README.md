# express-reader-mcp

Read-only MCP server that reads **your own** eXpress desktop chats from the running app. Built for a public-server account, for which the CTS-only community MCPs do not work.

> ⚠️ **Unofficial.** This is an independent, community project. It is **not** affiliated with, endorsed by, or supported by eXpress, its developer, or any official eXpress development team. It relies on undocumented internals of the desktop app, may break at any time, and is used entirely at your own risk. Only for reading **your own** account.

## How it works

The eXpress desktop app is Electron. On demand, the server sends `SIGUSR1` to the running app, which opens Node's inspector on `127.0.0.1:9229` (loopback only). Through it the server reads the app's in-memory Redux store, which holds your chats **already decrypted** by the app itself. No new device is registered; no account keys leave the app.

## Install

TypeScript (strict), compiled to `dist/`. Requires Node ≥ 22.

```sh
npm install
npm run build
```

Register with your MCP client, pointing at the built entry point, e.g. for Claude Code:

```sh
claude mcp add --scope user express-reader -- "$(which node)" "$PWD/dist/server.js"
```

## Tools

- `express_status` — signed-in user, chat/unread counts, which chat is open. **Silent.**
- `express_list_chats` — chat list with metadata; filter by `query`/`unreadOnly`. **Silent.**
- `express_read_chat` — resolve a person by `name` (or exact `chatId`), open the chat, return messages over `sinceDays`. **Pages back through the app's history scroll to cover ranges well beyond the initial ~1 week.** Each message carries `syncId`, `attachment` metadata (kind/fileName/size/mime/fileId/hasImagePreview), and `hasThread`/`isReply` flags. **Marks the chat read and may send the sender a read receipt.** `coversWholeRange` tells you if the full range was reached; `historyExhausted` means there are no older messages.
- `express_search_messages` — native server-side search within a chat (resolve by `name` or `chatId`): finds matches across the **whole history**, fast, not just loaded messages. Returns matching messages (syncId/time/from/text + attachment metadata); optional `sinceDays`. **Opens the chat (marks read).**
- `express_open_link` — open an `xlnk.ms/open/message?sync_id=&chat_id=` deep link and return the referenced message + surrounding context. **Opens (marks read) the linked chat.**
- `express_list_threads` — list a chat's threads (threadId + reply count). Side-effect-free.
- `express_read_thread` — read a thread's replies by `chatId`+`threadId`. **Opens the parent chat (marks read).**
- `express_get_image` — save an image message's decrypted **preview thumbnail** to a local file (by `chatId`+`syncId`) for quick viewing. Thumbnail only; use `express_download_file` for the full-resolution image.
- `express_download_file` — download a document/image attachment at full fidelity. The **app** decrypts it to an in-memory blob; the file is saved to a local folder (default `~/Downloads/express-reader`, configurable via `folder` or `EXPRESS_DOWNLOAD_DIR`) and the path is returned so you can read it as a normal file. Keys never leave the app. Max 25 MiB. **Opens the chat (marks read).**
- `express_close_debug` — quit + relaunch eXpress to unbind the debug port when finished.

## Security model

- While a read is in progress the inspector port is open on loopback; any local process could attach to the app during that window. Call `express_close_debug` when done.
- Read-only: there is no send capability.
- Requires the app to be running and signed in. Node ≥ 22 (global `WebSocket`/`fetch`).

## How downloads stay safe

`express_download_file` never touches your encryption keys. It calls the app's own `loadAttachment`, which decrypts the file in-app to an in-memory blob; the tool only fetches that already-decrypted blob (the same way it reads a decrypted message) and writes it to disk. The key material stays inside the app at all times.

## Limits / notes

- Reading a non-open chat still **marks it read** (the reliable path opens the chat); fully silent reading is not wired.
- History paging walks the app's virtualized scroll; very long ranges take a few seconds per ~50-message page (`maxScrolls` caps it).
- Downloads cap at 25 MiB.
- Tied to the app's internal store/route shapes (observed on app v3.73.51); an app update may require adjustment.
