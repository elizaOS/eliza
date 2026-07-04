/**
 * Unit tests for `MessageManager` outbound chunking and malformed-payload
 * handling: over-limit messages hard-split at Telegram's size cap (preferring
 * newline boundaries), interaction-only replies still carry fallback text, and
 * unknown attachment types degrade to a document upload. Telegraf is mocked.
 */
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
  const runtime = { agentId: "agent-1", getSetting: () => undefined };

  return {
    manager: new MessageManager(bot as never, runtime as never),
    sendChatAction,
    sendMessage,
  };
}

describe("MessageManager long message splitting", () => {
  it("sends interaction-only replies with fallback text and inline keyboard", async () => {
    const { manager, sendMessage } = createManager();

    const sentMessages = await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: {
          sendChatAction: vi.fn(async () => undefined),
          sendMessage,
        },
      } as never,
      {
        text: "[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]",
      },
    );

    expect(sentMessages).toHaveLength(1);
    expect(sendMessage.mock.calls[0][1]).toBe("Choose an option:");
    expect(
      sendMessage.mock.calls[0][2]?.reply_markup?.inline_keyboard,
    ).toHaveLength(1);
  });

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

  it("keeps a text document attachment when fetching its contents fails", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/report.txt"),
    );
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: vi.fn(),
    }));
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);
    const manager = new MessageManager(
      {
        telegram: { getFileLink },
      } as never,
      { agentId: "agent-1" } as never,
    );

    try {
      const result = await manager.processMessage({
        message_id: 1,
        date: 1,
        chat: { id: 123, type: "private" },
        caption: "please read this",
        document: {
          file_id: "doc-1",
          file_unique_id: "unique-1",
          file_name: "report.txt",
          mime_type: "text/plain",
          file_size: 42,
        },
      } as never);

      expect(fetchMock).toHaveBeenCalledWith("https://files.test/report.txt");
      expect(getFileLink).toHaveBeenCalledTimes(2);
      expect(result.processedContent).toBe("please read this");
      expect(result.attachments).toEqual([
        expect.objectContaining({
          id: "doc-1",
          url: "https://files.test/report.txt",
          title: "Text Document: report.txt",
          source: "Document",
          description: expect.stringContaining("Error: Unable to read content"),
          text: "",
        }),
      ]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
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

  it("degrades an unknown attachment content type to a document send (and still awaits failures)", async () => {
    const { manager } = createManager();
    const sendDocument = vi.fn(async () => {
      throw new Error("telegram unavailable");
    });

    // Unknown/absent content types degrade to a document upload rather than
    // throwing synchronously (a sync throw inside Promise.all would abort the
    // whole reply); the underlying send failure is still awaited and propagated.
    await expect(
      manager.sendMessageInChunks(
        {
          chat: { id: 123 },
          telegram: { sendDocument },
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
    ).rejects.toThrow("telegram unavailable");
    expect(sendDocument).toHaveBeenCalled();
  });

  it("never drops the agent's text when sending an attachment", async () => {
    const { manager } = createManager();
    const sendPhoto = vi.fn(async () => undefined);
    const sendChatAction = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (chatId: number, text: string) => ({
      message_id: 1,
      date: 1,
      text,
      chat: { id: chatId, type: "private" },
    }));

    const sent = await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: { sendPhoto, sendMessage, sendChatAction },
      } as never,
      {
        text: "here is your image",
        attachments: [
          {
            id: "p1",
            url: "https://files.test/p.png",
            contentType: "image/png",
          },
        ],
      } as never,
    );

    expect(sendPhoto).toHaveBeenCalledTimes(1); // media sent
    expect(sendMessage).toHaveBeenCalledTimes(1); // prose NOT dropped
    expect(sent).toHaveLength(1);
    expect(String(sendMessage.mock.calls[0][1])).toContain(
      "here is your image",
    );
  });

  it("does not post an empty trailing message for an attachment-only reply", async () => {
    const { manager } = createManager();
    const sendPhoto = vi.fn(async () => undefined);
    const sendMessage = vi.fn();
    const sendChatAction = vi.fn(async () => undefined);

    const sent = await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: { sendPhoto, sendMessage, sendChatAction },
      } as never,
      {
        text: "",
        attachments: [
          {
            id: "p1",
            url: "https://files.test/p.png",
            contentType: "image/png",
          },
        ],
      } as never,
    );

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("ingests an inbound voice message as an AUDIO attachment", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/voice.ogg"),
    );
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1" } as never,
    );

    const result = await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 123, type: "private" },
      voice: {
        file_id: "v1",
        file_unique_id: "u1",
        duration: 3,
        mime_type: "audio/ogg",
      },
    } as never);

    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "v1",
        url: "https://files.test/voice.ogg",
        contentType: "audio",
      }),
    ]);
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

