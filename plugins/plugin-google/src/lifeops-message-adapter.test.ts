import type { IAgentRuntime } from "@elizaos/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

function runtimeWithGoogleService(service: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) => (serviceType === "google" ? service : null)),
  } as unknown as IAgentRuntime;
}

function gmailMessage(overrides: Record<string, unknown> = {}) {
  return {
    externalId: "msg_1",
    threadId: "thread_1",
    subject: "Planning call",
    from: "Guest User",
    fromEmail: "guest@example.com",
    replyTo: null,
    to: ["owner@example.com"],
    cc: [],
    snippet: "Can we meet tomorrow?",
    receivedAt: "2026-06-01T12:00:00.000Z",
    isUnread: true,
    isImportant: true,
    likelyReplyNeeded: true,
    triageScore: 2,
    triageReason: "direct question",
    labels: ["INBOX"],
    htmlLink: "https://mail.google.com/mail/u/0/#inbox/msg_1",
    metadata: {
      hasAttachments: false,
      messageIdHeader: "<msg_1@example.com>",
      references: "<root@example.com>",
      bodyText: "Can we meet tomorrow?",
    },
    ...overrides,
  };
}

describe("GoogleGmailAdapter", () => {
  it("maps triage messages from the Google service into message refs", async () => {
    const listGmailTriageMessages = vi.fn(async () => [gmailMessage()]);
    const runtime = runtimeWithGoogleService({ listGmailTriageMessages });

    const messages = await new GoogleGmailAdapter().listMessages(runtime, {
      worldIds: ["acct_google_1"],
      limit: 3,
    });

    expect(listGmailTriageMessages).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      maxResults: 3,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "gmail:msg_1",
      source: "gmail",
      externalId: "msg_1",
      threadId: "thread_1",
      subject: "Planning call",
      from: {
        identifier: "guest@example.com",
        displayName: "Guest User",
      },
      worldId: "acct_google_1",
      metadata: {
        accountId: "acct_google_1",
        likelyReplyNeeded: true,
        triageReason: "direct question",
      },
    });
  });

  it("searches Gmail with query filters and account scope", async () => {
    const searchGmailMessages = vi.fn(async () => [gmailMessage()]);
    const runtime = runtimeWithGoogleService({ searchGmailMessages });

    await new GoogleGmailAdapter().searchMessages(runtime, {
      sender: { identifier: "guest@example.com" },
      content: "planning",
      tags: ["INBOX"],
      worldIds: ["acct_google_2"],
      limit: 5,
    });

    expect(searchGmailMessages).toHaveBeenCalledWith({
      accountId: "acct_google_2",
      query: "in:anywhere from:guest@example.com planning label:INBOX",
      includeSpamTrash: true,
      maxResults: 5,
    });
  });

  it("creates and sends a reply draft through Google Gmail", async () => {
    const listGmailTriageMessages = vi.fn(async () => [gmailMessage()]);
    const sendGmailReply = vi.fn(async () => ({
      messageId: "sent_1",
      threadId: "thread_1",
      labelIds: ["SENT"],
    }));
    const runtime = runtimeWithGoogleService({
      listGmailTriageMessages,
      sendGmailReply,
    });
    const adapter = new GoogleGmailAdapter();
    await adapter.listMessages(runtime, { worldIds: ["acct_google_1"] });

    const draft = await adapter.createDraft(runtime, {
      inReplyToId: "gmail:msg_1",
      body: "Tomorrow works.",
    });
    const sent = await adapter.sendDraft(runtime, draft.draftId);

    expect(draft.preview).toBe("Tomorrow works.");
    expect(sendGmailReply).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      to: ["guest@example.com"],
      subject: "Planning call",
      bodyText: "Tomorrow works.",
      inReplyTo: "<msg_1@example.com>",
      references: "<root@example.com>",
    });
    expect(sent.externalId).toBe("sent_1");
  });

  it("manages Gmail messages and unsubscribe requests with plugin-google operations", async () => {
    const listGmailTriageMessages = vi.fn(async () => [gmailMessage()]);
    const modifyGmailMessages = vi.fn(async () => undefined);
    const createGmailFilterForSender = vi.fn(async () => ({
      filterId: "filter_1",
      trashed: true,
    }));
    const runtime = runtimeWithGoogleService({
      listGmailTriageMessages,
      modifyGmailMessages,
      createGmailFilterForSender,
    });
    const adapter = new GoogleGmailAdapter();
    await adapter.listMessages(runtime, { worldIds: ["acct_google_1"] });

    await expect(
      adapter.manageMessage(runtime, "gmail:msg_1", {
        kind: "mark_read",
        read: true,
      })
    ).resolves.toEqual({ ok: true });
    await expect(
      adapter.manageMessage(runtime, "gmail:msg_1", { kind: "unsubscribe" })
    ).resolves.toEqual({ ok: true });

    expect(modifyGmailMessages).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      operation: "mark_read",
      messageIds: ["msg_1"],
      labelIds: undefined,
    });
    expect(createGmailFilterForSender).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      fromAddress: "guest@example.com",
      trash: true,
    });
  });
});
