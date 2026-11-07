/**
 * Exercises Telegram ingress and sanitized delivery with the real message manager,
 * assistant, and PGlite runtime. Deterministic model fixtures and captured
 * Telegraf send calls replace external services; polling and Telegram are not run.
 */
import {
  type Content,
  createUniqueUuid,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { MessageManager } from "@elizaos/plugin-telegram";
import type { DeterministicModelFixture } from "@elizaos/testing/models";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/testing/runtime";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

interface DeliveredTelegramMessage {
  chatId: number | string;
  text: string;
}

/**
 * Drive one inbound group message through the REAL Telegram MessageManager and
 * capture everything the connector pushes through its outbound seam.
 */
async function driveTelegramTurn(options: {
  inboundText: string;
  fixtures?: DeterministicModelFixture[];
  /** Reply content the message service hands to the connector callback. */
  replyContent?: Content;
  /**
   * Replies handed to the callback in order. Each one's row is first written
   * under its responseId, as the assistant message service stores a reply.
   */
  processorReplies?: Content[];
  /** Make Telegram refuse every photo send. */
  failPhotos?: boolean;
  /** Filter metadata like plugin-sqlite: each value by `===`. */
  sqliteMetadataFilter?: boolean;
}): Promise<{
  delivered: DeliveredTelegramMessage[];
  photos: Array<{ chatId: number | string; filename?: string }>;
  chatId: number;
  /** The agent's stored message rows in the inbound chat's room. */
  agentRows: () => Promise<Memory[]>;
  manager: MessageManager;
}> {
  const harness = track(
    await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      fixtures: options.fixtures,
    }),
  );

  if (options.sqliteMetadataFilter) {
    // plugin-sqlite filters metadata with \`md[k] !== v\` (records.ts), so an
    // array value never matches; PGlite's \`@>\` containment hides that.
    const runtime = harness.runtime;
    const getMemories = runtime.getMemories.bind(runtime);
    runtime.getMemories = async (params) => {
      const rows = await getMemories(params);
      const wanted = params.metadata;
      if (!wanted) return rows;
      return rows.filter((row) =>
        Object.entries(wanted).every(
          ([key, value]) =>
            (row.metadata as Record<string, unknown> | undefined)?.[key] ===
            value,
        ),
      );
    };
  }

  // The bot is only touched for DM replies / media; a group text reply goes
  // out via `ctx.telegram` (captured below), so `apiRoot` is never hit. Point
  // it at the Mockoon telegram base when present so this composes with the
  // wire-mock fleet, else a placeholder that is never called.
  const apiRoot = process.env.ELIZA_MOCK_TELEGRAM_BASE ?? "http://127.0.0.1:0/";
  const bot = new Telegraf("123456:TEST_TOKEN", {
    telegram: { apiRoot },
  });
  const manager = new MessageManager(bot, harness.runtime, "default");

  // The connector's outbound seam. `sendMessageInChunks` calls exactly these
  // two methods; capturing them is the same surface that, in production, would
  // POST to `${apiRoot}/bot<token>/sendMessage`.
  const delivered: DeliveredTelegramMessage[] = [];
  const photos: Array<{ chatId: number | string; filename?: string }> = [];
  const captureTelegram = {
    sendChatAction: async () => true,
    sendPhoto: async (
      chatId: number | string,
      photo: { filename?: string },
    ): Promise<unknown> => {
      if (options.failPhotos) throw new Error("Bad Request: wrong file");
      photos.push({ chatId, filename: photo.filename });
      return { message_id: 900 + photos.length, chat: { id: chatId }, date: 0 };
    },
    sendMessage: async (
      chatId: number | string,
      text: string,
    ): Promise<unknown> => {
      delivered.push({ chatId, text });
      return {
        message_id: delivered.length,
        chat: { id: chatId, type: "group" },
        date: 0,
        text,
      };
    },
  };

  const chat = { id: -1001, type: "group", title: "Eliza Test Group" };
  const from = {
    id: 555_001,
    is_bot: false,
    first_name: "Tester",
    username: "tester",
  };
  const ctx = {
    from,
    chat,
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      text: options.inboundText,
      chat,
      from,
    },
    telegram: captureTelegram,
  } as unknown as Context;

  // `forceReply` is the explicit-invocation path (a slash command / mention):
  // it bypasses the default-off TELEGRAM_AUTO_REPLY gate so the agent replies.
  const replyContent = options.replyContent;
  const messageService = harness.runtime.messageService;
  if (replyContent && messageService) {
    // Stand in for an action that answers through the connector callback,
    // as ATTACH_TO_CHAT does with `{ text: "", attachments }`.
    messageService.handleMessage = async (_runtime, _memory, callback) => {
      await callback?.(replyContent, "ATTACH_TO_CHAT");
      return undefined as never;
    };
  }
  const processorReplies = options.processorReplies;
  if (processorReplies && messageService) {
    const replyRoomId = createUniqueUuid(harness.runtime, chat.id.toString());
    messageService.handleMessage = async (runtime, _memory, callback) => {
      for (const reply of processorReplies) {
        const id = reply.responseId as UUID | undefined;
        if (id && !(await runtime.getMemoryById(id))) {
          await runtime.createMemory(
            {
              id,
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: replyRoomId,
              content: reply,
            },
            "messages",
          );
        }
        await callback?.(reply);
      }
      return undefined as never;
    };
  }
  await manager.handleMessage(ctx, { forceReply: true });

  const roomId = createUniqueUuid(harness.runtime, chat.id.toString());
  const agentRows = async () =>
    (
      await harness.runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 50,
      })
    ).filter((memory) => memory.entityId === harness.runtime.agentId);
  return { delivered, photos, chatId: chat.id, agentRows, manager };
}

