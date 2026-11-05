/**
 * A Gmail send whose outcome the transport did not report is not sent again
 * on the next confirmation: the adapter looks the message up by the
 * Message-ID it wrote and returns the stored message as the receipt.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { GoogleGmailSendOutcomeUnknownError } from "./gmail.ts";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.ts";

const header = "<first-attempt@eliza.local>";

function harness(stored: boolean) {
  const sendGmailMessage = vi
    .fn()
    .mockRejectedValueOnce(
      new GoogleGmailSendOutcomeUnknownError(header, new Error("socket hang up"))
    )
    .mockResolvedValue({ messageId: "second-id", threadId: null, labelIds: [] });
  const findGmailMessageByHeaderId = vi.fn(async () =>
    stored ? { messageId: "stored-id", threadId: "thread-1" } : null
  );
  const service = {
    listGmailTriageMessages: vi.fn(),
    searchGmailMessages: vi.fn(),
    getGmailMessageDetail: vi.fn(),
    getGmailMessageRevision: vi.fn(),
    sendGmailReply: vi.fn(),
    sendGmailMessage,
    findGmailMessageByHeaderId,
    modifyGmailMessages: vi.fn(),
    createGmailFilterForSender: vi.fn(),
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "google" ? service : null),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return {
    adapter: new GoogleGmailAdapter(),
    runtime,
    sendGmailMessage,
    findGmailMessageByHeaderId,
  };
}

async function confirmTwice(stored: boolean) {
  const { adapter, runtime, sendGmailMessage, findGmailMessageByHeaderId } = harness(stored);
  const { draftId } = await adapter.createDraft(runtime, {
    source: "gmail",
    to: [{ identifier: "bob@example.com" }],
    subject: "Notes",
    body: "The notes.",
    worldId: "account-1",
  });
  const first = await adapter.sendDraft(runtime, draftId).then(
    () => "sent",
    (error: unknown) => (error as { code?: string }).code
  );
  const second = await adapter.sendDraft(runtime, draftId);
  return {
    first,
    second: second.externalId,
    sends: sendGmailMessage.mock.calls.length,
    lookups: findGmailMessageByHeaderId.mock.calls.map(
      (call) => (call[0] as { messageIdHeader: string }).messageIdHeader
    ),
    resendHeader: (sendGmailMessage.mock.calls[1]?.[0] as { messageIdHeader?: string } | undefined)
      ?.messageIdHeader,
  };
}

it("returns the stored message instead of sending again", async () => {
  expect(await confirmTwice(true)).toEqual({
    first: "GOOGLE_GMAIL_SEND_OUTCOME_UNKNOWN",
    second: "stored-id",
    sends: 1,
    lookups: [header],
    resendHeader: undefined,
  });
});

it("sends again under the same Message-ID when Gmail has no such message", async () => {
  expect(await confirmTwice(false)).toEqual({
    first: "GOOGLE_GMAIL_SEND_OUTCOME_UNKNOWN",
    second: "second-id",
    sends: 2,
    lookups: [header],
    resendHeader: header,
  });
});
