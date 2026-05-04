import type { Content } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatMessageContext } from "./types";

function createMessage(
  overrides: Partial<WechatMessageContext> = {},
): WechatMessageContext {
  return {
    id: "wechat-msg-1",
    type: "text",
    sender: "wxid-alice",
    recipient: "wxid-agent",
    content: "hello agent",
    timestamp: 123,
    raw: { type: 60001 },
    ...overrides,
  };
}

function createRuntime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("deliverIncomingWechatMessage", () => {
  it("routes incoming messages through the runtime message API and reply callback", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn(
      async (
        _runtime: unknown,
        _memory: unknown,
        options?: {
          onResponse?: (content: Content) => Promise<unknown>;
        },
      ) => {
        await options?.onResponse?.({ text: "reply from agent" } as Content);
        return { responseContent: { text: "reply from agent" } as Content };
      },
    );
    const runtime = createRuntime({
      elizaOS: { sendMessage },
    });

    await deliverIncomingWechatMessage({
      runtime,
      accountId: "main",
      message: createMessage(),
      sendText,
    });

    expect(runtime.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: expect.any(String),
        roomId: expect.any(String),
        userName: "wxid-alice",
        userId: "wxid-alice",
        source: "wechat",
        channelId: "wxid-alice",
        worldName: "WeChat",
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const [, memory] = sendMessage.mock.calls[0];
    expect(memory).toEqual(
      expect.objectContaining({
        content: expect.objectContaining({
          text: "hello agent",
          source: "wechat",
          channelType: "DM",
        }),
        metadata: expect.objectContaining({
          type: "message",
          source: "wechat",
          provider: "wechat",
          fromId: "wxid-alice",
          wechat: expect.objectContaining({
            userId: "wxid-alice",
            messageId: "wechat-msg-1",
          }),
        }),
      }),
    );

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      "main",
      "wxid-alice",
      "reply from agent",
    );
    expect(runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          text: "reply from agent",
          source: "wechat",
          channelType: "DM",
        }),
      }),
      "messages",
    );
  });

  it("falls back to MESSAGE_RECEIVED events when no message pipeline is available", async () => {
    const runtime = createRuntime();

    await deliverIncomingWechatMessage({
      runtime,
      accountId: "main",
      message: createMessage(),
      sendText: vi.fn().mockResolvedValue(undefined),
    });

    expect(runtime.emitEvent).toHaveBeenCalledWith(["MESSAGE_RECEIVED"], {
      runtime,
      message: expect.objectContaining({
        content: expect.objectContaining({
          text: "hello agent",
          source: "wechat",
        }),
      }),
      callback: expect.any(Function),
      source: "wechat",
    });
  });
});
