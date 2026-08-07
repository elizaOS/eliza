/** Exercises canonical provenance stamping on authenticated notification ingress. */
import { describe, expect, mock, test } from "bun:test";
import type {
  HandlerCallback,
  IAgentRuntime,
  IMessageService,
  Memory,
  MessageProcessingResult,
} from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { dispatchEvent, EventBodySchema } from "../../src/handlers/event";

const OK_RESULT = {
  didRespond: true,
  responseMessages: [],
} as unknown as MessageProcessingResult;

describe("notification event canonical provenance", () => {
  test("stamps canonical email provenance from the strict notification envelope", async () => {
    let received: Memory | undefined;
    const ensureConnection = mock(async () => {});
    const handleMessage = mock(
      async (_rt: IAgentRuntime, mem: Memory, callback?: HandlerCallback) => {
        received = mem;
        await callback?.({ text: "ok" });
        return OK_RESULT;
      },
    );
    const runtime = {
      ensureConnection,
      messageService: { handleMessage } as unknown as IMessageService,
    } as unknown as IAgentRuntime;

    await dispatchEvent(
      runtime,
      "agent-1",
      "owner@example.com",
      "notification",
      {
        text: "Calendar reminder",
        canonicalProvenance: {
          source: "calendar",
          accountId: "google-account-1",
          platformRecordId: "calendar-event-123",
          chat: { id: "primary", type: "private" },
          senderName: "Owner",
        },
      },
    );

    expect(ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "calendar",
        channelId: "calendar:google-account-1:primary",
        type: ChannelType.DM,
      }),
    );
    expect(received?.content).toMatchObject({
      text: "Calendar reminder",
      source: "calendar",
      channelType: ChannelType.DM,
    });
    expect(received?.metadata).toMatchObject({
      type: "message",
      scope: "private",
      provider: "calendar",
      accountId: "google-account-1",
      platformMessageId: "calendar-event-123",
      sourceId: "calendar-event-123",
      chatType: "private",
      sender: { id: "owner@example.com", name: "Owner" },
      calendar: {
        userId: "owner@example.com",
        accountId: "google-account-1",
        messageId: "calendar-event-123",
        chatId: "primary",
      },
    });
  });

  test("rejects malformed canonicalProvenance at the HTTP body schema boundary", () => {
    const parsed = EventBodySchema.safeParse({
      userId: "owner@example.com",
      type: "notification",
      payload: {
        text: "bad",
        canonicalProvenance: {
          source: "calendar",
          accountId: "google-account-1",
          chat: { id: "primary", type: "private" },
        },
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.map((issue) => issue.path.join(".")),
      ).toContain("payload.canonicalProvenance.platformRecordId");
    }
  });
});
