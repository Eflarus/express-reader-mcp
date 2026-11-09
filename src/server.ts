// Read-only MCP server for the eXpress desktop app. Reads the signed-in user's own
// chats from the running app on demand. No sending. See README for the security model.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as x from "./express.js";

const tools: Tool[] = [
  {
    name: "express_status",
    description: "Check the running eXpress app: signed-in user, chat count, unread count, which chat is open. Side-effect-free (no read receipts).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "express_list_chats",
    description: "List chats with metadata (name, type, unread count, last-activity time). Side-effect-free. Use `query` to filter by name/transliteration, `unreadOnly` to show only unread.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Filter by name or transliteration (e.g. 'иванов' or 'ivanov')" },
        unreadOnly: { type: "boolean" },
        limit: { type: "number", description: "Max chats (default 40)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "express_read_chat",
    description: "Open a chat and return its decrypted messages over the last `sinceDays` days. Pages back through the app's history scroll to cover ranges beyond the initial ~1 week. Resolve the person by `name` OR pass an exact `chatId`; if `name` matches several chats, the matches are returned instead of reading. WARNING: opening a chat MARKS IT READ and may send the sender a read receipt. `coversWholeRange: false` means the range wasn't fully reached within `maxScrolls`; `historyExhausted` means there are no older messages.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person/chat name to resolve (direct chats)" },
        chatId: { type: "string", description: "Exact chat id (overrides name)" },
        sinceDays: { type: "number", description: "How many days back (default 7)" },
        fromOpponentOnly: { type: "boolean", description: "Only the other person's messages, excluding your own (default false)" },
        limit: { type: "number", description: "Max messages returned (default 200)" },
        maxScrolls: { type: "number", description: "Max history pages to scroll back (default 40, ~50 msgs each)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "express_search_messages",
    description: "Native server-side search within a chat — finds matches across the WHOLE history (not just loaded messages), fast. Resolve the chat by `name` or exact `chatId`; if `name` matches several, the matches are returned instead of searching. Returns matching messages (syncId/time/from/text + attachment metadata). Optionally filter with `sinceDays`. `truncated: true` means the app capped results (~100). WARNING: opens the chat (MARKS IT READ).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person/chat name to resolve" },
        chatId: { type: "string", description: "Exact chat id (overrides name)" },
        query: { type: "string", description: "Search text" },
        sinceDays: { type: "number", description: "Only matches within the last N days (default: all history)" },
        limit: { type: "number", description: "Max results returned (default 100)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "express_open_link",
    description: "Open an eXpress deep link (e.g. https://xlnk.ms/open/message?sync_id=...&chat_id=...) and return the referenced message plus surrounding context. Each message includes attachment metadata and flags (hasThread, isReply). WARNING: opens the linked chat, which MARKS IT READ.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The xlnk.ms / eXpress deep link" },
        context: { type: "number", description: "Messages of context before and after the target (default 5)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "express_list_threads",
    description: "List the threads belonging to a chat (threadId + reply count). Side-effect-free. Use the returned threadId with express_read_thread.",
    inputSchema: { type: "object", properties: { chatId: { type: "string" } }, required: ["chatId"], additionalProperties: false },
  },
  {
    name: "express_read_thread",
    description: "Read a thread's replies by chatId + threadId (from express_list_threads). Messages include attachment metadata. WARNING: opens the parent chat (MARKS IT READ) and navigates into the thread.",
    inputSchema: {
      type: "object",
      properties: { chatId: { type: "string" }, threadId: { type: "string" }, limit: { type: "number" } },
      required: ["chatId", "threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "express_get_image",
    description: "Fetch an image message's decrypted preview thumbnail and save it to a local file (returns the path, which you can then read/view). Needs the chatId and the message syncId (from express_read_chat / express_open_link output). Only images have previews; this is a thumbnail, not full resolution. SIDE EFFECT: opens the chat if not already active (marks read).",
    inputSchema: {
      type: "object",
      properties: { chatId: { type: "string" }, syncId: { type: "string" } },
      required: ["chatId", "syncId"],
      additionalProperties: false,
    },
  },
  {
    name: "express_download_file",
    description: "Download a document/file attachment: the app decrypts it and the file is saved to a local folder, then you can read it as a normal file (returns the path). Needs chatId + the message syncId (from read/open/thread output). Saves into ~/Downloads/express-reader by default; override with `folder` (relative = subfolder of ~/Downloads, absolute = used as-is) or the EXPRESS_DOWNLOAD_DIR env var. Max 25 MiB. SIDE EFFECT: opens the chat (marks read).",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string" },
        syncId: { type: "string" },
        folder: { type: "string", description: "Save folder; relative is placed under ~/Downloads, absolute is used directly" },
      },
      required: ["chatId", "syncId"],
      additionalProperties: false,
    },
  },
  {
    name: "express_close_debug",
    description: "Close the debug inspector port by gracefully quitting and relaunching eXpress. Call when finished reading, to stop exposing 127.0.0.1:9229.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server({ name: "express-reader", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 1) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const name = req.params.name;
  const args: Record<string, unknown> = req.params.arguments ?? {};
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof args[k] === "number" ? (args[k] as number) : undefined);
  const bool = (k: string): boolean | undefined => (typeof args[k] === "boolean" ? (args[k] as boolean) : undefined);

  // Resolve a chat either from an explicit chatId or by resolving `name`.
  // Returns { chatId } to proceed, or { reply } when disambiguation is needed.
  const resolveChat = async (): Promise<{ chatId: string } | { reply: CallToolResult }> => {
    const explicit = str("chatId");
    if (explicit) return { chatId: explicit };
    const nm = str("name");
    if (!nm) throw new Error("Provide `name` or `chatId`.");
    const people = await x.resolvePeople(nm);
    const first = people[0];
    if (!first) throw new Error(`No chat matches "${nm}".`);
    if (people.length > 1) {
      return { reply: textResult(`Multiple matches for "${nm}" — call again with an exact chatId:\n${JSON.stringify(people, null, 1)}`) };
    }
    return { chatId: first.id };
  };

  try {
    switch (name) {
      case "express_status":
        return textResult(await x.status());

      case "express_list_chats":
        return textResult(await x.listChats({
          query: str("query") ?? "",
          unreadOnly: bool("unreadOnly") ?? false,
          limit: num("limit") ?? 40,
        }));

      case "express_read_chat": {
        const r = await resolveChat();
        if ("reply" in r) return r.reply;
        return textResult(await x.readChat({
          chatId: r.chatId,
          sinceDays: num("sinceDays") ?? 7,
          fromOpponentOnly: bool("fromOpponentOnly") ?? false,
          limit: num("limit") ?? 200,
          maxScrolls: num("maxScrolls") ?? 40,
        }));
      }

      case "express_search_messages": {
        const query = str("query");
        if (!query) throw new Error("`query` is required.");
        const r = await resolveChat();
        if ("reply" in r) return r.reply;
        return textResult(await x.searchMessages({
          chatId: r.chatId,
          query,
          sinceDays: num("sinceDays") ?? 0,
          limit: num("limit") ?? 100,
        }));
      }

      case "express_open_link": {
        const url = str("url");
        if (!url) throw new Error("`url` is required.");
        return textResult(await x.openLink({ url, context: num("context") ?? 5 }));
      }

      case "express_list_threads": {
        const chatId = str("chatId");
        if (!chatId) throw new Error("`chatId` is required.");
        return textResult(await x.listThreads({ chatId }));
      }

      case "express_read_thread": {
        const chatId = str("chatId");
        const threadId = str("threadId");
        if (!chatId || !threadId) throw new Error("`chatId` and `threadId` are required.");
        return textResult(await x.readThread({ chatId, threadId, limit: num("limit") ?? 200 }));
      }

      case "express_get_image": {
        const chatId = str("chatId");
        const syncId = str("syncId");
        if (!chatId || !syncId) throw new Error("`chatId` and `syncId` are required.");
        return textResult(await x.getImagePreview({ chatId, syncId }));
      }

      case "express_download_file": {
        const chatId = str("chatId");
        const syncId = str("syncId");
        if (!chatId || !syncId) throw new Error("`chatId` and `syncId` are required.");
        const folder = str("folder");
        return textResult(await x.downloadFile(folder !== undefined ? { chatId, syncId, folder } : { chatId, syncId }));
      }

      case "express_close_debug":
        return textResult(await x.closeDebug());

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
