/**
 * Drives one inbound iMessage row through the real IMessageService dispatch,
 * the assistant message service and a PGlite runtime with a deterministic
 * model fixture. Only the outbound send and the macOS Contacts load are
 * stubbed; chat.db polling is not run.
 */
import { ChannelType, createUniqueUuid, ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatDbMessage } from "../src/chatdb-reader";
import { IMessageService } from "../src/service";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type DispatchingService = {
  contactsLoadAttempted: boolean;
  settings: unknown;
  loadSettings(): unknown;
  dispatchInboundMessage(row: ChatDbMessage): Promise<void>;
};

describe("iMessage reply persistence (keyless)", () => {
  it("stores a delivered auto-reply once in the chat's room", async () => {
    const replyText = "Hello from the deterministic model provider";
    const harness: ModelProviderTestRuntime = await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      settings: {
        IMESSAGE_AUTO_REPLY: "true",
        ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
      },
      fixtures: [
        {
          name: "imessage-reply-once",
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
    cleanups.push(harness.cleanup);
    const runtime = harness.runtime;

    const service = new IMessageService(runtime);
    const internals = service as unknown as DispatchingService;
    internals.settings = internals.loadSettings();
    // Contacts resolution reads the macOS address book; this chat needs none.
    internals.contactsLoadAttempted = true;
    const sent: string[] = [];
    service.sendMessage = async (_to, text) => {
      sent.push(text);
      return { success: true, messageIds: [`sent-${sent.length}`] };
    };

    const chatId = "+15550100100";
    const row = {
      rowId: 4242,
      guid: "guid-inbound-4242",
      text: "Hello agent, please reply.",
      kind: "text",
      handle: chatId,
      chatId,
      chatType: "direct",
      displayName: null,
      timestamp: Date.now(),
      isFromMe: false,
      service: "iMessage",
      isSent: true,
      isDelivered: true,
      isRead: false,
      dateRead: 0,
      dateEdited: 0,
      dateRetracted: 0,
      replyToGuid: null,
      attachments: [],
    } as unknown as ChatDbMessage;
    await internals.dispatchInboundMessage(row);

    expect(sent).toEqual([replyText]);
    // The message service stores the reply under its responseId; the
    // delivery must land on that row rather than add a second one, or every
    // later turn's transcript shows the reply twice.
    const rows = (
      await runtime.getMemories({
        tableName: "messages",
        roomId: createUniqueUuid(runtime, chatId),
        count: 50,
      })
    ).filter((memory) => memory.entityId === runtime.agentId);
    expect(rows.map((memory) => memory.content.text)).toEqual([replyText]);
    expect(rows[0]?.content.channelType).toBe(ChannelType.DM);
    expect((rows[0]?.metadata as Record<string, unknown> | undefined)?.source).toBe("imessage");
  }, 90_000);
});