describe("MessageManager send resilience (sendWithRetry)", () => {
  function managerWith(sendMessage: ReturnType<typeof vi.fn>) {
    const telegram = {
      sendMessage,
      sendChatAction: vi.fn(async () => undefined),
    };
    const manager = new MessageManager(
      { telegram } as never,
      { agentId: "agent-1", getSetting: () => undefined } as never,
    );
    const ctx = { chat: { id: 123 }, telegram } as never;
    return { manager, ctx };
  }

  it("retries on 429 honoring retry_after, then succeeds", async () => {
    let calls = 0;
    const sendMessage = vi.fn(async (chatId: number | string, text: string) => {
      calls += 1;
      if (calls === 1) {
        throw { response: { error_code: 429, parameters: { retry_after: 0 } } };
      }
      return {
        message_id: 1,
        date: 1,
        text,
        chat: { id: chatId, type: "private" },
      };
    });
    const { manager, ctx } = managerWith(sendMessage);
    const sent = await manager.sendMessageInChunks(ctx, { text: "hi" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });

  it("falls back to plain text on a MarkdownV2 400 parse error", async () => {
    const sendMessage = vi.fn(
      async (
        chatId: number | string,
        text: string,
        opts?: { parse_mode?: string },
      ) => {
        if (opts?.parse_mode === "MarkdownV2") {
          throw {
            response: {
              error_code: 400,
              description: "Bad Request: can't parse entities",
            },
          };
        }
        return {
          message_id: 1,
          date: 1,
          text,
          chat: { id: chatId, type: "private" },
        };
      },
    );
    const { manager, ctx } = managerWith(sendMessage);
    const sent = await manager.sendMessageInChunks(ctx, { text: "**bold**" });
    expect(sent).toHaveLength(1);
    // the successful (fallback) send must NOT carry parse_mode
    const fallbackCall = sendMessage.mock.calls.find(
      (call) =>
        (call[2] as { parse_mode?: string } | undefined)?.parse_mode ===
        undefined,
    );
    expect(fallbackCall).toBeDefined();
  });

  it("the plain-text fallback sends UNescaped text, not the MarkdownV2 backslash-escaped chunk", async () => {
    const sendMessage = vi.fn(
      async (
        chatId: number | string,
        text: string,
        opts?: { parse_mode?: string },
      ) => {
        if (opts?.parse_mode === "MarkdownV2") {
          throw {
            response: {
              error_code: 400,
              description: "Bad Request: can't parse entities",
            },
          };
        }
        return {
          message_id: 1,
          date: 1,
          text,
          chat: { id: chatId, type: "private" },
        };
      },
    );
    const { manager, ctx } = managerWith(sendMessage);
    // MarkdownV2 escapes `!`, `-`, `.` → "Sure\! Step 1 \- done\." on the
    // primary send. The fallback must degrade to the clean original, not that.
    await manager.sendMessageInChunks(ctx, { text: "Sure! Step 1 - done." });
    const fallbackCall = sendMessage.mock.calls.find(
      (call) =>
        (call[2] as { parse_mode?: string } | undefined)?.parse_mode ===
        undefined,
    );
    expect(fallbackCall).toBeDefined();
    const fallbackText = fallbackCall?.[1] as string;
    expect(fallbackText).not.toContain("\\");
    expect(fallbackText).toContain("Sure! Step 1 - done.");
  });

  it("does not retry a 403 (blocked) and propagates the error", async () => {
    const sendMessage = vi.fn(async () => {
      throw {
        response: {
          error_code: 403,
          description: "Forbidden: bot was blocked",
        },
      };
    });
    const { manager, ctx } = managerWith(sendMessage);
    await expect(
      manager.sendMessageInChunks(ctx, { text: "hi" }),
    ).rejects.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("MessageManager typing-indicator resilience", () => {
  it("still sends the reply when the typing action fails", async () => {
    const sendMessage = vi.fn(
      async (chatId: number | string, text: string) => ({
        message_id: 1,
        date: 1,
        text,
        chat: { id: chatId, type: "private" },
      }),
    );
    const sendChatAction = vi.fn(async () => {
      throw new Error("typing action failed");
    });
    const manager = new MessageManager(
      { telegram: { sendMessage, sendChatAction } } as never,
      { agentId: "agent-1", getSetting: () => undefined } as never,
    );
    const sent = await manager.sendMessageInChunks(
      { chat: { id: 123 }, telegram: { sendMessage, sendChatAction } } as never,
      { text: "hi" },
    );
    expect(sent).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
