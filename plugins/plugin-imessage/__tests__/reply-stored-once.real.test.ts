/**
 * Drives one inbound iMessage row through the real IMessageService dispatch,
 * the assistant message service and a PGlite runtime with a deterministic
 * model fixture. Only the outbound send and the macOS Contacts load are
 * stubbed; chat.db polling is not run.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type HandlerCallback,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
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

/**
 * The processor stores the reply under `responseId` before the connector's
 * callback runs, as the assistant message service does. The callback, the
 * merge and the PGlite rows below are the real ones.
 */
async function dispatchWithProcessor(
  transport: "native" | "blooio",
  replies: Content[],
  extraSettings: Record<string, string> = {}
) {
  const harness: ModelProviderTestRuntime = await createTestRuntimeWithModelProvider({
    plugins: [createAssistantPlugin()],
    settings: {
      IMESSAGE_AUTO_REPLY: "true",
      ELIZA_LIFEOPS_PASSIVE_CONNECTORS: "false",
      ...extraSettings,
    },
    fixtures: [],
  });
  cleanups.push(harness.cleanup);
  const runtime = harness.runtime;
  const service = new IMessageService(runtime);
  const internals = service as unknown as DispatchingService;
  internals.settings = { ...(internals.loadSettings() as object), transport };
  internals.contactsLoadAttempted = true;
  const sent: Array<{ text: string; mediaUrls: string[] }> = [];
  service.sendMessage = async (_to, text, options) => {
    sent.push({ text, mediaUrls: [...(options?.mediaUrls ?? [])] });
    return { success: true, messageIds: [`sent-${sent.length}`] };
  };
  const chatId = "+15550100101";
  const roomId = createUniqueUuid(runtime, chatId);
  runtime.messageService.handleMessage = (async (
    rt: typeof runtime,
    _message: Memory,
    callback?: HandlerCallback
  ) => {
    for (const reply of replies) {
      if (reply.responseId && !(await rt.getMemoryById(reply.responseId as UUID))) {
        await rt.createMemory(
          {
            id: reply.responseId as UUID,
            entityId: rt.agentId,
            agentId: rt.agentId,
            roomId,
            content: reply,
          },
          "messages"
        );
      }
      await callback?.(reply);
    }
    return { didRespond: true };
  }) as unknown as typeof runtime.messageService.handleMessage;
  await internals.dispatchInboundMessage({
    rowId: 4243,
    guid: "guid-inbound-4243",
    text: "Hello agent.",
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
  } as unknown as ChatDbMessage);
  const rows = (await runtime.getMemories({ tableName: "messages", roomId, count: 50 })).filter(
    (memory) => memory.entityId === runtime.agentId
  );
  return { sent, rows };
}

describe("iMessage reply persistence: one row per delivered message", () => {
  it("keeps a second delivered message of the same response as its own row", async () => {
    const responseId = "6a1f0c52-7f3e-4b8a-9d2e-3c4b5a6d7e81";
    const { sent, rows } = await dispatchWithProcessor("native", [
      { text: "First part of the answer.", responseId },
      { text: "Second message from a follow-up callback.", responseId },
    ]);
    expect(sent.map((s) => s.text)).toEqual([
      "First part of the answer.",
      "Second message from a follow-up callback.",
    ]);
    expect(rows.map((row) => row.content.text).sort()).toEqual(
      ["First part of the answer.", "Second message from a follow-up callback."].sort()
    );
    expect(rows.filter((row) => row.id === responseId)).toHaveLength(1);
  }, 90_000);

  it("records a Blooio-refused attachment as not delivered on the merged row", async () => {
    const responseId = "7b2e1d63-8a4f-4c9b-8e3f-4d5c6b7e8f92";
    const { sent, rows } = await dispatchWithProcessor("blooio", [
      {
        text: "Here is the chart.",
        responseId,
        attachments: [{ id: "a1", url: "https://example.invalid/chart.png" }],
      },
    ]);
    expect(sent).toEqual([{ text: "Here is the chart.", mediaUrls: [] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(responseId);
    expect(rows[0]?.content.attachments ?? []).toEqual([]);
  }, 90_000);

  it("stores the delivered text with rendered link-outs on the merged row", async () => {
    const responseId = "8c3f2e74-9b5a-4dac-9f4a-5e6d7c8f9a03";
    const { sent, rows } = await dispatchWithProcessor(
      "native",
      [
        {
          text: "Open this task",
          responseId,
          interactions: [{ kind: "task", threadId: "abc-123" }],
        } as unknown as Content,
      ],
      { ELIZA_APP_URL: "https://app.example.com" }
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("abc-123");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(responseId);
    expect(rows[0]?.content.text).toBe(sent[0]?.text);
  }, 90_000);
});
