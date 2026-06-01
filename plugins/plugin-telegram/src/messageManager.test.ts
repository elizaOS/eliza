import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MediaType, MessageManager } from "./messageManager";

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

describe("MessageManager malformed payload handling", () => {
  it("falls back to basic document attachments when file lookup fails", async () => {
    const getFileLink = vi.fn(async () => {
      throw new Error("telegram file unavailable");
    });
    const manager = new MessageManager(
      {
        telegram: { getFileLink },
      } as never,
      { agentId: "agent-1" } as never,
    );

    const result = await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 123, type: "private" },
      document: {
        file_id: "doc-1",
        file_unique_id: "unique-1",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 42,
      },
    } as never);

    expect(result.processedContent).toBe("");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "doc-1",
        url: "",
        title: "Document: report.pdf",
        source: "Document",
        text: "Document: report.pdf\nSize: 42 bytes\nType: application/pdf",
      }),
    ]);
  });

  it("does not throw when image description or file lookup fails", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/photo.jpg"),
    );
    const useModel = vi.fn(async () => {
      throw new Error("vision failed");
    });
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1", useModel } as never,
    );

    await expect(
      manager.processMessage({
        message_id: 1,
        date: 1,
        chat: { id: 123, type: "private" },
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      } as never),
    ).resolves.toEqual({ processedContent: "", attachments: [] });
    expect(useModel).toHaveBeenCalled();
  });

  it("does not throw when Telegram fails the second image file lookup", async () => {
    const getFileLink = vi
      .fn()
      .mockResolvedValueOnce(new URL("https://files.test/photo.jpg"))
      .mockRejectedValueOnce(new Error("telegram file expired"));
    const useModel = vi.fn(async () => ({
      title: "Receipt",
      description: "Total is visible",
    }));
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1", useModel } as never,
    );

    await expect(
      manager.processMessage({
        message_id: 1,
        date: 1,
        chat: { id: 123, type: "private" },
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      } as never),
    ).resolves.toEqual({ processedContent: "", attachments: [] });
    expect(getFileLink).toHaveBeenCalledTimes(2);
    expect(useModel).toHaveBeenCalledWith(
      "IMAGE_DESCRIPTION",
      "https://files.test/photo.jpg",
    );
  });

  it("awaits attachment send failures instead of dropping rejected promises", async () => {
    const { manager } = createManager();

    await expect(
      manager.sendMessageInChunks(
        {
          chat: { id: 123 },
          telegram: {},
        } as never,
        {
          text: "",
          attachments: [
            {
              id: "a1",
              url: "https://files.test/file.bin",
              contentType: "application/octet-stream",
            },
          ],
        } as never,
      ),
    ).rejects.toThrow("Unsupported Telegram attachment content type");
  });

  it("ignores reaction updates with empty reaction arrays", async () => {
    const emitEvent = vi.fn();
    const manager = new MessageManager(
      {} as never,
      { agentId: "agent-1", emitEvent } as unknown as IAgentRuntime,
    );

    await manager.handleReaction({
      from: { id: 42, first_name: "Ada" },
      chat: { id: 123, type: "private" },
      update: {
        message_reaction: {
          chat: { id: 123, type: "private" },
          message_id: 99,
          date: 1,
          old_reaction: [],
          new_reaction: [],
        },
      },
      reply: vi.fn(),
    } as never);

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rejects missing chat context when sending media", async () => {
    const manager = new MessageManager(
      {
        telegram: {
          sendPhoto: vi.fn(),
          sendVideo: vi.fn(),
          sendDocument: vi.fn(),
          sendAudio: vi.fn(),
          sendAnimation: vi.fn(),
        },
      } as never,
      { agentId: "agent-1" } as never,
    );

    await expect(
      manager.sendMedia(
        { telegram: manager.bot.telegram } as never,
        "https://files.test/a.png",
        MediaType.PHOTO,
      ),
    ).rejects.toThrow("sendMedia: ctx.chat is undefined");
  });

  it("persists hostile text input after stripping null characters", async () => {
    const ensureConnection = vi.fn(async () => undefined);
    const createMemory = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      ensureConnection,
      createMemory,
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager({ telegram: {} } as never, runtime);
    const text = "hello\u0000 ```unterminated\n[link](javascript:alert(1))";

    await manager.handleMessage({
      from: {
        id: 42,
        first_name: "Ada\u0000",
        username: "ada",
        is_bot: false,
      },
      chat: { id: 123, type: "private", first_name: "Ada" },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        text,
        chat: { id: 123, type: "private", first_name: "Ada" },
      },
    } as never);

    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "123",
        type: "DM",
        userId: "42",
      }),
    );
    expect(createMemory).toHaveBeenCalledTimes(1);
    const memory = createMemory.mock.calls[0][0];
    expect(memory.content.text).toBe(
      "hello ```unterminated\n[link](javascript:alert(1))",
    );
    expect(memory.content.text).not.toContain("\u0000");
    expect(memory.metadata.telegram).toMatchObject({
      chatId: "123",
      messageId: "99",
    });
  });
});
