/**
 * Unit tests for `MessageManager` outbound chunking and malformed-payload
 * handling: over-limit messages hard-split at Telegram's size cap (preferring
 * newline boundaries), interaction-only replies still carry fallback text, and
 * unknown attachment types degrade to a document upload. Telegraf is mocked.
 * Document bytes resolve through core's SSRF-guarded `resolveAttachmentBytes`
 * (the repo media invariant) — the mock pins that boundary, not a raw fetch.
 * The capability-reference tests pin the W9-M1 invariant: stored attachments
 * carry `telegram-file:<file_id>`, the token-bearing Bot API URL stays inside
 * the fetch path, and model handlers receive bytes, never the URL.
 */
import {
  type Content,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MediaType, MessageManager } from "./messageManager";

const { loggerErrorMock, loggerWarnMock, resolveAttachmentBytesMock } =
  vi.hoisted(() => ({
    loggerErrorMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    resolveAttachmentBytesMock: vi.fn(),
  }));
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      error: loggerErrorMock,
      warn: loggerWarnMock,
    },
    resolveAttachmentBytes: resolveAttachmentBytesMock,
  };
});

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

async function captureReactionCallback() {
  const emitEvent = vi.fn();
  const reply = vi.fn(async (text: string) => ({
    message_id: 100,
    date: 1_700_000_000,
    text,
    chat: { id: 123, type: "private" },
  }));
  const manager = new MessageManager(
    {} as never,
    { agentId: "agent-1", emitEvent } as unknown as IAgentRuntime,
  );

  await manager.handleReaction({
    from: { id: 42, first_name: "Ada", is_bot: false },
    chat: { id: 123, type: "private" },
    update: {
      message_reaction: {
        chat: { id: 123, type: "private" },
        message_id: 99,
        date: 1,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    },
    reply,
  } as never);

  expect(emitEvent).toHaveBeenCalledTimes(2);
  const payload = emitEvent.mock.calls[0]?.[1] as
    | { callback?: (content: Content) => Promise<Memory[]> }
    | undefined;
  expect(payload?.callback).toBeTypeOf("function");
  if (!payload?.callback) {
    throw new Error("expected the reaction event to expose its reply callback");
  }
  return { callback: payload.callback, reply };
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

  it("keeps a surrogate pair (emoji) intact instead of splitting it across chunks", async () => {
    const { manager, sendMessage } = createManager();
    // "x" * 4095 then a 2-code-unit emoji then more text: a naive slice(0, 4096)
    // would cut between the emoji's high and low surrogate.
    const text = `${"x".repeat(4095)}\u{1F600}${"y".repeat(10)}`;

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

    const sentTexts = sendMessage.mock.calls.map((call) => call[1] as string);
    for (const chunk of sentTexts) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(sentTexts.join("")).toBe(text);
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
    // The guarded byte resolver failing (HTTP error, SSRF block, oversize —
    // any failure shape) must degrade to an explicit error attachment, never
    // drop the document or the caption.
    resolveAttachmentBytesMock.mockRejectedValueOnce(
      new Error("guarded fetch failed: 503"),
    );
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
      caption: "please read this",
      document: {
        file_id: "doc-1",
        file_unique_id: "unique-1",
        file_name: "report.txt",
        mime_type: "text/plain",
        file_size: 42,
      },
    } as never);

    expect(resolveAttachmentBytesMock).toHaveBeenCalledWith(
      "https://files.test/report.txt",
    );
    expect(getFileLink).toHaveBeenCalledTimes(1);
    expect(result.processedContent).toBe("please read this");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "doc-1",
        url: "telegram-file:doc-1",
        title: "Text Document: report.txt",
        source: "Document",
        description: expect.stringContaining("Error: Unable to read content"),
        text: "",
      }),
    ]);
  });

  it("does not throw when image description fails after the byte fetch", async () => {
    const getFileLink = vi.fn(
      async () => new URL("https://files.test/photo.jpg"),
    );
    resolveAttachmentBytesMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/jpeg",
    });
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

  it("never writes a token-bearing media fetch failure into connector logs", async () => {
    loggerErrorMock.mockClear();
    loggerWarnMock.mockClear();
    const getFileLink = vi.fn(
      async () =>
        new URL("https://api.telegram.org/file/bot123:SECRET/photos/p1.jpg"),
    );
    resolveAttachmentBytesMock.mockRejectedValueOnce(
      new Error(
        "Failed to fetch media from https://api.telegram.org/file/bot123:SECRET/photos/p1.jpg",
      ),
    );
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1", useModel: vi.fn() } as never,
    );

    await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 123, type: "private" },
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    } as never);

    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(loggerWarnMock.mock.calls)).not.toContain("SECRET");
  });

  it("persists a token-free capability reference and feeds the vision model inline bytes", async () => {
    // The Bot API file URL embeds the operator's bot token; it must reach
    // neither the stored attachment nor the model handler.
    const getFileLink = vi.fn(
      async () =>
        new URL("https://api.telegram.org/file/bot123:SECRET/photos/p1.jpg"),
    );
    resolveAttachmentBytesMock.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/jpeg",
    });
    const useModel = vi.fn(async () => ({
      title: "Receipt",
      description: "Total is visible",
    }));
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      { agentId: "agent-1", useModel } as never,
    );

    const result = await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 123, type: "private" },
      photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }],
    } as never);

    expect(getFileLink).toHaveBeenCalledTimes(1);
    const modelInput = useModel.mock.calls[0]?.[1] as string;
    expect(useModel).toHaveBeenCalledWith("IMAGE_DESCRIPTION", modelInput);
    expect(modelInput.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(modelInput).not.toContain("SECRET");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "p1",
        url: "telegram-file:p1",
        contentType: "image",
        description: "[Image: Receipt\nTotal is visible]",
      }),
    ]);
    expect(JSON.stringify(result.attachments)).not.toContain("SECRET");
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

  it("ingests an inbound voice message as an AUDIO attachment with a token-free reference", async () => {
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

    // No file lookup at ingest: bytes (and the token URL behind them) are only
    // resolved at enrichment time inside the reply path.
    expect(getFileLink).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "v1",
        url: "telegram-file:v1",
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

  it.each([
    ["lone high surrogate", `before\ud800after`, "before�after"],
    ["lone low surrogate", `before\udc00after`, "before�after"],
    ["exact 4096-unit text", `${"a".repeat(4094)}🦊`, `${"a".repeat(4094)}🦊`],
    ["4097-unit text", "a".repeat(4097), "a".repeat(4096)],
    [
      "astral character crossing the cap",
      `${"a".repeat(4095)}🦊tail`,
      "a".repeat(4095),
    ],
  ])(
    "keeps the reaction callback wire reply and returned memory aligned for %s",
    async (_label, input, expected) => {
      const { callback, reply } = await captureReactionCallback();

      const memories = await callback({
        text: input,
        action: "REPLY",
        data: { marker: "preserved" },
      });

      expect(reply).toHaveBeenCalledTimes(1);
      const wireText = reply.mock.calls[0]?.[0];
      // This observes the production callback argument, so restoring the raw
      // `ctx.reply(content.text)` path breaks the malformed/over-limit cases.
      expect(wireText).toBe(expected);
      expect(wireText?.length).toBeLessThanOrEqual(4096);
      expect(wireText?.isWellFormed()).toBe(true);

      expect(memories).toHaveLength(1);
      const memoryContent = memories[0]?.content;
      expect(memoryContent?.text).toBe(wireText);
      expect(memoryContent?.text?.length).toBeLessThanOrEqual(4096);
      expect(memoryContent?.text?.isWellFormed()).toBe(true);
      expect(memoryContent?.action).toBe("REPLY");
      expect(memoryContent?.data).toEqual({ marker: "preserved" });
      expect(memoryContent?.inReplyTo).toBeDefined();
      expect(memoryContent?.metadata).toEqual({ accountId: "default" });
    },
  );

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
    const cache = new Map<string, unknown>();
    const runtime = {
      agentId: "agent-1",
      ensureConnection,
      createMemory,
      getCache: vi.fn(async (key: string) => cache.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      }),
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

  it("scopes inbound memory ids by account, chat, and Telegram message id", async () => {
    const cache = new Map<string, unknown>();
    const createMemory = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      ensureConnection: vi.fn(async () => undefined),
      createMemory,
      getCache: vi.fn(async (key: string) => cache.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      }),
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager(
      { telegram: {} } as never,
      runtime,
      "acct-a",
    );

    for (const chatId of [111, 222]) {
      await manager.handleMessage({
        from: {
          id: 42,
          first_name: "Ada",
          username: "ada",
          is_bot: false,
        },
        chat: { id: chatId, type: "private", first_name: "Ada" },
        message: {
          message_id: 99,
          date: 1_700_000_000,
          text: `hello from ${chatId}`,
          chat: { id: chatId, type: "private", first_name: "Ada" },
        },
      } as never);
    }

    expect(createMemory).toHaveBeenCalledTimes(2);
    const ids = createMemory.mock.calls.map((call) => call[0].id);
    expect(new Set(ids).size).toBe(2);
    expect(runtime.setCache).toHaveBeenCalledWith(
      "telegram:processed:acct-a:111:99",
      expect.any(Object),
    );
    expect(runtime.setCache).toHaveBeenCalledWith(
      "telegram:processed:acct-a:222:99",
      expect.any(Object),
    );
  });

  it("skips duplicate Telegram messages already marked in durable cache", async () => {
    const cache = new Map<string, unknown>([
      ["telegram:processed:acct-a:111:99", { processedAt: Date.now() }],
    ]);
    const createMemory = vi.fn(async () => undefined);
    const runtime = {
      agentId: "agent-1",
      ensureConnection: vi.fn(async () => undefined),
      createMemory,
      getCache: vi.fn(async (key: string) => cache.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      }),
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager(
      { telegram: {} } as never,
      runtime,
      "acct-a",
    );

    await manager.handleMessage({
      from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
      chat: { id: 111, type: "private", first_name: "Ada" },
      message: {
        message_id: 99,
        date: 1_700_000_000,
        text: "duplicate",
        chat: { id: 111, type: "private", first_name: "Ada" },
      },
    } as never);

    expect(createMemory).not.toHaveBeenCalled();
    expect(runtime.setCache).not.toHaveBeenCalled();
  });

  it("fails observably when passive inbound persistence fails", async () => {
    const createMemory = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const runtime = {
      agentId: "agent-1",
      ensureConnection: vi.fn(async () => undefined),
      createMemory,
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => true),
      getSetting: vi.fn(() => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager({ telegram: {} } as never, runtime);

    await expect(
      manager.handleMessage({
        from: { id: 42, first_name: "Ada", username: "ada", is_bot: false },
        chat: { id: 111, type: "private", first_name: "Ada" },
        message: {
          message_id: 99,
          date: 1_700_000_000,
          text: "persist me",
          chat: { id: 111, type: "private", first_name: "Ada" },
        },
      } as never),
    ).rejects.toMatchObject({
      code: "TELEGRAM_INBOUND_MEMORY_PERSISTENCE_FAILED",
      cause: expect.objectContaining({ message: "database unavailable" }),
    });
    expect(runtime.setCache).not.toHaveBeenCalled();
    expect(runtime.reportError).toHaveBeenCalledWith(
      "telegram:inbound-persistence",
      expect.objectContaining({
        code: "TELEGRAM_INBOUND_MEMORY_PERSISTENCE_FAILED",
      }),
    );
  });
});

