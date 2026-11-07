/**
 * A reply through the Gmail message adapter goes where Gmail's own Reply sends
 * it: to a received message's Reply-To or sender, and to the original
 * recipients when the account itself sent the message. Real adapter search,
 * draft and send paths; only the Google service boundary is stubbed.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.ts";
import type { GoogleGmailMessageSummary } from "./types.ts";

function summary(overrides: Partial<GoogleGmailMessageSummary>): GoogleGmailMessageSummary {
  return {
    externalId: "msg-1",
    threadId: "thread-1",
    subject: "Contract",
    from: "Me <me@example.com>",
    fromEmail: "me@example.com",
    replyTo: null,
    to: ["bob@example.com"],
    cc: [],
    snippet: "Can you sign?",
    receivedAt: "2026-10-15T09:00:00.000Z",
    isUnread: false,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "",
    labels: ["SENT"],
    htmlLink: null,
    metadata: { messageIdHeader: "<msg-1@example.com>" },
    ...overrides,
  };
}

async function replyRecipients(message: GoogleGmailMessageSummary): Promise<string[]> {
  const sendGmailReply = vi.fn(async () => ({ messageId: "sent-1" }));
  const service = {
    listGmailTriageMessages: vi.fn(),
    searchGmailMessages: vi.fn(async () => [message]),
    getGmailMessageDetail: vi.fn(),
    getGmailMessageRevision: vi.fn(),
    sendGmailReply,
    sendGmailMessage: vi.fn(),
    modifyGmailMessages: vi.fn(),
    createGmailFilterForSender: vi.fn(),
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "google" ? service : null),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const adapter = new GoogleGmailAdapter();
  const [found] = await adapter.searchMessages(runtime, { content: "Contract" });
  if (!found) throw new Error("search returned no message");
  const draft = await adapter.createDraft(runtime, {
    source: "gmail",
    to: [],
    body: "Any update?",
    inReplyToId: found.id,
  });
  await adapter.sendDraft(runtime, draft.draftId);
  expect(sendGmailReply).toHaveBeenCalledTimes(1);
  return (sendGmailReply.mock.calls[0] as unknown as [{ to: string[] }])[0].to;
}

describe("Gmail adapter reply recipients", () => {
  it("replies to the original recipients of a message the account sent", async () => {
    expect(
      await replyRecipients(summary({ to: ["bob@example.com", "carol@example.com"] }))
    ).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("replies to the sender of a received message", async () => {
    expect(
      await replyRecipients(
        summary({
          from: "Bob <bob@example.com>",
          fromEmail: "bob@example.com",
          to: ["me@example.com"],
          labels: ["INBOX"],
        })
      )
    ).toEqual(["bob@example.com"]);
  });

  it("replies to the Reply-To of a received message", async () => {
    expect(
      await replyRecipients(
        summary({
          from: "List <list@example.com>",
          fromEmail: "list@example.com",
          replyTo: "owner@example.com",
          to: ["me@example.com"],
          labels: ["INBOX"],
        })
      )
    ).toEqual(["owner@example.com"]);
  });
});
