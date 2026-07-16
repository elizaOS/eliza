/**
 * Unit tests for WeChat inbound/outbound internals with mocked collaborators:
 * webhook normalization, connector account isolation, `Bot` dedup/gating, and
 * `ReplyDispatcher` chunking. No live proxy service.
 */
import type {
  IAgentRuntime,
  Memory,
  MessageConnectorQueryContext,
  MessageConnectorRegistration,
  TargetInfo,
  UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bot } from "./bot";
import { normalizePayload } from "./callback-server";
import wechatPlugin, { WechatChannel } from "./index";
import type { ProxyClient } from "./proxy-client";
import { ReplyDispatcher } from "./reply-dispatcher";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatMessageContext } from "./types";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeConnectorRuntime(memories: Memory[] = []): {
  runtime: IAgentRuntime;
  registrations: MessageConnectorRegistration[];
  getMemories: ReturnType<typeof vi.fn>;
} {
  const registrations: MessageConnectorRegistration[] = [];
  const getMemories = vi.fn(async () => memories);
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "WeChat Test" },
    getService: vi.fn(() => null),
    getSetting: vi.fn(() => undefined),
    getMemories,
    registerMessageConnector: vi.fn(
      (registration: MessageConnectorRegistration) => {
        registrations.push(registration);
      },
    ),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  return { runtime, registrations, getMemories };
}

function connectorMemory(
  text: string,
  accountId?: string,
  createdAt = Date.now(),
): Memory {
  return {
    agentId: AGENT_ID,
    entityId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: "00000000-0000-0000-0000-000000000003" as UUID,
    content: { text, source: "wechat" },
    metadata: {
      type: "message",
      source: "wechat",
      ...(accountId ? { accountId } : {}),
    },
    createdAt,
  } as Memory;
}

