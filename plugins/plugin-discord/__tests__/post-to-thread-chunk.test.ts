/**
 * Regressions for postToConnectorThread delivery contract (PR #20079).
 * Drives the REAL postToConnectorThread through both webhook and bot fallback
 * paths and asserts the shared outbound contract:
 *  - ordered chunks each <= 2000 chars
 *  - all accepted chunks are persisted via createMemory
 *  - later chunk failure still persists the accepted prefix and does not throw as if nothing delivered
 *  - short message compatibility
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { DiscordService } from "../service.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
let idCounter = 0;

function makeMessage(id: string, content: string) {
  return {
    id,
    content,
    createdTimestamp: Date.now(),
    url: `https://discord.com/channels/1/${id}`,
    author: {
      id: "bot-id",
      username: "bot",
      globalName: "Bot",
      displayName: "Bot",
      bot: true,
      displayAvatarURL: () => "",
    },
    channel: {
      id: "thread-chan",
      type: 11,
      guild: null,
    },
    guild: null,
    attachments: { size: 0 },
    reference: null,
  };
}

function makeRuntime() {
  const created: Memory[] = [];
  const errors: Array<{ scope: string; err: unknown; meta: unknown }> = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getMemoryById: vi.fn(async () => null),
    createMemory: vi.fn(async (mem: Memory) => {
      created.push(mem);
      return mem.id;
    }),
    reportError: vi.fn((scope: string, err: unknown, meta: unknown) => {
      errors.push({ scope, err, meta });
    }),
    getEntityById: async () => null,
    getRoom: async () => null,
    ensureConnection: async () => {},
  } as unknown as IAgentRuntime & {
    created: Memory[];
    errors: Array<{ scope: string; err: unknown; meta: unknown }>;
  };
  (runtime as unknown as { created: Memory[] }).created = created;
  (runtime as unknown as { errors: typeof errors }).errors = errors;
  return runtime as IAgentRuntime & { created: Memory[]; errors: typeof errors };
}

function makeService(
  runtime: IAgentRuntime,
  opts: {
    threadSend?: (content: string) => Promise<unknown>;
    parentChannel?: unknown;
    webhookSend?: (opts: unknown) => Promise<unknown>;
    webhook?: unknown;
  } = {},
) {
  const threadChannel = {
    id: "thread-123",
    type: 11,
    send: vi.fn(async (content: string) => {
      if (opts.threadSend) return opts.threadSend(content);
      const id = `msg-${++idCounter}`;
      return makeMessage(id, typeof content === "string" ? content : (content as { content: string }).content);
    }),
    isTextBased: () => true,
    isThread: () => true,
    parentId: "parent-123",
  };

  const parentChannel = opts.parentChannel ?? {
    id: "parent-123",
    name: "general",
    fetchWebhooks: vi.fn(async () => ({ find: () => null } as unknown as Map<string, unknown>)),
    createWebhook: vi.fn(async () => null),
  };

  const webhook = opts.webhook ?? (opts.webhookSend
    ? {
        name: "Eliza",
        send: vi.fn(async (o: unknown) => {
          const res = await (opts.webhookSend as (x: unknown) => Promise<unknown>)(o);
          return res;
        }),
      }
    : null);

  const client = {
    isReady: () => true,
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id === threadChannel.id || id.startsWith("thread-")) return threadChannel as unknown as never;
        if (id === "parent-123") return parentChannel as unknown as never;
        return null;
      }),
    },
    user: { id: "bot-id", username: "bot" },
  };

  const service = Object.assign(Object.create(DiscordService.prototype), {
    runtime,
    agentId: AGENT_ID,
    accountId: "default",
    defaultAccountId: "default",
    accountPool: {
      get: () => ({
        accountId: "default",
        client,
        settings: {},
        account: { accountId: "default" },
      }),
    },
    getAccountState: () => ({ accountId: "default", client, settings: {} }),
    requireAccountState: () => ({ accountId: "default", client, settings: {} }),
    resolveAccountIdFromTarget: () => "default",
    getChannelType: async () => "GROUP" as unknown as never,
    resolveDiscordEntityId: (id: string) => id as UUID,
    createAccountServiceFacade: (s: unknown) => s,
    findOrCreateWebhook: vi.fn(async () => webhook),
    buildMemoryFromMessage: async (msg: { id: string; content: string; createdTimestamp: number; url: string; channel: unknown }, _opts: unknown) => {
      // real builder would copy message content; simplified
      const { createUniqueUuid } = await import("@elizaos/core");
      return {
        id: createUniqueUuid(runtime, msg.id),
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: createUniqueUuid(runtime, (msg.channel as { id: string }).id ?? "room"),
        content: { text: msg.content, source: "discord" },
        metadata: { type: "message" as const },
        createdAt: msg.createdTimestamp,
      } as Memory;
    },
  }) as unknown as DiscordService;

  // expose for assertions
  (service as unknown as { __threadChannel: typeof threadChannel }).__threadChannel = threadChannel;
  (service as unknown as { __webhook: typeof webhook }).__webhook = webhook as never;
  return service as DiscordService & { __threadChannel: typeof threadChannel; __webhook: unknown };
}

beforeEach(() => {
  idCounter = 0;
  // reset global dedupe between tests by using distinct thread ids/texts is enough,
  // but also clear any in-flight state by waiting a tick; not needed.
});

describe("postToConnectorThread delivery contract", () => {
  it("chunks long messages into ordered <=2000 pieces via bot fallback and persists all", async () => {
    const runtime = makeRuntime();
    const sentContents: string[] = [];
    const service = makeService(runtime, {
      threadSend: async (content: string) => {
        const c = typeof content === "string" ? content : (content as { content: string }).content;
        sentContents.push(c);
        return makeMessage(`msg-${++idCounter}`, c);
      },
    });
    const longText = "a".repeat(5000);
    // ensure chunking splits
    const threadId = `thread-${Date.now()}-${Math.random()}`;
    (service as unknown as { __threadChannel: { id: string } }).__threadChannel.id = threadId;
    const client = (service as unknown as { accountPool: { get: () => { client: { channels: { fetch: unknown } } } } }).accountPool.get().client;
    // patch fetch to return thread channel for this id
    const origFetch = (client.channels.fetch as unknown as ReturnType<typeof vi.fn>);
    (client.channels.fetch as unknown as ReturnType<typeof vi.fn>) = vi.fn(async (id: string) => {
      if (id === threadId) return (service as unknown as { __threadChannel: unknown }).__threadChannel as never;
      if (id === "parent-123") return null;
      return origFetch(id);
    });

    const result = await service.postToConnectorThread(runtime, {
      thread: { threadId, parentChannelId: undefined as unknown as string },
      content: { text: longText },
      target: undefined as unknown as never,
    } as never);

    expect(sentContents.length).toBeGreaterThan(1);
    for (const c of sentContents) expect(c.length).toBeLessThanOrEqual(2000);
    // recombined in order
    expect(sentContents.join("")).toBe(longText);
    // all accepted persisted
    expect(runtime.created.length).toBe(sentContents.length);
    expect(result).toBeDefined();
  });

  it("forwards webhook identity params and persists all chunks via webhook path", async () => {
    const runtime = makeRuntime();
    const webhookCalls: unknown[] = [];
    const service = makeService(runtime, {
      webhookSend: async (opts: unknown) => {
        webhookCalls.push(opts);
        const o = opts as { content: string };
        return makeMessage(`msg-${++idCounter}`, o.content);
      },
      webhook: {
        name: "Eliza",
        send: async (opts: unknown) => {
          webhookCalls.push(opts);
          const o = opts as { content: string };
          return makeMessage(`msg-${++idCounter}`, o.content);
        },
      },
    });
    // force webhook path: need parentChannelId and identity
    const threadId = `thread-webhook-${Date.now()}`;
    (service as unknown as { __threadChannel: { id: string } }).__threadChannel.id = threadId;
    const longText = "b".repeat(4200);
    const result = await service.postToConnectorThread(runtime, {
      thread: { threadId, parentChannelId: "parent-123" },
      content: { text: longText },
      identity: { name: "Eliza", avatarUrl: "https://example.com/avatar.png" },
      target: undefined as unknown as never,
    } as never);

    expect(webhookCalls.length).toBeGreaterThan(1);
    for (const c of webhookCalls) {
      const o = c as { username: string; avatarURL: string; threadId: string; content: string };
      expect(o.username).toBe("Eliza");
      expect(o.avatarURL).toBe("https://example.com/avatar.png");
      expect(o.threadId).toBe(threadId);
      expect(o.content.length).toBeLessThanOrEqual(2000);
    }
    expect(runtime.created.length).toBe(webhookCalls.length);
    expect(result).toBeDefined();
  });

  it("records partial delivery when later chunk fails: persists prefix, reports partial, does not duplicate on retry via dedupe", async () => {
    const runtime = makeRuntime();
    let call = 0;
    const service = makeService(runtime, {
      threadSend: async (content: string) => {
        call++;
        const c = typeof content === "string" ? content : (content as { content: string }).content;
        if (call === 1) return makeMessage(`msg-${++idCounter}`, c);
        throw Object.assign(new Error("send failed"), { code: "TEST_FAIL" });
      },
    });
    const threadId = `thread-partial-${Date.now()}`;
    (service as unknown as { __threadChannel: { id: string } }).__threadChannel.id = threadId;
    const longText = "x".repeat(5000);

    const result = await service.postToConnectorThread(runtime, {
      thread: { threadId, parentChannelId: undefined as unknown as string },
      content: { text: longText },
      target: undefined as unknown as never,
    } as never);

    // should have returned prefix memory, not thrown
    expect(result).toBeDefined();
    expect(runtime.created.length).toBe(1);
    // reported partial delivery
    expect(runtime.reportError).toHaveBeenCalledWith(
      "discord:outbound-partial-delivery",
      expect.anything(),
      expect.objectContaining({ channelId: threadId }),
    );

    // second call with same params should hit dedupe and not send again
    call = 0;
    const second = await service.postToConnectorThread(runtime, {
      thread: { threadId, parentChannelId: undefined as unknown as string },
      content: { text: longText },
      target: undefined as unknown as never,
    } as never);
    // dedupe returns prior memory (via getMemoryById) or undefined; since getMemoryById returns null, it returns undefined without re-sending
    // call should remain 0 if deduped before send
    expect(call).toBe(0);
    expect(second).toBeUndefined();
  });

  it("short message sends single chunk and persists", async () => {
    const runtime = makeRuntime();
    const sent: string[] = [];
    const service = makeService(runtime, {
      threadSend: async (content: string) => {
        const c = typeof content === "string" ? content : (content as { content: string }).content;
        sent.push(c);
        return makeMessage(`msg-${++idCounter}`, c);
      },
    });
    const threadId = `thread-short-${Date.now()}`;
    (service as unknown as { __threadChannel: { id: string } }).__threadChannel.id = threadId;

    const result = await service.postToConnectorThread(runtime, {
      thread: { threadId },
      content: { text: "hello world" },
      target: undefined as unknown as never,
    } as never);

    expect(sent.length).toBe(1);
    expect(sent[0]).toBe("hello world");
    expect(runtime.created.length).toBe(1);
    expect(result).toBeDefined();
  });
});
