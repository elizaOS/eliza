/**
 * Exercises Telegram ingress through real Telegraf long polling against a local
 * Bot API server. The harness captures serialized HTTP calls while production
 * middleware, policy, topic recovery, commands, and multi-account ownership run
 * unchanged; only api.telegram.org itself is replaced.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramService } from "./service";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const DEFAULT_TOKEN = "100000001:local_default_token";

interface CapturedCall {
  token: string;
  method: string;
  body: Record<string, unknown>;
  rawBody: string;
}

class LocalBotApi {
  readonly calls: CapturedCall[] = [];
  readonly deliveredUpdateIds = new Set<number>();
  readonly maxConcurrentPolls = new Map<string, number>();
  private readonly queuedUpdates = new Map<string, unknown[]>();
  private readonly activePolls = new Map<string, number>();
  private server: Server | undefined;
  private nextMessageId = 700;

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve),
    );
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Local Telegram Bot API did not bind a TCP port");
    }
    return `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server?.close((error) => (error ? reject(error) : resolve())),
    );
  }

  enqueue(token: string, update: Record<string, unknown>): void {
    const queued = this.queuedUpdates.get(token) ?? [];
    queued.push(update);
    this.queuedUpdates.set(token, queued);
  }

  callsFor(method: string, token?: string): CapturedCall[] {
    return this.calls.filter(
      (call) => call.method === method && (!token || call.token === token),
    );
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const match = req.url?.match(/^\/bot([^/]+)\/([^?]+)/);
    if (!match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const [, token, method] = match;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        // error-policy:J3 malformed client input remains visible in rawBody.
      }
      this.calls.push({ token, method, body, rawBody });
      this.respond(token, method, body, res);
    });
  }

  private respond(
    token: string,
    method: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): void {
    res.setHeader("content-type", "application/json");
    if (method === "getUpdates") {
      const active = (this.activePolls.get(token) ?? 0) + 1;
      this.activePolls.set(token, active);
      this.maxConcurrentPolls.set(
        token,
        Math.max(active, this.maxConcurrentPolls.get(token) ?? 0),
      );
      setTimeout(() => {
        const queued = this.queuedUpdates.get(token) ?? [];
        const result = body.offset === -1 ? [] : queued.splice(0);
        for (const update of result as Array<{ update_id?: unknown }>) {
          if (typeof update.update_id === "number") {
            this.deliveredUpdateIds.add(update.update_id);
          }
        }
        this.activePolls.set(token, active - 1);
        res.end(JSON.stringify({ ok: true, result }));
      }, 20);
      return;
    }

    if (method === "getMe") {
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            id: Number(token.split(":")[0]),
            is_bot: true,
            first_name: "Local Agent",
            username: `local_${token.split(":")[0]}_bot`,
          },
        }),
      );
      return;
    }

    if (method === "sendMessage") {
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: this.nextMessageId++,
            date: 1_700_000_100,
            text: body.text ?? "",
            chat: { id: body.chat_id, type: "supergroup", title: "Ops" },
            ...(body.message_thread_id
              ? {
                  is_topic_message: true,
                  message_thread_id: body.message_thread_id,
                }
              : {}),
          },
        }),
      );
      return;
    }

    res.end(JSON.stringify({ ok: true, result: true }));
  }
}

type RuntimeHarness = IAgentRuntime & {
  createMemory: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  ensureConnection: ReturnType<typeof vi.fn>;
  ensureRoomExists: ReturnType<typeof vi.fn>;
  ensureWorldExists: ReturnType<typeof vi.fn>;
  messageService: { handleMessage: ReturnType<typeof vi.fn> };
};

function createRuntime(args: {
  apiRoot: string;
  telegram: Record<string, unknown>;
  settings: Record<string, string>;
  memories?: Map<UUID, Memory>;
}): RuntimeHarness {
  const memories = args.memories ?? new Map<UUID, Memory>();
  return {
    agentId: AGENT_ID,
    character: {
      name: "Local Agent",
      settings: { telegram: args.telegram },
    },
    actions: [],
    getSetting: vi.fn((key: string) => args.settings[key]),
    getService: vi.fn(() => null),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) memories.set(memory.id, memory);
    }),
    updateMemory: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    emitEvent: vi.fn(),
    reportError: vi.fn(),
    messageService: { handleMessage: vi.fn(async () => undefined) },
  } as unknown as RuntimeHarness;
}

function sourceMemory(
  runtime: IAgentRuntime,
  messageId: number,
  threadId?: number,
): Memory {
  const chatId = "-1001";
  return {
    id: createUniqueUuid(runtime, `message:${chatId}:${messageId}`) as UUID,
    agentId: runtime.agentId,
    entityId: AGENT_ID,
    roomId: createUniqueUuid(
      runtime,
      threadId === undefined ? chatId : `${chatId}-${threadId}`,
    ) as UUID,
    content: { text: "source", source: "telegram" },
    metadata: {
      source: "telegram",
      accountId: "default",
      messageIdFull: String(messageId),
      telegramMessageKey: `message:${chatId}:${messageId}`,
      telegram: {
        chatId,
        messageId: String(messageId),
        ...(threadId === undefined ? {} : { threadId: String(threadId) }),
      },
    },
  };
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertNoIngressSideEffects(runtime: RuntimeHarness): void {
  expect(runtime.ensureConnection).not.toHaveBeenCalled();
  expect(runtime.ensureRoomExists).not.toHaveBeenCalled();
  expect(runtime.ensureWorldExists).not.toHaveBeenCalled();
  expect(runtime.createMemory).not.toHaveBeenCalled();
  expect(runtime.messageService.handleMessage).not.toHaveBeenCalled();
  expect(runtime.emitEvent).not.toHaveBeenCalled();
}

describe("TelegramService local Bot API integration", () => {
  let api: LocalBotApi;
  let apiRoot: string;
  const services: TelegramService[] = [];

  beforeEach(async () => {
    api = new LocalBotApi();
    apiRoot = await api.start();
  });

  afterEach(async () => {
    for (const service of services.splice(0)) {
      await service.stop();
    }
    await api.stop();
  });

  it("denies commands, callbacks, and owned-topic reactions before side effects", async () => {
    const memories = new Map<UUID, Memory>();
    const runtime = createRuntime({
      apiRoot,
      memories,
      telegram: {
        apiRoot,
        groupPolicy: "allowlist",
        groupAllowFrom: ["42"],
        groups: {
          "-1001": {
            requireMention: false,
            topics: { "77": { enabled: false, allowFrom: ["42"] } },
          },
        },
      },
      settings: { TELEGRAM_BOT_TOKEN: DEFAULT_TOKEN },
    });
    const source = sourceMemory(runtime, 10, 77);
    memories.set(source.id as UUID, source);
    const unownedTopicSource = sourceMemory(runtime, 12);
    memories.set(unownedTopicSource.id as UUID, unownedTopicSource);
    const service = await TelegramService.start(runtime);
    services.push(service);
    await waitFor(
      () => api.callsFor("getUpdates", DEFAULT_TOKEN).length > 0,
      "initial polling",
    );

    api.enqueue(DEFAULT_TOKEN, {
      update_id: 1,
      message: {
        message_id: 20,
        date: 1_700_000_000,
        text: "/tasks",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
        from: { id: 42, is_bot: false, first_name: "Ada" },
        chat: { id: -9999, type: "supergroup", title: "Other" },
      },
    });
    api.enqueue(DEFAULT_TOKEN, {
      update_id: 2,
      callback_query: {
        id: "callback-2",
        from: { id: 42, is_bot: false, first_name: "Ada" },
        chat_instance: "local",
        data: "foreign",
        message: {
          message_id: 21,
          date: 1_700_000_001,
          text: "button",
          chat: { id: -9999, type: "supergroup", title: "Other" },
        },
      },
    });
    api.enqueue(DEFAULT_TOKEN, {
      update_id: 3,
      message_reaction: {
        chat: {
          id: -1001,
          type: "supergroup",
          title: "Ops",
          is_forum: true,
        },
        message_id: 10,
        user: { id: 42, is_bot: false, first_name: "Ada" },
        date: 1_700_000_002,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });
    api.enqueue(DEFAULT_TOKEN, {
      update_id: 4,
      message_reaction: {
        chat: {
          id: -1001,
          type: "supergroup",
          title: "Ops",
          is_forum: true,
        },
        message_id: 12,
        user: { id: 42, is_bot: false, first_name: "Ada" },
        date: 1_700_000_003,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "?" }],
      },
    });

    await waitFor(
      () => api.deliveredUpdateIds.has(4),
      "denied updates to cross the polling boundary",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assertNoIngressSideEffects(runtime);
    expect(api.callsFor("sendMessage")).toHaveLength(0);
    expect(api.callsFor("answerCallbackQuery")).toHaveLength(0);
    expect(api.callsFor("pinChatMessage")).toHaveLength(0);
  });

  it("recovers reaction topic ownership and replies in the stored topic", async () => {
    const memories = new Map<UUID, Memory>();
    const runtime = createRuntime({
      apiRoot,
      memories,
      telegram: {
        apiRoot,
        groupPolicy: "allowlist",
        groupAllowFrom: ["42"],
        groups: {
          "-1001": {
            requireMention: true,
            topics: { "88": { enabled: true, allowFrom: ["42"] } },
          },
        },
      },
      settings: { TELEGRAM_BOT_TOKEN: DEFAULT_TOKEN },
    });
    const source = sourceMemory(runtime, 11, 88);
    memories.set(source.id as UUID, source);
    const service = await TelegramService.start(runtime);
    services.push(service);

    api.enqueue(DEFAULT_TOKEN, {
      update_id: 11,
      message_reaction: {
        chat: {
          id: -1001,
          type: "supergroup",
          title: "Ops",
          is_forum: true,
        },
        message_id: 11,
        user: { id: 42, is_bot: false, first_name: "Ada" },
        date: 1_700_000_011,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "✅" }],
      },
    });

    await waitFor(
      () => runtime.emitEvent.mock.calls.length === 2,
      "reaction events",
    );
    const payload = runtime.emitEvent.mock.calls[0][1] as {
      message: Memory;
      callback: HandlerCallback;
    };
    expect(payload.message.roomId).toBe(source.roomId);
    expect(payload.message.content.inReplyTo).toBe(source.id);
    expect(payload.message.metadata?.telegram).toMatchObject({
      chatId: "-1001",
      threadId: "88",
    });

    await payload.callback({ text: "reaction received" });
    const send = api.callsFor("sendMessage")[0];
    expect(send.body).toMatchObject({
      chat_id: -1001,
      message_thread_id: 88,
      reply_parameters: { message_id: 11 },
    });
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory.mock.calls[0][0].roomId).toBe(source.roomId);
  });

  it("runs one live poll per distinct account token and rejects shared tokens before HTTP", async () => {
    const accountTokens = {
      alerts: "100000002:local_alerts_token",
      ops: "100000003:local_ops_token",
    };
    const runtime = createRuntime({
      apiRoot,
      telegram: {
        accounts: {
          alerts: { apiRoot, groupPolicy: "disabled" },
          ops: { apiRoot, groupPolicy: "disabled" },
        },
      },
      settings: {
        TELEGRAM_ACCOUNT_TOKENS_JSON: JSON.stringify(accountTokens),
      },
    });
    const service = await TelegramService.start(runtime);
    services.push(service);

    await waitFor(
      () =>
        Object.values(accountTokens).every(
          (token) => api.callsFor("getUpdates", token).length > 0,
        ),
      "both account pollers",
    );
    expect(service.getBots()).toHaveLength(2);
    for (const token of Object.values(accountTokens)) {
      expect(api.maxConcurrentPolls.get(token)).toBe(1);
    }

    const duplicateRuntime = createRuntime({
      apiRoot,
      telegram: {
        accounts: {
          first: { apiRoot, groupPolicy: "disabled" },
          second: { apiRoot, groupPolicy: "disabled" },
        },
      },
      settings: {
        TELEGRAM_ACCOUNT_TOKENS_JSON: JSON.stringify({
          first: "100000004:shared_token",
          second: "100000004:shared_token",
        }),
      },
    });
    const callsBeforeDuplicate = api.calls.length;

    await expect(TelegramService.start(duplicateRuntime)).rejects.toMatchObject(
      {
        code: "TELEGRAM_DUPLICATE_BOT_TOKEN",
      },
    );
    expect(api.calls).toHaveLength(callsBeforeDuplicate);
  });
});
