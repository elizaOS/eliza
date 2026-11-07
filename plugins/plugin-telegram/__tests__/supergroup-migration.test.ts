/**
 * A basic group upgraded to a supergroup gets a new chat id. Telegram rejects
 * sends to the old id with 400 and `parameters.migrate_to_chat_id`
 * (https://core.telegram.org/bots/api#responseparameters). Text and media
 * must both follow the group to its new id.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { Context, Telegraf } from "telegraf";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../src/messageManager";

const OLD_CHAT = -1001;
const NEW_CHAT = -1009999;

function migratedGroupBot() {
  const calls: string[] = [];
  let nextId = 10;
  const upgraded = () =>
    Object.assign(new Error("Bad Request: group chat was upgraded"), {
      response: {
        error_code: 400,
        description:
          "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: NEW_CHAT },
      },
    });
  const send = (method: string) => async (chatId: number, content: unknown) => {
    calls.push(`${method} ${chatId}`);
    if (chatId === OLD_CHAT) throw upgraded();
    return {
      message_id: nextId++,
      chat: { id: chatId },
      date: 1,
      text: typeof content === "string" ? content : undefined,
    };
  };
  const telegram = {
    sendChatAction: async () => true,
    sendMessage: send("sendMessage"),
    sendPhoto: send("sendPhoto"),
  };
  return { bot: { telegram } as unknown as Telegraf<Context>, calls };
}

const runtime = {
  agentId: "00000000-0000-0000-0000-000000000001",
  getSetting: () => undefined,
  createMemory: async () => undefined,
  emitEvent: async () => undefined,
  getRoom: async () => null,
  getEntityById: async () => null,
} as unknown as IAgentRuntime;

describe("Telegram group upgraded to a supergroup", () => {
  it("sends text and attachments to the new chat id", async () => {
    const { bot, calls } = migratedGroupBot();
    const manager = new MessageManager(bot, runtime);
    for (const text of ["first", "second"]) {
      await manager.sendMessageWithReceipt(OLD_CHAT, {
        text,
        attachments: [
          {
            id: "photo",
            url: "telegram-file:FILEID",
            contentType: "image/png",
          },
        ],
      } as never);
    }
    // The first photo learns the new id from the 400; the second goes there
    // directly. Develop kept sending every photo to the old id.
    expect(calls.filter((call) => call.startsWith("sendPhoto"))).toEqual([
      `sendPhoto ${OLD_CHAT}`,
      `sendPhoto ${NEW_CHAT}`,
      `sendPhoto ${NEW_CHAT}`,
    ]);
    expect(calls.filter((call) => call.startsWith("sendMessage")).at(-1)).toBe(
      `sendMessage ${NEW_CHAT}`,
    );
  });
});
