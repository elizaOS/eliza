import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

function createManager() {
  let messageId = 0;
  const sendMessage = vi.fn(async (chatId: number | string, text: string) => ({
    message_id: ++messageId,
    date: 1_700_000_000 + messageId,
    text,
    chat: { id: chatId, type: "private" },
  }));
  const sendChatAction = vi.fn(async () => undefined);
  const bot = {
    telegram: {
      sendChatAction,
      sendMessage,
    },
  };
  const runtime = { agentId: "agent-1" };

  return {
    manager: new MessageManager(bot as never, runtime as never),
    sendChatAction,
    sendMessage,
  };
}

describe("MessageManager long message splitting", () => {
  it("hard-splits a single over-limit line into Telegram-sized messages", async () => {
    const { manager, sendMessage } = createManager();
    const text = "x".repeat(4096 * 2 + 17);

    const sentMessages = await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: {
          sendChatAction: vi.fn(async () => undefined),
          sendMessage,
        },
      } as never,
      { text },
    );

    expect(sentMessages).toHaveLength(3);
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      "x".repeat(4096),
      "x".repeat(4096),
      "x".repeat(17),
    ]);
    expect(sendMessage.mock.calls.every((call) => call[1].length <= 4096)).toBe(
      true,
    );
    expect(sentMessages.map((message) => message.text).join("")).toBe(text);
  });

  it("prefers newline boundaries when they fit within Telegram's limit", async () => {
    const { manager, sendMessage } = createManager();
    const firstLine = "x".repeat(4094);
    const text = `${firstLine}\ny\nz`;

    await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: {
          sendChatAction: vi.fn(async () => undefined),
          sendMessage,
        },
      } as never,
      { text },
    );

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      `${firstLine}\ny`,
      "z",
    ]);
  });
});
