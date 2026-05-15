import { describe, expect, it, vi } from "vitest";
import { Bot } from "./bot";
import { normalizePayload } from "./callback-server";
import type { ProxyClient } from "./proxy-client";
import { ReplyDispatcher } from "./reply-dispatcher";
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
});
