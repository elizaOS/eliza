/**
 * Telegram refuses an edit whose text already matches the message with
 * "400: Bad Request: message is not modified". On a real PGlite runtime that
 * boots the telegram plugin as an agent does, these tests drive the compact
 * progress line of a turn (createTelegramCompactProgressCallback with the
 * service's own MessageManager.editMessage, wired as handleMessage wires it)
 * and the connector edit_message capability (runtime.editMessageOnTarget, the
 * call the orchestrator's compact progress makes). Only the Bot API host is
 * local. It answers edits as Telegram does: an edit that does not change the
 * text is refused as not modified, and an edit of a deleted message as not
 * found.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Content, HandlerCallback, Memory, Plugin } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import type { Context, Telegraf } from "telegraf";
import { afterAll, beforeAll, expect, it } from "vitest";
import telegramPlugin from "../src/index.ts";
import {
  createTelegramCompactProgressCallback,
  type MessageManager,
} from "../src/messageManager.ts";

// Event kinds of quint/TelegramEditUnchanged.qnt. A progress event is also the
// text that it shows.
const TEXT_A = 1;
const TEXT_B = 2;
const DELETE = 3;
const TEXTS: Record<number, string> = {
  [TEXT_A]: "Reading the repository (step 1)",
  [TEXT_B]: "Running the tests (step 2)",
};

interface ModelCase {
  events: number[];
  calls: string[];
  posts: number;
  edits: number;
  unchanged: number;
  visible: number;
  shown: number;
}

// Without generated cases (an ordinary test run) these cases from the model
// run; quint/check-telegram-edit-unchanged.mjs replays every generated case.
const DEFAULT_CASES: ModelCase[] = [
  {
    events: [TEXT_A, TEXT_A, TEXT_B, TEXT_B],
    calls: [
      "sendMessage",
      "editMessageText",
      "editMessageText",
      "editMessageText",
    ],
    posts: 1,
    edits: 3,
    unchanged: 2,
    visible: 1,
    shown: TEXT_B,
  },
  {
    events: [TEXT_A, DELETE, TEXT_A, TEXT_A],
    calls: ["sendMessage", "editMessageText", "sendMessage", "editMessageText"],
    posts: 2,
    edits: 2,
    unchanged: 1,
    visible: 1,
    shown: TEXT_A,
  },
];
const casesFile = process.env.ELIZA_TELEGRAM_EDIT_UNCHANGED_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;
const named = cases.map((item) => ({
  ...item,
  name: item.events
    .map((event) => ({ 1: "A", 2: "B", 3: "D" })[event])
    .join(""),
}));

interface Call {
  method: string;
  chatId: number;
}
const calls: Call[] = [];
// Edits that the Bot API refused, by reason.
const refused: Array<{ chatId: number; reason: "unchanged" | "missing" }> = [];
// The bot's messages still in each chat: message id -> text that it shows.
const chats = new Map<number, Map<number, string>>();
let nextMessageId = 500;
let server: Server;
let apiRoot = "";

/** The text Telegram shows: MarkdownV2 escapes are not shown. */
function rendered(body: { text?: unknown; parse_mode?: unknown }): string {
  const text = String(body.text ?? "");
  return body.parse_mode === "MarkdownV2" ? text.replace(/\\(.)/g, "$1") : text;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").split("/").pop() ?? "";
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      response.setHeader("content-type", "application/json");
      const ok = (result: unknown) =>
        response.end(JSON.stringify({ ok: true, result }));
      const refuse = (description: string) => {
        response.statusCode = 400;
        response.end(
          JSON.stringify({ ok: false, error_code: 400, description }),
        );
      };
      if (method === "getMe") {
        return ok({
          id: 5151,
          is_bot: true,
          first_name: "Progress",
          username: "progress_line_bot",
        });
      }
      if (method === "getUpdates") {
        setTimeout(() => ok([]), 100);
        return;
      }
      const chatId = Number(body.chat_id);
      if (method === "sendMessage" || method === "editMessageText") {
        calls.push({ method, chatId });
      }
      const messages = chats.get(chatId) ?? new Map<number, string>();
      chats.set(chatId, messages);
      if (method === "sendMessage") {
        const messageId = nextMessageId++;
        messages.set(messageId, rendered(body));
        return ok({
          message_id: messageId,
          date: 1,
          chat: { id: chatId, type: "private", first_name: "Owner" },
          text: rendered(body),
        });
      }
      if (method === "editMessageText") {
        const messageId = Number(body.message_id);
        if (!messages.has(messageId)) {
          refused.push({ chatId, reason: "missing" });
          return refuse("Bad Request: message to edit not found");
        }
        if (messages.get(messageId) === rendered(body)) {
          refused.push({ chatId, reason: "unchanged" });
          return refuse(
            "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
          );
        }
        messages.set(messageId, rendered(body));
        return ok({
          message_id: messageId,
          date: 1,
          chat: { id: chatId, type: "private", first_name: "Owner" },
          text: rendered(body),
        });
      }
      return ok(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Agent {
  runtime: Awaited<ReturnType<typeof createTestRuntime>>["runtime"];
  bot: Telegraf<Context>;
  messageManager: MessageManager;
  cleanup: () => Promise<void>;
}

/** Boots the telegram plugin on PGlite with the local Bot API. */
async function startAgent(): Promise<Agent> {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "ProgressLineAgent",
    settings: {
      TELEGRAM_BOT_TOKEN: "5151:PROGRESS_LINE_LOCAL_ONLY",
      TELEGRAM_API_ROOT: apiRoot,
    },
    plugins: [telegramPlugin as Plugin],
  });
  await runtime.getServiceLoadPromise("telegram" as never);
  const service = runtime.getService("telegram") as unknown as {
    bot: Telegraf<Context> | null;
    messageManager: MessageManager | null;
  };
  if (!service?.bot || !service.messageManager) {
    throw new Error("TelegramService did not start its bot");
  }
  return {
    runtime,
    bot: service.bot,
    messageManager: service.messageManager,
    cleanup,
  };
}

