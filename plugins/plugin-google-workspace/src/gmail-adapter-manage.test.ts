/**
 * A manage operation through the Gmail message adapter reports the outcome
 * Gmail returned. Trash reports a failed message in its receipt instead of
 * throwing, so the adapter must not report that message as trashed. A sender
 * lookup ("trash the email from Alex Chen") keeps a name of several words in
 * one Gmail from: phrase. Real adapter search and manage paths; only the
 * Google service boundary is stubbed.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.ts";
import type { GoogleGmailMessageSummary, GoogleGmailMutationReceipt } from "./types.ts";

const message: GoogleGmailMessageSummary = {
  externalId: "msg-1",
  threadId: "thread-1",
  subject: "Invoice",
  from: "Bob <bob@example.com>",
  fromEmail: "bob@example.com",
  replyTo: null,
  to: ["me@example.com"],
  cc: [],
  snippet: "Attached",
  receivedAt: "2026-10-15T09:00:00.000Z",
  isUnread: true,
  isImportant: false,
  likelyReplyNeeded: false,
  triageScore: 0,
  triageReason: "",
  labels: ["INBOX"],
  htmlLink: null,
  metadata: { messageIdHeader: "<msg-1@example.com>" },
};

function gmail(receipt?: GoogleGmailMutationReceipt) {
  const service = {
    listGmailTriageMessages: vi.fn(),
    searchGmailMessages: vi.fn(async () => [message]),
    getGmailMessageDetail: vi.fn(),
    getGmailMessageRevision: vi.fn(),
    sendGmailReply: vi.fn(),
    sendGmailMessage: vi.fn(),
    modifyGmailMessages: vi.fn(async () => receipt),
    createGmailFilterForSender: vi.fn(),
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: (name: string) => (name === "google" ? service : null),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { service, runtime };
}

async function trash(receipt: GoogleGmailMutationReceipt) {
  const { runtime } = gmail(receipt);
  const adapter = new GoogleGmailAdapter();
  const [found] = await adapter.searchMessages(runtime, { content: "Invoice" });
  if (!found) throw new Error("search returned no message");
  return adapter.manageMessage(runtime, found.id, { kind: "trash" });
}

it("reports a Gmail trash that Gmail refused as failed", async () => {
  const result = await trash({
    operation: "trash",
    requestedMessageIds: ["msg-1"],
    succeededMessageIds: [],
    failures: [{ messageId: "msg-1", code: 404, retryable: false }],
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("status 404");
});

it("reports a Gmail trash that Gmail accepted as done", async () => {
  const result = await trash({
    operation: "trash",
    requestedMessageIds: ["msg-1"],
    succeededMessageIds: ["msg-1"],
    failures: [],
  });
  expect(result).toEqual({ ok: true });
});

// Gmail applies from: to the next word only, so `from:Alex Chen` also matches
// another Alex's mail that mentions Chen.
it.each([
  [{ displayName: "Alex Chen" }, 'in:anywhere from:"Alex Chen"'],
  [{ displayName: 'Alex "AJ" Chen' }, 'in:anywhere from:"Alex AJ Chen"'],
  [{ displayName: "Alex" }, "in:anywhere from:Alex"],
  [{ identifier: "bob@example.com" }, "in:anywhere from:bob@example.com"],
])("searches Gmail for sender %o with %s", async (sender, query) => {
  const { service, runtime } = gmail();
  await new GoogleGmailAdapter().searchMessages(runtime, { sender });
  expect(service.searchGmailMessages).toHaveBeenCalledWith(expect.objectContaining({ query }));
});
