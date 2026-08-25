/**
 * Regression for forum-topic text replies: `sendMessageInChunks` talks to
 * `ctx.telegram.sendMessage`, which does not inject Telegraf's
 * `message_thread_id`. Inbound `handleMessage` must forward the topic id on
 * every chunk, including chunks after the first that no longer carry
 * `reply_parameters`.
 */
import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

function forumRuntime(
  handleMessageImpl: (
    _runtime: unknown,
    _memory: unknown,
    callback: (content: Content) => Promise<Memory[]>,
  ) => Promise<void>,
) {
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-1",
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    getCache: vi.fn(async (key: string) => cache.get(key)),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    getSetting: vi.fn((key: string) =>
      key === "TELEGRAM_AUTO_REPLY" ? "true" : undefined,
    ),
    reportError: vi.fn(),
    messageService: {
      handleMessage: vi.fn(handleMessageImpl),
    },
  } as unknown as IAgentRuntime;
}

describe("Telegram forum topic text replies", () => {
  it("puts message_thread_id on every text chunk, including those without reply_parameters", async () => {
    const sendMessage = vi.fn(
      async (chatId: number | string, text: string) => ({
        message_id: 1,
        date: 1_700_000_000,
        text,
        chat: { id: chatId, type: "supergroup" },
      }),
    );
    const sendChatAction = vi.fn(async () => undefined);
    const runtime = forumRuntime(async (_runtime, _memory, callback) => {
      await callback({ text: `${"x".repeat(4096)}more` });
    });
    const manager = new MessageManager(
      { telegram: { sendMessage, sendChatAction } } as never,
      runtime,
    );

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: {
        id: -100123,
        type: "supergroup",
        is_forum: true,
        title: "Forum",
      },
      telegram: { sendMessage, sendChatAction },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        text: "hello in topic",
        is_topic_message: true,
        message_thread_id: 77,
        chat: {
          id: -100123,
          type: "supergroup",
          is_forum: true,
          title: "Forum",
        },
      },
    } as never);

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendMessage.mock.calls[0][2]?.reply_parameters).toEqual({
      message_id: 99,
    });
    expect(sendMessage.mock.calls[1][2]?.reply_parameters).toBeUndefined();
    for (const call of sendMessage.mock.calls) {
      expect(call[2]?.message_thread_id).toBe(77);
    }
  });

  it("does not attach a thread id for ordinary private chats", async () => {
    const sendMessage = vi.fn(
      async (chatId: number | string, text: string) => ({
        message_id: 1,
        date: 1_700_000_000,
        text,
        chat: { id: chatId, type: "private" },
      }),
    );
    const sendChatAction = vi.fn(async () => undefined);
    const runtime = forumRuntime(async (_runtime, _memory, callback) => {
      await callback({ text: "short reply" });
    });
    const manager = new MessageManager(
      { telegram: { sendMessage, sendChatAction } } as never,
      runtime,
    );

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: { id: 42, type: "private", first_name: "Ada" },
      telegram: { sendMessage, sendChatAction },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        text: "hello",
        chat: { id: 42, type: "private", first_name: "Ada" },
      },
    } as never);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty(
      "message_thread_id",
    );
  });
});
