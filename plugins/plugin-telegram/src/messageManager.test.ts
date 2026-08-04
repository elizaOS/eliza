/**
 * Unit tests for `MessageManager` outbound chunking and malformed-payload
 * handling: over-limit messages hard-split at Telegram's size cap (preferring
 * newline boundaries), interaction-only replies still carry fallback text, and
 * unknown attachment types produce a visible unsupported-media notice. Telegraf
 * is mocked.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MediaType, MessageManager } from "./messageManager";

const TELEGRAM_LIMIT = 4096;

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

function expectTelegramChunksValid(chunks: string[]) {
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect((chunk.match(/(?<!\\)\*/g) ?? []).length % 2).toBe(0);
    expect((chunk.match(/(?<!\\)_/g) ?? []).length % 2).toBe(0);
    expect((chunk.match(/(?<!\\)~/g) ?? []).length % 2).toBe(0);
    expect((chunk.match(/(?<!\\)`/g) ?? []).length % 2).toBe(0);
    expect((chunk.match(/(?<!\\)\[/g) ?? []).length).toBe(
      (chunk.match(/(?<!\\)\]\(/g) ?? []).length,
    );
  }
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

  it("keeps MarkdownV2-expanded chunks under Telegram's final limit", async () => {
    const { manager, sendMessage } = createManager();
    const text = "escaped punctuation! ".repeat(350);

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

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(
      sendMessage.mock.calls.every((call) => String(call[1]).length <= 4096),
    ).toBe(true);
    expect(sendMessage.mock.calls.map((call) => call[1]).join("")).toContain(
      "escaped punctuation\\!",
    );
  });

  it("rewraps a bold span longer than Telegram's final limit", async () => {
    const { manager, sendMessage } = createManager();
    const text = `**${"bold text ".repeat(600)}**`;

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

    const chunks = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(chunks.length).toBeGreaterThan(1);
    expectTelegramChunksValid(chunks);
    expect(chunks.every((chunk) => chunk.startsWith("*"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("*"))).toBe(true);
  });

  it("rewraps a fenced code block longer than Telegram's final limit", async () => {
    const { manager, sendMessage } = createManager();
    const text = `\`\`\`ts\n${"const value = 1;\n".repeat(420)}\`\`\``;

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

    const chunks = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(chunks.length).toBeGreaterThan(1);
    expectTelegramChunksValid(chunks);
    expect(chunks.every((chunk) => chunk.startsWith("```ts\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("```"))).toBe(true);
  });

  it("keeps link-adjacent long messages valid after MarkdownV2 conversion", async () => {
    const { manager, sendMessage } = createManager();
    const link = "[docs](https://example.test/path-v1)";
    const text = `${"read this! ".repeat(390)}${link}${" then continue. ".repeat(90)}`;

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

    const chunks = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(chunks.length).toBeGreaterThan(1);
    expectTelegramChunksValid(chunks);
    expect(chunks.join("")).toContain("[docs](https://example.test/path-v1)");
  });

  it("counts emoji using Telegram's UTF-16 message limit", async () => {
    const { manager, sendMessage } = createManager();
    const text = `prefix ${"🧪".repeat(2300)} suffix!`;

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

    const chunks = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(chunks.length).toBeGreaterThan(1);
    expectTelegramChunksValid(chunks);
    expect(chunks.join("")).toContain("🧪");
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

  it("keeps an inbound photo attachment on the canonical production path", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/photo.jpg"),
    );
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1" } as never,
    );

    const result = await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 123, type: "private" },
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    } as never);

    expect(result).toEqual({
      processedContent: "",
      attachments: [
        expect.objectContaining({
          id: "p1",
          url: "https://files.test/photo.jpg",
          contentType: "image",
        }),
      ],
    });
    const attachment = result.attachments[0];
    expect(attachment).not.toHaveProperty("text");
    expect(attachment).not.toHaveProperty("description");
  });

  it("does not throw when Telegram fails an image file lookup", async () => {
    const getFileLink = vi.fn(async () => {
      throw new Error("telegram file expired");
    });
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1" } as never,
    );

    await expect(
      manager.processMessage({
        message_id: 1,
        date: 1,
        chat: { id: 123, type: "private" },
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
      } as never),
    ).resolves.toEqual({ processedContent: "", attachments: [] });
    expect(getFileLink).toHaveBeenCalledTimes(1);
  });

  it("reports unknown attachment content types visibly instead of degrading to a document", async () => {
    const { manager } = createManager();
    const sendMessage = vi.fn(
      async (chatId: number | string, text: string) => ({
        message_id: 1,
        date: 1,
        text,
        chat: { id: chatId, type: "private" },
      }),
    );

    const sent = await manager.sendMessageInChunks(
      {
        chat: { id: 123 },
        telegram: { sendMessage, sendChatAction: vi.fn() },
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
    );
    expect(sent).toHaveLength(1);
    expect(sendMessage.mock.calls[0][1]).toContain(
      "I could not send this Telegram attachment",
    );
  });

  it("never drops the agent's text when sending an attachment", async () => {
    const { manager } = createManager();
    const sendPhoto = vi.fn(async (chatId: number | string) => ({
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "private" },
    }));
    const sendChatAction = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (chatId: number, text: string) => ({
      message_id: 2,
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
    expect(sent).toHaveLength(2);
    expect(String(sendMessage.mock.calls[0][1])).toContain(
      "here is your image",
    );
  });

  it("does not post an empty trailing message for an attachment-only reply", async () => {
    const { manager } = createManager();
    const sendPhoto = vi.fn(async (chatId: number | string) => ({
      message_id: 1,
      date: 1,
      chat: { id: chatId, type: "private" },
    }));
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
    expect(sent).toHaveLength(1);
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
    expect(result.attachments[0]).not.toHaveProperty("text");
    expect(result.attachments[0]).not.toHaveProperty("description");
  });

  it("passes inbound voice to messageService as audio without placeholder text", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/voice.ogg"),
    );
    const handleMessage = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      character: {
        name: "Agent",
        settings: {
          telegram: {
            botToken: "123456:ABCDEF",
            dmPolicy: "allowlist",
            allowFrom: ["42"],
          },
        },
      },
      getSetting: vi.fn((key: string) =>
        key === "TELEGRAM_AUTO_REPLY" ? "true" : undefined,
      ),
      ensureConnection: vi.fn(async () => undefined),
      messageService: { handleMessage },
      getService: vi.fn(() => null),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      runtime,
    );

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: { id: 123, type: "private", first_name: "Ada" },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        chat: { id: 123, type: "private", first_name: "Ada" },
        voice: {
          file_id: "v1",
          file_unique_id: "u1",
          duration: 3,
          mime_type: "audio/ogg",
        },
      },
    } as never);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const memory = handleMessage.mock.calls[0][1];
    expect(memory.content.attachments).toEqual([
      expect.objectContaining({
        id: "v1",
        url: "https://files.test/voice.ogg",
        contentType: "audio",
      }),
    ]);
    expect(memory.content.attachments[0]).not.toHaveProperty("text");
    expect(memory.content.attachments[0]).not.toHaveProperty("description");
    expect(memory.content.text).not.toContain("transcript");
    expect(memory.content.text.trim()).toBe("");
  });

  it("preserves Telegram text entity metadata using UTF-16 offsets", async () => {
    const createMemory = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      getSetting: vi.fn(() => undefined),
      ensureConnection: vi.fn(async () => undefined),
      createMemory,
    } as unknown as IAgentRuntime;
    const manager = new MessageManager({ telegram: {} } as never, runtime);

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: { id: 123, type: "private", first_name: "Ada" },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        text: "Go 🧪bold link",
        entities: [
          { type: "bold", offset: 5, length: 6 },
          {
            type: "text_link",
            offset: 12,
            length: 4,
            url: "https://example.test",
          },
        ],
        chat: { id: 123, type: "private", first_name: "Ada" },
      },
    } as never);

    const memory = createMemory.mock.calls[0][0];
    expect(memory.content.text).toBe("Go 🧪bold link");
    expect(memory.content.metadata.telegram.richText).toMatchObject({
      rawText: "Go 🧪bold link",
      entities: [
        { type: "bold", offset: 5, length: 6 },
        {
          type: "text_link",
          offset: 12,
          length: 4,
          url: "https://example.test",
        },
      ],
    });
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