/**
 * The compact progress line of one turn in a private chat, wired as
 * MessageManager.handleMessage wires it: the base callback sends the content
 * through sendMessageInChunks and returns the sent message as a memory.
 */
function progressLine(agent: Agent, chatId: number): HandlerCallback {
  const baseCallback: HandlerCallback = async (content: Content) => {
    const sent = await agent.messageManager.sendMessageInChunks(
      { chat: { id: chatId }, telegram: agent.bot.telegram } as Context,
      content,
    );
    return sent.map(
      (message) =>
        ({
          content,
          metadata: { telegram: { chatId, messageId: message.message_id } },
        }) as unknown as Memory,
    );
  };
  return createTelegramCompactProgressCallback({
    baseCallback,
    editMessage: agent.messageManager.editMessage.bind(agent.messageManager),
    chatId,
  });
}

function progress(text: string): Content {
  return {
    text,
    source: "action_progress",
    metadata: { transient: true, compactProgress: true },
  };
}

/** Runs the events of one case in its own chat and reads what Telegram shows. */
async function replay(
  agent: Agent,
  item: ModelCase,
  chatId: number,
): Promise<ModelCase> {
  const callback = progressLine(agent, chatId);
  for (const event of item.events) {
    if (event === DELETE) {
      // The user deletes the status message: the bot's newest message.
      const messages = chats.get(chatId);
      const newest = Math.max(...(messages?.keys() ?? []));
      messages?.delete(newest);
    } else {
      await callback(progress(TEXTS[event]), "PROGRESS");
    }
  }
  const chatCalls = calls.filter((call) => call.chatId === chatId);
  const messages = [...(chats.get(chatId)?.values() ?? [])];
  const shownText = messages.at(-1);
  return {
    events: item.events,
    calls: chatCalls.map((call) => call.method),
    posts: chatCalls.filter((call) => call.method === "sendMessage").length,
    edits: chatCalls.filter((call) => call.method === "editMessageText").length,
    unchanged: refused.filter(
      (entry) => entry.chatId === chatId && entry.reason === "unchanged",
    ).length,
    visible: messages.length,
    shown:
      Number(
        Object.keys(TEXTS).find((key) => TEXTS[Number(key)] === shownText),
      ) || 0,
  };
}

let agent: Agent;
beforeAll(async () => {
  agent = await startAgent();
}, 120_000);
afterAll(async () => {
  await agent?.cleanup();
});

it("keeps one status message for an unchanged progress line", async () => {
  const chatId = 7001;
  const callback = progressLine(agent, chatId);
  for (const text of [TEXTS[TEXT_A], TEXTS[TEXT_A], TEXTS[TEXT_B]]) {
    await callback(progress(text), "PROGRESS");
  }
  await callback(progress(TEXTS[TEXT_B]), "PROGRESS");

  const methods = calls
    .filter((call) => call.chatId === chatId)
    .map((call) => call.method);
  expect(methods).toEqual([
    "sendMessage",
    "editMessageText",
    "editMessageText",
    "editMessageText",
  ]);
  expect([...(chats.get(chatId)?.values() ?? [])]).toEqual([TEXTS[TEXT_B]]);
}, 120_000);

it("edit_message resolves for the text the message already shows", async () => {
  const chatId = 7002;
  const target = { source: "telegram", channelId: String(chatId) };
  const sent = await agent.bot.telegram.sendMessage(chatId, TEXTS[TEXT_A]);
  const messageId = String(sent.message_id);

  // The message already shows this text; the edit must not fail.
  await agent.runtime.editMessageOnTarget(target, messageId, {
    text: TEXTS[TEXT_A],
  });
  expect(chats.get(chatId)?.get(sent.message_id)).toBe(TEXTS[TEXT_A]);
  await agent.runtime.editMessageOnTarget(target, messageId, {
    text: TEXTS[TEXT_B],
  });
  expect(chats.get(chatId)?.get(sent.message_id)).toBe(TEXTS[TEXT_B]);
  // Other refusals still fail the edit: a deleted message is not edited.
  chats.get(chatId)?.delete(sent.message_id);
  await expect(
    agent.runtime.editMessageOnTarget(target, messageId, {
      text: TEXTS[TEXT_A],
    }),
  ).rejects.toThrow(/message to edit not found/);
}, 120_000);

it.each(named)(
  "edit model replays $name",
  async (item) => {
    const chatId = 8000 + named.indexOf(item);
    const { name: _name, ...expected } = item;
    expect(await replay(agent, item, chatId)).toEqual(expected);
  },
  120_000,
);
