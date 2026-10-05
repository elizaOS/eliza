/**
 * The delegated Telegram search maps bot-connector memories to the dialog and
 * sender ids the connector stamps. Fixtures mirror plugin-telegram
 * messageManager.ts: inbound messages (telegramIdentityMetadata + chatId) and
 * persistSentMessageMemories (numeric sentMessage.chat.id).
 */
import { describe, expect, it } from "vitest";
import { memoryToTelegramMessageSearchResult } from "./telegram-service.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("memoryToTelegramMessageSearchResult", () => {
  it("reads the sender from the connector's telegram identity metadata", () => {
    const inbound = {
      id: "22222222-2222-4222-8222-222222222222",
      agentId: AGENT_ID,
      entityId: "33333333-3333-4333-8333-333333333333",
      createdAt: 1_700_000_000_000,
      content: { text: "invoice attached", source: "telegram" },
      metadata: {
        type: "message",
        source: "telegram",
        fromId: "123",
        messageIdFull: "42",
        sender: { id: "123", name: "Ada", username: "ada" },
        telegram: {
          userId: "123",
          id: "123",
          name: "Ada",
          username: "ada",
          accountId: "default",
          chatId: "-1001",
          messageId: "42",
        },
        telegramUserId: "123",
        telegramChatId: "-1001",
      },
    };

    expect(memoryToTelegramMessageSearchResult(inbound)).toMatchObject({
      id: "42",
      dialogId: "-1001",
      senderId: "123",
      outgoing: false,
    });
  });

  it("keeps the dialog of the agent's own replies, whose chat id is numeric", () => {
    const sent = {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: AGENT_ID,
      entityId: AGENT_ID,
      createdAt: 1_700_000_001_000,
      content: { text: "sent", source: "telegram" },
      metadata: {
        type: "message",
        source: "telegram",
        fromBot: true,
        fromId: AGENT_ID,
        messageIdFull: "43",
        telegram: { chatId: -1001, messageId: "43" },
      },
    };

    expect(memoryToTelegramMessageSearchResult(sent)).toMatchObject({
      id: "43",
      dialogId: "-1001",
      outgoing: true,
    });
  });
});