describe("@elizaos/plugin-wechat", () => {
  afterEach(async () => {
    await wechatPlugin.dispose?.();
    vi.restoreAllMocks();
  });

  it("normalizes supported direct and group webhook payloads", () => {
    expect(
      normalizePayload({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: 1_700_000_000,
          msgId: "direct-1",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        id: "direct-1",
        type: "text",
        sender: "wxid_alice",
        recipient: "wxid_bot",
        content: "hello",
        timestamp: 1_700_000_000,
        threadId: undefined,
        group: undefined,
      }),
    );

    expect(
      normalizePayload({
        data: {
          type: 80002,
          sender: "12345@chatroom",
          recipient: "wxid_bot",
          imageUrl: "https://example.com/image.jpg",
          roomName: "Team Chat",
          timestamp: 1_700_000_001,
          msgId: "group-1",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        id: "group-1",
        type: "image",
        threadId: "12345@chatroom",
        group: { subject: "Team Chat" },
        imageUrl: "https://example.com/image.jpg",
      }),
    );
  });

  it("deduplicates inbound messages before dispatching to runtime", () => {
    const onMessage = vi.fn();
    const bot = new Bot({ onMessage });
    const message: WechatMessageContext = {
      id: "msg-1",
      type: "text",
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "hello",
      timestamp: 1_700_000_000,
      raw: {},
    };

    bot.handleIncoming(message);
    bot.handleIncoming(message);
    bot.stop();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(message);
  });

  it("chunks long outgoing text through the proxy client", async () => {
    const client = {
      sendText: vi.fn(async () => undefined),
    } as ProxyClient;
    const dispatcher = new ReplyDispatcher({ client, chunkSize: 5 });

    await dispatcher.sendText("wxid_alice", "hello world");

    expect(client.sendText).toHaveBeenNthCalledWith(1, "wxid_alice", "hello");
    expect(client.sendText).toHaveBeenNthCalledWith(2, "wxid_alice", "world");
  });

  it("stamps trusted connector identity on inbound and reply memories", async () => {
    const accountId = "work-account";
    const message: WechatMessageContext = {
      id: "msg-identity",
      type: "text",
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "hello",
      timestamp: 1_700_000_000,
      raw: {},
    };
    const createMemory = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const sendMessage = vi.fn(
      async (
        _runtime: unknown,
        _incomingMemory: unknown,
        options?: {
          onResponse?: (content: { text: string }) => Promise<unknown>;
        },
      ) => {
        await options?.onResponse?.({ text: "hi back" });
        return undefined;
      },
    );
    const runtime = {
      agentId: "agent-id",
      ensureConnection: vi.fn(async () => undefined),
      createMemory,
      elizaOS: { sendMessage },
    };

    await deliverIncomingWechatMessage({
      runtime,
      accountId,
      message,
      sendText,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const incomingMemory = sendMessage.mock.calls[0]?.[1] as {
      content: { metadata?: Record<string, unknown> };
      metadata?: Record<string, unknown>;
    };
    expect(incomingMemory.metadata).toMatchObject({
      type: "message",
      source: "wechat",
      provider: "wechat",
      accountId,
    });
    expect(incomingMemory.content.metadata).toMatchObject({ accountId });

    expect(createMemory).toHaveBeenCalledOnce();
    const replyMemory = createMemory.mock.calls[0]?.[0] as {
      content: { metadata?: Record<string, unknown> };
      metadata?: Record<string, unknown>;
    };
    expect(replyMemory.metadata).toMatchObject({
      type: "message",
      source: "wechat",
      provider: "wechat",
      accountId,
    });
    expect(replyMemory.content.metadata).toMatchObject({ accountId });
    expect(sendText).toHaveBeenCalledWith(accountId, "wxid_alice", "hi back");
  });

  it("isolates connector-managed queries to the trusted account", async () => {
    const memories = [
      connectorMemory("work result", "work", 3),
      connectorMemory("personal result", "personal", 2),
      connectorMemory("legacy result", undefined, 1),
    ];
    const { runtime, registrations, getMemories } =
      makeConnectorRuntime(memories);
    vi.spyOn(WechatChannel.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(WechatChannel.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(WechatChannel.prototype, "getAccountIds").mockReturnValue([
      "work",
      "personal",
    ]);
    const listContacts = vi
      .spyOn(WechatChannel.prototype, "listContacts")
      .mockImplementation(async (accountId) =>
        accountId === "work"
          ? {
              friends: [{ wxid: "wxid_alice", name: "Alice" }],
              chatrooms: [],
            }
          : {
              friends: [{ wxid: "wxid_bob", name: "Bob" }],
              chatrooms: [],
            },
      );
    const sendText = vi
      .spyOn(WechatChannel.prototype, "sendText")
      .mockResolvedValue(undefined);

    await wechatPlugin.init(
      {
        connectors: {
          wechat: {
            accounts: {
              work: { apiKey: "work-key", proxyUrl: "https://work.test" },
              personal: {
                apiKey: "personal-key",
                proxyUrl: "https://personal.test",
              },
            },
          },
        },
      } as unknown as Record<string, string>,
      runtime,
    );

    const connector = registrations[0];
    expect(connector).toMatchObject({
      source: "wechat",
      accountRouting: "connector",
    });
    const context = {
      runtime,
      source: "wechat",
      accountId: "work",
      metadata: { accountId: "personal" },
    } satisfies MessageConnectorQueryContext;

    const targets = await connector?.resolveTargets?.("alice", context);
    expect(targets).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          source: "wechat",
          accountId: "work",
          channelId: "wxid_alice",
          metadata: { accountId: "work" },
        }),
        metadata: expect.objectContaining({ accountId: "work" }),
      }),
    ]);
    expect(listContacts).toHaveBeenCalledWith("work");
    expect(listContacts).not.toHaveBeenCalledWith("personal");

    listContacts.mockClear();
    const fetched = await connector?.fetchMessages?.(context, { limit: 10 });
    expect(fetched?.map((memory) => memory.content.text)).toEqual([
      "work result",
    ]);
    expect(listContacts).toHaveBeenCalledTimes(1);
    expect(listContacts).toHaveBeenCalledWith("work");
    expect(getMemories).toHaveBeenCalledTimes(1);

    getMemories.mockClear();
    const conflictingTarget = {
      source: "wechat",
      accountId: "personal",
      roomId: "00000000-0000-0000-0000-000000000004" as UUID,
      metadata: { accountId: "work" },
    } as TargetInfo;
    await expect(
      connector?.fetchMessages?.(context, { target: conflictingTarget }),
    ).resolves.toEqual([]);
    expect(getMemories).not.toHaveBeenCalled();

    await connector?.sendHandler?.(
      runtime,
      {
        source: "wechat",
        accountId: "work",
        channelId: "wxid_alice",
        metadata: { accountId: "personal" },
      } as TargetInfo,
      { text: "hello" },
    );
    expect(sendText).toHaveBeenCalledWith("work", "wxid_alice", "hello");

    await expect(
      connector?.sendHandler?.(
        runtime,
        {
          source: "wechat",
          channelId: "wxid_bob",
          metadata: { accountId: "personal" },
        } as TargetInfo,
        { text: "must not guess" },
      ),
    ).rejects.toThrow("requires an unambiguous accountId");
    await expect(
      connector?.listRooms?.({
        runtime,
        source: "wechat",
        metadata: { accountId: "personal" },
      }),
    ).resolves.toEqual([]);
  });

  it("keeps legacy unscoped memories readable for one configured account", async () => {
    const { runtime, registrations } = makeConnectorRuntime([
      connectorMemory("legacy single-account result"),
    ]);
    vi.spyOn(WechatChannel.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(WechatChannel.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(WechatChannel.prototype, "getAccountIds").mockReturnValue([
      "default",
    ]);
    vi.spyOn(WechatChannel.prototype, "listContacts").mockResolvedValue({
      friends: [{ wxid: "wxid_alice", name: "Alice" }],
      chatrooms: [],
    });

    await wechatPlugin.init(
      {
        connectors: {
          wechat: {
            apiKey: "default-key",
            proxyUrl: "https://default.test",
          },
        },
      } as unknown as Record<string, string>,
      runtime,
    );

    const connector = registrations[0];
    const context = {
      runtime,
      source: "wechat",
    } satisfies MessageConnectorQueryContext;
    const rooms = await connector?.listRooms?.(context);
    expect(rooms?.[0]?.target).toMatchObject({
      source: "wechat",
      accountId: "default",
    });
    const fetched = await connector?.fetchMessages?.(context, { limit: 10 });
    expect(fetched?.map((memory) => memory.content.text)).toEqual([
      "legacy single-account result",
    ]);
  });
});
