#!/usr/bin/env node
// Read-only MCP server for the eXpress desktop app. Reads the signed-in user's own
// chats from the running app on demand. No sending. See README for the security model.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as x from "./express.mjs";

const tools = [
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
    description: "Open a chat and return its recent messages (decrypted), filtered to the last `sinceDays` days. Resolve the person by `name` OR pass an exact `chatId`. If `name` matches several chats, the matches are returned instead of reading. WARNING: opening a chat MARKS IT READ and may send the sender a read receipt. If `coversWholeRange` is false, older messages in the range were not loaded.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person/chat name to resolve (direct chats)" },
        chatId: { type: "string", description: "Exact chat id (overrides name)" },
        sinceDays: { type: "number", description: "How many days back (default 7)" },
        fromOpponentOnly: { type: "boolean", description: "Only the other person's messages, excluding your own (default false)" },
        limit: { type: "number", description: "Max messages returned (default 200)" },
      },
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
      properties: {
        chatId: { type: "string" },
        syncId: { type: "string" },
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

const server = new Server({ name: "express-reader", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    let result;
    if (name === "express_status") result = await x.status();
    else if (name === "express_list_chats") result = await x.listChats(a);
    else if (name === "express_open_link") result = await x.openLink({ url: a.url, context: a.context ?? 5 });
    else if (name === "express_list_threads") result = await x.listThreads({ chatId: a.chatId });
    else if (name === "express_read_thread") result = await x.readThread({ chatId: a.chatId, threadId: a.threadId, limit: a.limit ?? 200 });
    else if (name === "express_get_image") result = await x.getImagePreview({ chatId: a.chatId, syncId: a.syncId });
    else if (name === "express_close_debug") result = await x.closeDebug();
    else if (name === "express_read_chat") {
      let chatId = a.chatId;
      if (!chatId) {
        if (!a.name) throw new Error("Provide `name` or `chatId`.");
        const people = await x.resolvePeople(a.name);
        if (people.length === 0) throw new Error(`No chat matches "${a.name}".`);
        if (people.length > 1) {
          return { content: [{ type: "text", text: `Multiple matches for "${a.name}" — call again with an exact chatId:\n${JSON.stringify(people, null, 1)}` }] };
        }
        chatId = people[0].id;
      }
      result = await x.readChat({ chatId, sinceDays: a.sinceDays ?? 7, fromOpponentOnly: a.fromOpponentOnly ?? false, limit: a.limit ?? 200 });
    } else throw new Error(`Unknown tool: ${name}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
