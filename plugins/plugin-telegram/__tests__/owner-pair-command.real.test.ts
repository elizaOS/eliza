/**
 * `/eliza_pair <code>` (owner pairing) on a real PGlite runtime that boots the
 * telegram plugin as an agent does: TelegramService and
 * TelegramOwnerPairingServiceImpl start through the runtime, and each update
 * goes through TelegramService's own Telegraf instance. Only the Bot API host
 * is local. OWNER_BIND_VERIFY is the backend verifier of packages/agent
 * (services/owner-binding.ts); the service registered here under that type
 * records the codes that the command relays. The message handler records the
 * messages that would start an agent turn instead of running one.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type IAgentRuntime, type Plugin, Service } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import type { Context, Telegraf } from "telegraf";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import telegramPlugin from "../src/index.ts";
import { MessageManager } from "../src/messageManager.ts";

// Message kinds of quint/TelegramOwnerPairCommand.qnt.
const PAIR_ALLOWED = 1;
const PAIR_DENIED = 2;
const TEXT = 3;

interface ModelCase {
  verifier: boolean;
  events: number[];
  relayed: number;
  handled: number;
  replies: number;
}

// Without generated cases (an ordinary test run) these cases from the model
// run; quint/check-telegram-owner-pair-command.mjs replays every generated case.
const DEFAULT_CASES: ModelCase[] = [
  {
    verifier: true,
    events: [PAIR_ALLOWED, TEXT, PAIR_DENIED, PAIR_ALLOWED],
    relayed: 2,
    handled: 1,
    replies: 2,
  },
  {
    verifier: false,
    events: [PAIR_ALLOWED, TEXT, PAIR_DENIED, TEXT],
    relayed: 0,
    handled: 3,
    replies: 0,
  },
];
const casesFile = process.env.ELIZA_TELEGRAM_OWNER_PAIR_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

// Each case pairs from its own private chat, so the per-user rate limit of
// /eliza_pair (5 a minute) never carries over between cases. The allowlist
// holds every allowed chat; a denied chat is not on it.
const allowedChat = (index: number) => 10_000 + index;
const deniedChat = (index: number) => 20_000 + index;
const USAGE_CHAT = 30_000;
const allowedChats = JSON.stringify([
  ...cases.map((_, index) => String(allowedChat(index))),
  String(USAGE_CHAT),
]);
const CODE = "123456";

const relayed: Array<{
  connector: string;
  externalId: string;
  code: string;
}> = [];
class RecordingOwnerBindVerify extends Service {
  static serviceType = "OWNER_BIND_VERIFY";
  capabilityDescription = "Records relayed owner pairing codes";
  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new RecordingOwnerBindVerify(runtime);
  }
  async stop(): Promise<void> {}
  async verifyOwnerBindFromConnector(params: {
    connector: string;
    externalId: string;
    code: string;
  }): Promise<{ success: boolean }> {
    relayed.push({
      connector: params.connector,
      externalId: params.externalId,
      code: params.code,
    });
    return { success: true };
  }
}
const verifierPlugin: Plugin = {
  name: "owner-pair-command-verifier",
  description: "OWNER_BIND_VERIFY for the /eliza_pair test",
  services: [RecordingOwnerBindVerify],
};

const replies: Array<{ chatId: number; text: string }> = [];
let server: Server;
let apiRoot = "";

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
      if (method === "getMe") {
        return ok({
          id: 4242,
          is_bot: true,
          first_name: "Pair",
          username: "owner_pair_bot",
        });
      }
      if (method === "getUpdates") {
        setTimeout(() => ok([]), 100);
        return;
      }
      if (method === "sendMessage") {
        replies.push({ chatId: Number(body.chat_id), text: body.text });
        return ok({
          message_id: 900 + replies.length,
          date: 1,
          chat: { id: Number(body.chat_id), type: "private" },
          text: body.text,
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

const turns: Array<{ chatId: number; text: string }> = [];
afterEach(() => {
  vi.restoreAllMocks();
});

interface Agent {
  bot: Telegraf<Context>;
  cleanup: () => Promise<void>;
}

/** Boots the telegram plugin, with or without OWNER_BIND_VERIFY. */
async function startAgent(verifier: boolean): Promise<Agent> {
  vi.spyOn(MessageManager.prototype, "handleMessage").mockImplementation(
    async (ctx: Context) => {
      const message = ctx.message as { text?: string } | undefined;
      turns.push({ chatId: ctx.chat?.id ?? 0, text: message?.text ?? "" });
    },
  );
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "OwnerPairAgent",
    settings: {
      TELEGRAM_BOT_TOKEN: "4242:OWNER_PAIR_LOCAL_ONLY",
      TELEGRAM_API_ROOT: apiRoot,
      TELEGRAM_ALLOWED_CHATS: allowedChats,
    },
    plugins: [...(verifier ? [verifierPlugin] : []), telegramPlugin as Plugin],
  });
  await runtime.getServiceLoadPromise("telegram" as never);
  await runtime.getServiceLoadPromise("OWNER_PAIRING_TELEGRAM" as never);
  if (verifier) {
    await runtime.getServiceLoadPromise("OWNER_BIND_VERIFY" as never);
  }
  const service = runtime.getService("telegram") as unknown as {
    bot: Telegraf<Context> | null;
  };
  if (!service?.bot) throw new Error("TelegramService has no bot");
  return { bot: service.bot, cleanup };
}

