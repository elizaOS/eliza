/**
 * Unit tests for WeChat inbound/outbound internals with mocked collaborators:
 * webhook payload normalization, `Bot` dedup/gating and delivery failure
 * propagation, and `ReplyDispatcher` chunking. No live proxy service.
 */
import { describe, expect, it, vi } from "vitest";
import { Bot } from "./bot";
import { normalizePayload } from "./callback-server";
import { WechatDeliveryError } from "./delivery-error";
import type { ProxyClient } from "./proxy-client";
import { ReplyDispatcher } from "./reply-dispatcher";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatMessageContext } from "./types";

describe("@elizaos/plugin-wechat", () => {
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

  it("deduplicates inbound messages before dispatching to runtime", async () => {
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

    await bot.handleIncoming(message);
    await bot.handleIncoming(message);
    bot.stop();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(message);
  });

  it("propagates failed delivery and leaves the message retryable", async () => {
    const failure = new Error("runtime delivery failed");
    const onMessage = vi
      .fn<(message: WechatMessageContext) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const bot = new Bot({ onMessage });
    const message: WechatMessageContext = {
      id: "msg-retry",
      type: "text",
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "retry me",
      timestamp: 1_700_000_000,
      raw: {},
    };

    await expect(bot.handleIncoming(message)).rejects.toBe(failure);
    await expect(bot.handleIncoming(message)).resolves.toBeUndefined();
    bot.stop();

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("makes concurrent duplicates share the owning delivery failure", async () => {
    let rejectOwner: ((error: Error) => void) | undefined;
    const ownerResult = new Promise<void>((_resolve, reject) => {
      rejectOwner = reject;
    });
    const onMessage = vi.fn(() => ownerResult);
    const bot = new Bot({ onMessage });
    const message: WechatMessageContext = {
      id: "msg-concurrent",
      type: "text",
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "deliver once",
      timestamp: 1_700_000_000,
      raw: {},
    };

    const owner = bot.handleIncoming(message);
    const duplicate = bot.handleIncoming(message);
    const failure = new Error("runtime unavailable");
    rejectOwner?.(failure);

    await expect(owner).rejects.toBe(failure);
    await expect(duplicate).rejects.toBe(failure);
    expect(onMessage).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it("does not retry a message after its outbound side effect committed", async () => {
    const failure = new WechatDeliveryError("post-send persistence failed", {
      cause: new Error("database unavailable"),
      sideEffectCommitted: true,
    });
    const onMessage = vi.fn().mockRejectedValue(failure);
    const bot = new Bot({ onMessage });
    const message: WechatMessageContext = {
      id: "msg-committed",
      type: "text",
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "reply once",
      timestamp: 1_700_000_000,
      raw: {},
    };

    await expect(bot.handleIncoming(message)).rejects.toBe(failure);
    await expect(bot.handleIncoming(message)).resolves.toBeUndefined();
    expect(onMessage).toHaveBeenCalledTimes(1);
    bot.stop();
  });

  it("marks a failure after sending a reply as non-retryable", async () => {
    const sendText = vi.fn(async () => undefined);
    const persistenceFailure = new Error("database unavailable");
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      createMemory: vi.fn(async () => {
        throw persistenceFailure;
      }),
      elizaOS: {
        sendMessage: async (
          _runtime: unknown,
          _message: unknown,
          options?: {
            onResponse?: (content: { text: string }) => Promise<unknown>;
          },
        ) => {
          await options?.onResponse?.({ text: "hello back" });
          return undefined;
        },
      },
    };

    const delivery = deliverIncomingWechatMessage({
      runtime,
      accountId: "main",
      message: {
        id: "msg-runtime-committed",
        type: "text",
        sender: "wxid_alice",
        recipient: "wxid_bot",
        content: "hello",
        timestamp: 1_700_000_000,
        raw: {},
      },
      sendText,
    });

    await expect(delivery).rejects.toEqual(
      expect.objectContaining({
        cause: persistenceFailure,
        sideEffectCommitted: true,
      }),
    );
    expect(sendText).toHaveBeenCalledTimes(1);
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
});
