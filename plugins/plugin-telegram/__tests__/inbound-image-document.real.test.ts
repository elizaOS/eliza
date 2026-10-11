import { type Memory, ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { MessageManager } from "@elizaos/plugin-telegram";
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

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function ingestTelegramMessage(
  message: Record<string, unknown>,
): Promise<{ stored: Memory[]; imageDescriptionCalls: number }> {
  let imageDescriptionCalls = 0;
  const harness: ModelProviderTestRuntime =
    await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      fixtures: [
        {
          name: "screenshot-description",
          match: { modelType: ModelType.IMAGE_DESCRIPTION },
          times: "any",
          response: () => {
            imageDescriptionCalls += 1;
            return {
              title: "Error dialog",
              description: "A dialog reading 'Disk full'",
            };
          },
        },
      ],
    });
  cleanups.push(harness.cleanup);

  const bot = new Telegraf("123456:TEST_TOKEN", {
    telegram: { apiRoot: "http://127.0.0.1:0/" },
  });
  bot.telegram.getFileLink = async () =>
    new URL(
      "https://api.telegram.org/file/bot123456:TEST_TOKEN/documents/screenshot.png",
    );
  const manager = new MessageManager(bot, harness.runtime, "default");
  Object.assign(manager, {
    fetchTelegramFileBytes: async () => ({
      buffer: PNG_BYTES,
      contentType: "image/png",
    }),
  });

  const chat = { id: -1002, type: "group", title: "Eliza Test Group" };
  const from = {
    id: 555_002,
    is_bot: false,
    first_name: "Tester",
    username: "tester",
  };
  const ctx = {
    from,
    chat,
    message: {
      message_id: 200,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      ...message,
    },
    telegram: bot.telegram,
  } as unknown as Context;

  await manager.handleMessage(ctx);

  const stored = await harness.runtime.getMemories({
    tableName: "messages",
    agentId: harness.runtime.agentId,
    count: 10,
  });
  return { stored, imageDescriptionCalls };
}

describe("telegram inbound image sent as a file", () => {
  it("describes an uncompressed image document the same way as a compressed photo", async () => {
    const { stored, imageDescriptionCalls } = await ingestTelegramMessage({
      caption: "what does this error mean?",
      document: {
        file_id: "doc-file-1",
        file_unique_id: "doc-unique-1",
        file_name: "screenshot.png",
        mime_type: "image/png",
        file_size: PNG_BYTES.length,
      },
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.content.text).toBe("what does this error mean?");
    expect(stored[0]?.content.attachments).toEqual([
      expect.objectContaining({
        id: "doc-file-1",
        url: "telegram-file:doc-file-1",
        contentType: "image",
        description: "[Image: Error dialog\nA dialog reading 'Disk full']",
        text: "[Image: Error dialog\nA dialog reading 'Disk full']",
      }),
    ]);
    expect(imageDescriptionCalls).toBe(1);
  }, 60_000);
});