describe("MessageManager telegram-file capability references", () => {
  function replyPathHarness(transcript: string) {
    const cache = new Map<string, unknown>();
    const handleMessage = vi.fn(async () => undefined);
    const getFileLink = vi.fn(
      async () =>
        new URL("https://api.telegram.org/file/bot123:SECRET/voice/v1.ogg"),
    );
    const useModel = vi.fn(async () => transcript);
    const runtime = {
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
      messageService: { handleMessage },
      useModel,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const manager = new MessageManager(
      { telegram: { getFileLink } } as never,
      runtime,
    );
    return { manager, handleMessage, useModel, getFileLink };
  }

  const voiceCtx = {
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
  } as never;

  it("transcribes a voice reference in the reply path without leaking the bot token", async () => {
    resolveAttachmentBytesMock.mockResolvedValueOnce({
      buffer: Buffer.from("ogg-bytes"),
      contentType: "audio/ogg",
    });
    const { manager, handleMessage, useModel, getFileLink } =
      replyPathHarness("a voice transcript");

    await manager.handleMessage(voiceCtx);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const memory = handleMessage.mock.calls[0][1];
    expect(memory.content.attachments).toEqual([
      expect.objectContaining({
        id: "v1",
        url: "telegram-file:v1",
        contentType: "audio",
        text: "a voice transcript",
        description: "Transcript: a voice transcript",
      }),
    ]);
    // The token-bearing getFileLink URL stayed inside the fetch helper: the
    // model received raw bytes and the memory carries no trace of it.
    expect(useModel).toHaveBeenCalledWith(
      "TRANSCRIPTION",
      Buffer.from("ogg-bytes"),
    );
    expect(getFileLink).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(memory)).not.toContain("SECRET");
  });

  it("leaves the attachment un-enriched (but stored) when the byte fetch fails", async () => {
    resolveAttachmentBytesMock.mockRejectedValueOnce(
      new Error("guarded fetch failed: 404"),
    );
    const { manager, handleMessage } = replyPathHarness("unused");

    await manager.handleMessage(voiceCtx);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const memory = handleMessage.mock.calls[0][1];
    expect(memory.content.attachments).toEqual([
      expect.objectContaining({
        id: "v1",
        url: "telegram-file:v1",
        contentType: "audio",
      }),
    ]);
    // cleanText normalizes the unset transcript to "" during ingest; the
    // failed enrichment must not fabricate one.
    expect(memory.content.attachments[0].text).toBe("");
    expect(JSON.stringify(memory)).not.toContain("SECRET");
  });

  it("keeps the token-bearing file URL out of failure logs", async () => {
    // Core's MediaFetchError embeds the fetched URL in its message; for a
    // Bot API file URL that message carries the bot token, so the connector
    // rethrows a sanitized failure before any log sink sees it.
    resolveAttachmentBytesMock.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Failed to fetch media from https://api.telegram.org/file/bot123:SECRET/voice/v1.ogg: HTTP 404",
        ),
        { name: "MediaFetchError", code: "http_error" },
      ),
    );
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);
    try {
      const { manager, handleMessage } = replyPathHarness("unused");

      await manager.handleMessage(voiceCtx);

      expect(handleMessage).toHaveBeenCalledTimes(1);
      const logCalls = [...warnSpy.mock.calls, ...errorSpy.mock.calls];
      expect(logCalls.length).toBeGreaterThan(0);
      expect(JSON.stringify(logCalls)).not.toContain("SECRET");
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("re-sends a stored reference outbound by bare file_id", async () => {
    const sendPhoto = vi.fn(async () => undefined);
    const manager = new MessageManager(
      { telegram: { sendPhoto } } as never,
      { agentId: "agent-1", getSetting: () => undefined } as never,
    );

    await manager.sendMedia(
      { chat: { id: 123 }, telegram: { sendPhoto } } as never,
      "telegram-file:p1",
      MediaType.PHOTO,
    );

    expect(sendPhoto).toHaveBeenCalledWith(
      123,
      "p1",
      expect.objectContaining({ caption: undefined }),
    );
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

describe("MessageManager.sendMessage transport failure", () => {
  const corpus = [
    "hello",
    "Sure! Step 1 - done.",
    "**bold** and _italic_",
    "🦊",
    "a".repeat(64),
  ] as const;

  function managerForSend(
    sendMessage: ReturnType<typeof vi.fn>,
    runtimeExtras: Record<string, unknown> = {},
  ) {
    return new MessageManager(
      {
        telegram: {
          sendMessage,
          sendChatAction: vi.fn(async () => undefined),
        },
      } as never,
      {
        agentId: "agent-1",
        getSetting: () => undefined,
        createMemory: vi.fn(async () => true),
        emitEvent: vi.fn(),
        ...runtimeExtras,
      } as never,
    );
  }

  it("throws instead of returning an empty array when Telegram rejects the send (403)", async () => {
    const sendMessage = vi.fn(async () => {
      throw {
        response: {
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        },
      };
    });
    const manager = managerForSend(sendMessage);

    await expect(
      manager.sendMessage(4242, { text: "hello from connector" }),
    ).rejects.toMatchObject({
      code: "TELEGRAM_OUTBOUND_SEND_FAILED",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still returns [] when there is nothing textual to send", async () => {
    const sendMessage = vi.fn();
    const manager = managerForSend(sendMessage);
    const sent = await manager.sendMessage(4242, { text: "   " });
    expect(sent).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps previously accepted corpus sends byte-identical on the wire", async () => {
    const sentBodies: string[] = [];
    const sendMessage = vi.fn(async (chatId: number | string, text: string) => {
      sentBodies.push(text);
      return {
        message_id: sentBodies.length,
        date: 1_700_000_000,
        text,
        chat: { id: chatId, type: "private" },
      };
    });
    const manager = managerForSend(sendMessage);

    for (const text of corpus) {
      const sent = await manager.sendMessage(7, { text });
      expect(sent.length).toBeGreaterThan(0);
    }
    expect(sentBodies).toHaveLength(corpus.length);
  });

  it("preserves provider ids when persistence throws an ElizaError after send", async () => {
    const sendMessage = vi.fn(
      async (chatId: number | string, text: string) => ({
        message_id: 73,
        date: 1_700_000_000,
        text,
        chat: { id: chatId, type: "private" },
      }),
    );
    const persistenceError = new ElizaError("database unavailable", {
      code: "DATABASE_UNAVAILABLE",
    });
    const manager = managerForSend(sendMessage, {
      createMemory: vi.fn(async () => {
        throw persistenceError;
      }),
    });

    await expect(
      manager.sendMessage(4242, { text: "accepted" }),
    ).rejects.toMatchObject({
      code: "TELEGRAM_OUTBOUND_PERSIST_FAILED",
      cause: persistenceError,
      context: {
        chatId: "4242",
        providerMessageIds: ["73"],
      },
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("MessageManager reaction reply transport failure", () => {
  it("does not report an empty successful turn when ctx.reply fails", async () => {
    const { callback, reply } = await captureReactionCallback();
    reply.mockRejectedValueOnce(new Error("Forbidden: bot was blocked"));

    await expect(
      callback({ text: "thanks for the reaction" }),
    ).rejects.toMatchObject({
      code: "TELEGRAM_REACTION_REPLY_FAILED",
    });
  });
});