describe("telegram connector loop (keyless)", () => {
  it("drives a synthetic Telegram message through the deterministic model provider to a delivered reply", async () => {
    const { delivered, chatId } = await driveTelegramTurn({
      inboundText: "Hello agent, please reply.",
      fixtures: [
        {
          name: "telegram-reply",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          response: {
            contexts: ["simple"],
            intents: [],
            replyText: "Hello from the deterministic model provider.",
            candidateActionNames: [],
          },
        },
      ],
    });

    // The loop closed end-to-end through the real connector: a non-empty reply
    // was delivered back to the inbound chat, generated entirely by the
    // deterministic model provider with zero external cost.
    expect(
      delivered.length,
      "the connector delivered at least one outbound reply",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.text.trim().length,
      "the delivered reply carries text",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.chatId,
      "the reply went back to the inbound chat",
    ).toBe(chatId);
  }, 60_000);

  it("stores a delivered reply once in the chat's room", async () => {
    // No MarkdownV2-escapable characters, so wire and stored text match.
    const replyText = "Hello from the deterministic model provider";
    const { delivered, agentRows, manager, chatId } = await driveTelegramTurn({
      inboundText: "Hello agent, please reply.",
      fixtures: [
        {
          name: "telegram-reply-once",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          response: {
            contexts: ["simple"],
            intents: [],
            replyText,
            candidateActionNames: [],
          },
        },
      ],
    });
    expect(delivered.map((message) => message.text)).toEqual([replyText]);
    // The message service stores the reply under its responseId; the
    // delivery must land on that row rather than add a second one, or every
    // later turn's transcript shows the reply twice.
    const rows = await agentRows();
    expect(rows.map((memory) => memory.content.text)).toEqual([replyText]);
    expect(
      (rows[0]?.metadata as Record<string, unknown> | undefined)
        ?.telegramMessageIds,
    ).toEqual(["1"]);
    // A reply-to, reaction or edit of the delivered Telegram message resolves
    // to that one stored row.
    expect(await manager.resolveMessageMemoryId(chatId, 1)).toBe(rows[0]?.id);
  }, 60_000);

  it("keeps a second delivered message of the same response as its own row", async () => {
    const responseId = "5c0e1a42-6d2f-4a7b-8c1d-2e3f4a5b6c71";
    const { delivered, agentRows, manager, chatId } = await driveTelegramTurn({
      inboundText: "Where is my order?",
      processorReplies: [
        { text: "Checking your order now", responseId },
        { text: "Order 42 has shipped", responseId },
      ],
    });
    expect(delivered.map((message) => message.text)).toEqual([
      "Checking your order now",
      "Order 42 has shipped",
    ]);
    const rows = await agentRows();
    expect(rows.map((row) => row.content.text).sort()).toEqual(
      ["Checking your order now", "Order 42 has shipped"].sort(),
    );
    const first = await manager.resolveMessageMemoryId(chatId, 1);
    const second = await manager.resolveMessageMemoryId(chatId, 2);
    expect(first).toBe(responseId);
    expect(second).not.toBe(first);
    expect(rows.map((row) => row.id)).toContain(second);
  }, 60_000);

  it("records an attachment Telegram refused as not delivered on the merged row", async () => {
    const responseId = "6d1f2b53-7e3a-4b8c-9d2e-3f4a5b6c7d82";
    const { agentRows } = await driveTelegramTurn({
      inboundText: "Send me the chart.",
      failPhotos: true,
      processorReplies: [
        {
          text: "Here is the chart",
          responseId,
          attachments: [
            {
              id: "chart",
              url: "https://example.invalid/chart.png",
              contentType: "image",
            },
          ],
        },
      ],
    });
    const rows = await agentRows();
    const merged = rows.find((row) => row.id === responseId);
    expect(merged?.content.text).toBe("Here is the chart");
    expect(merged?.content.attachments ?? []).toEqual([]);
  }, 60_000);

  it("gives an edit of one chunk of a merged reply no stored copy to overwrite", async () => {
    const responseId = "7e2a3c64-8f4b-4c9d-8e3f-4a5b6c7d8e93";
    const longText = Array.from({ length: 900 }, (_, i) => `word${i}`).join(
      " ",
    );
    const { delivered, manager, chatId } = await driveTelegramTurn({
      inboundText: "Tell me everything.",
      processorReplies: [{ text: longText, responseId }],
    });
    expect(delivered.length).toBeGreaterThan(1);
    // Every chunk still resolves to the one merged row for reply-to and reactions.
    expect(await manager.resolveMessageMemoryId(chatId, 2)).toBe(responseId);
    // An edit of one chunk must not replace the whole reply's stored text.
    expect(await manager.storedCopyForEdit(chatId, 2)).toBeNull();
  }, 60_000);

  // lovecity08 on #38646: on plugin-sqlite the metadata array lookup never
  // matches, so reply-to, reactions and edits lost the merged row.
  it("resolves every chunk of a merged reply when metadata filters compare by value, as on SQLite", async () => {
    const responseId = "8f3b4d75-9a5c-4dae-9f4a-5b6c7d8e9fa4";
    const longText = Array.from({ length: 900 }, (_, i) => `word${i}`).join(
      " ",
    );
    const { delivered, manager, chatId } = await driveTelegramTurn({
      inboundText: "Tell me everything.",
      processorReplies: [{ text: longText, responseId }],
      sqliteMetadataFilter: true,
    });
    expect(delivered.length).toBeGreaterThan(1);
    for (let id = 1; id <= delivered.length; id++)
      expect(await manager.resolveMessageMemoryId(chatId, id)).toBe(responseId);
    expect(await manager.storedCopyForEdit(chatId, 2)).toBeNull();
  }, 60_000);

  it("delivers escaped Markdown and adjacent emphasis without changing visible characters", async () => {
    const cases = [
      [String.raw`\*literal\*`, String.raw`\*literal\*`],
      [String.raw`\\*italic*`, String.raw`\\_italic_`],
      [String.raw`\**not bold**`, String.raw`\*_not bold_\*`],
      [String.raw`**a\**`, String.raw`\*_a\*_`],
      [
        String.raw`\**not bold** then **bold**`,
        String.raw`\*_not bold_\* then *bold*`,
      ],
      [String.raw`\\**bold**`, String.raw`\\*bold*`],
      [String.raw`\\\*literal\*`, String.raw`\\\*literal\*`],
      ["***nested***", "_*nested*_"],
      [String.raw`\*literal\* and *real*`, String.raw`\*literal\* and _real_`],
      ["2 * 3 * 4", String.raw`2 \* 3 \* 4`],
    ];
    const { delivered, chatId } = await driveTelegramTurn({
      inboundText: "Send the requested formatting examples exactly.",
      fixtures: [
        {
          name: "escaped-markdown-reply",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          response: {
            contexts: ["simple"],
            intents: [],
            candidateActionNames: [],
            replyText: cases.map(([input]) => input).join("\n"),
          },
        },
      ],
    });
    expect(delivered).toEqual([
      { chatId, text: cases.map(([, output]) => output).join("\n") },
    ]);
  }, 60_000);

  it("delivers a drifted tool-call reply to the Telegram wire seam already sanitized (#15888)", async () => {
    const { delivered, chatId } = await driveTelegramTurn({
      inboundText: "Say hello and describe your plan.",
      fixtures: [
        {
          name: "drifted-stage1",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          // A stage-1 reply that drifted out of the response grammar into
          // native tool syntax mid-sentence — the live leak shape from #15812.
          // Lowercase tool name on purpose: the stage-1 junk-stripper only
          // swallows unclosed markup followed by an UPPERCASE action token, so
          // this drift survives parsing and must be caught at the shared
          // outbound boundary.
          response: {
            contexts: ["simple"],
            intents: [],
            replyText: "The forecast looks clear.<tool_call>get_weather",
            candidateActionNames: [],
          },
        },
      ],
    });

    expect(
      delivered.length,
      "the connector delivered at least one outbound reply",
    ).toBeGreaterThan(0);
    for (const message of delivered) {
      expect(
        message.text,
        "no delivered Telegram text carries native tool syntax",
      ).not.toMatch(/<\/?(?:tool_call|function_call)\b/i);
    }
    // `sendMessageInChunks` escapes for Telegram MarkdownV2 (hence `\.`) —
    // asserted verbatim so the expectation pins the exact wire payload.
    expect(delivered[0]?.text).toBe("The forecast looks clear\\.");
    expect(delivered[0]?.chatId).toBe(chatId);
  }, 60_000);

  it("delivers an attachment-only reply instead of dropping it", async () => {
    // 1x1 PNG.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const { delivered, photos, chatId } = await driveTelegramTurn({
      inboundText: "Attach the floor plan to this chat.",
      replyContent: {
        text: "",
        attachments: [
          {
            id: "floor-plan",
            url: png,
            title: "Floor plan",
            contentType: "image/png" as never,
          },
        ],
      },
    });

    expect(photos).toHaveLength(1);
    expect(photos[0]?.chatId).toBe(chatId);
    expect(delivered).toEqual([]);
  }, 60_000);
});
