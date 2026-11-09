# express-reader-mcp

Read-only MCP server that reads **your own** eXpress desktop chats from the running app. Built for a public-server account, for which the CTS-only community MCPs do not work.

## How it works

The eXpress desktop app is Electron. On demand, the server sends `SIGUSR1` to the running app, which opens Node's inspector on `127.0.0.1:9229` (loopback only). Through it the server reads the app's in-memory Redux store, which holds your chats **already decrypted** by the app itself. No new device is registered; no account keys leave the app.

## Tools

- `express_status` — signed-in user, chat/unread counts, which chat is open. **Silent.**
- `express_list_chats` — chat list with metadata; filter by `query`/`unreadOnly`. **Silent.**
- `express_read_chat` — resolve a person by `name` (or exact `chatId`), open the chat, return recent messages over `sinceDays`. Each message carries `syncId`, `attachment` metadata (kind/fileName/size/mime/fileId/hasImagePreview), and `hasThread`/`isReply` flags. **Marks the chat read and may send the sender a read receipt.** `coversWholeRange: false` means older messages in the range were not loaded (no history-scroll yet).
- `express_open_link` — open an `xlnk.ms/open/message?sync_id=&chat_id=` deep link and return the referenced message + surrounding context. **Opens (marks read) the linked chat.**
- `express_get_image` — save an image message's decrypted **preview thumbnail** to a local file (by `chatId`+`syncId`) for viewing. Thumbnail only, not full resolution.
- `express_close_debug` — quit + relaunch eXpress to unbind the debug port when finished.

## Security model

- While a read is in progress the inspector port is open on loopback; any local process could attach to the app during that window. Call `express_close_debug` when done.
- Read-only: there is no send capability.
- Requires the app to be running and signed in. Node ≥ 22 (global `WebSocket`/`fetch`).

## Limits / TODO

- History is whatever the app loads on open (often ~a week). Reaching further back needs chat-FSM scroll work (`scrollChatBackward`) — not yet implemented.
- **Attachments: metadata for all file types; viewing is the image preview thumbnail only.** Full-resolution images and document *contents* (PDF/DOCX/JSON bytes) are NOT downloaded yet — `loadMessageFile` did not yield decrypted output in testing; needs more work (or standalone stream-decrypt like the audited express-mcp).
- **Threads:** messages are flagged with `hasThread`, but reading a thread's replies is not implemented yet (thread messages load on a separate route).
- Silent reading of a non-open chat (without marking read) was not wired; the reliable path opens the chat. Candidate for later: `startSearchMessages`.
- Tied to the app's internal store/route shapes (observed on app v3.73.51); an app update may require adjustment.