let updateId = 0;
async function send(agent: Agent, chatId: number, text: string) {
  updateId += 1;
  const command = text.startsWith("/") ? text.split(" ")[0] : undefined;
  await agent.bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Owner" },
      from: { id: chatId, is_bot: false, first_name: "Owner" },
      text,
      ...(command
        ? {
            entities: [
              { type: "bot_command", offset: 0, length: command.length },
            ],
          }
        : {}),
    },
  } as never);
  // The message handler starts its turn on the next microtask.
  await new Promise((resolve) => setImmediate(resolve));
}

/** Sends the case's messages and counts what reached each side. */
async function replay(
  agent: Agent,
  item: ModelCase,
  index: number,
): Promise<ModelCase> {
  const allowed = allowedChat(index);
  const denied = deniedChat(index);
  const start = {
    relayed: relayed.length,
    turns: turns.length,
    replies: replies.length,
  };
  for (const event of item.events) {
    if (event === PAIR_ALLOWED)
      await send(agent, allowed, `/eliza_pair ${CODE}`);
    else if (event === PAIR_DENIED)
      await send(agent, denied, `/eliza_pair ${CODE}`);
    else if (event === TEXT) await send(agent, allowed, "hello");
  }
  const caseRelays = relayed.slice(start.relayed);
  const caseTurns = turns.slice(start.turns);
  const caseReplies = replies.slice(start.replies);
  // Nothing from the denied chat reaches the relay, a turn or a reply.
  expect(caseRelays).toEqual(
    caseRelays.map(() => ({
      connector: "telegram",
      externalId: String(allowed),
      code: CODE,
    })),
  );
  expect(caseTurns.every((turn) => turn.chatId === allowed)).toBe(true);
  expect(caseReplies).toEqual(
    caseReplies.map(() => ({
      chatId: allowed,
      text: "Paired with Eliza. You can now log in via Telegram.",
    })),
  );
  return {
    verifier: item.verifier,
    events: item.events,
    relayed: caseRelays.length,
    handled: caseTurns.length,
    replies: caseReplies.length,
  };
}

it("relays /eliza_pair to OWNER_BIND_VERIFY and shows its usage", async () => {
  const agent = await startAgent(true);
  try {
    await send(agent, allowedChat(0), `/eliza_pair ${CODE}`);
    expect(relayed.at(-1)).toEqual({
      connector: "telegram",
      externalId: String(allowedChat(0)),
      code: CODE,
    });
    expect(turns).toEqual([]);
    expect(replies.at(-1)).toEqual({
      chatId: allowedChat(0),
      text: "Paired with Eliza. You can now log in via Telegram.",
    });
    // The usage reply is plain text, so it shows no Markdown escape.
    await send(agent, USAGE_CHAT, "/eliza_pair");
    expect(replies.at(-1)).toEqual({
      chatId: USAGE_CHAT,
      text: "Usage: /eliza_pair <code> — enter the 6-digit code shown in the Eliza dashboard.",
    });
  } finally {
    await agent.cleanup();
  }
}, 120_000);

const FIRST = { allowed: PAIR_ALLOWED, denied: PAIR_DENIED, text: TEXT };
for (const verifier of [true, false]) {
  for (const [first, kind] of Object.entries(FIRST)) {
    const config = verifier ? "verifier" : "no verifier";
    it(`pair model, ${config}, ${first} first`, async () => {
      const group = cases
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) => item.verifier === verifier && item.events[0] === kind,
        );
      // Without generated cases only the cases listed above run.
      if (!casesFile && group.length === 0) return;
      expect(group.length).toBeGreaterThan(0);
      const agent = await startAgent(verifier);
      try {
        for (const { item, index } of group) {
          expect(await replay(agent, item, index)).toEqual(item);
        }
      } finally {
        await agent.cleanup();
      }
    }, 900_000);
  }
}
