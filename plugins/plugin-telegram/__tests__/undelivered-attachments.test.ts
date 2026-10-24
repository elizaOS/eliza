/**
 * An attachment Telegram refuses is not part of what the user received. The
 * prose still goes out, but the reply memory must not say the file was sent,
 * and a reply that was only attachments must not end as a silent no-op.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { Context, Telegraf } from "telegraf";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../src/messageManager";

const CHAT = -1001;

function botRejectingPhotos() {
  let nextId = 10;
  const telegram = {
    sendChatAction: async () => true,
    sendMessage: async (chatId: number, text: string) => ({
      message_id: nextId++,
      chat: { id: chatId },
      date: 1,
      text,
    }),
    sendPhoto: async () => {
      throw Object.assign(new Error("Bad Request: wrong file identifier"), {
        response: {
          error_code: 400,
          description: "Bad Request: wrong file identifier",
        },
      });
    },
  };
  return { telegram } as unknown as Telegraf<Context>;
}

function runtimeRecordingMemories() {
  const memories: Memory[] = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: () => undefined,
    createMemory: async (memory: Memory) => {
      memories.push(memory);
      return memory.id;
    },
    emitEvent: async () => undefined,
    getRoom: async () => null,
    getEntityById: async () => null,
  } as unknown as IAgentRuntime;
  return { runtime, memories };
}

const photo = {
  id: "photo",
  url: "telegram-file:FILEID",
  contentType: "image/png",
};

type Evidence = { messages: unknown[]; memories: Memory[] };
const sendWithEvidence = (manager: MessageManager, content: unknown) =>
  (
    manager as unknown as {
      sendMessageWithEvidence(
        chatId: number,
        content: unknown,
      ): Promise<Evidence>;
    }
  ).sendMessageWithEvidence(CHAT, content);

describe("Telegram attachments that were not delivered", () => {
  it("keeps a refused attachment out of the reply memory", async () => {
    const { runtime } = runtimeRecordingMemories();
    const manager = new MessageManager(botRejectingPhotos(), runtime);
    const result = await sendWithEvidence(manager, {
      text: "Here is the chart.",
      attachments: [photo],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.content.attachments ?? []).toEqual([]);
  });

  it("fails an attachments-only reply when no attachment was delivered", async () => {
    const { runtime } = runtimeRecordingMemories();
    const manager = new MessageManager(botRejectingPhotos(), runtime);
    await expect(
      sendWithEvidence(manager, { text: "", attachments: [photo] }),
    ).rejects.toMatchObject({
      code: "TELEGRAM_ATTACHMENTS_NOT_DELIVERED",
    });
  });
});
