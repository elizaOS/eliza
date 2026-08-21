/**
 * Unit coverage for `GoogleGmailAdapter`: message mapping, manage-operation
 * translation, reply drafting/sending, and post-commit mutation receipts
 * against a mock runtime whose "google" service is a `vi.fn` stub. The harness
 * is deterministic and does not call the live Gmail API.
 */
import { EventType, type IAgentRuntime } from "@elizaos/core/node";
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

function runtimeWithGoogleService(service: Record<string, unknown>): IAgentRuntime {
  const googleService = {
    listGmailTriageMessages: vi.fn(async () => []),
    searchGmailMessages: vi.fn(async () => []),
    sendGmailReply: vi.fn(async () => ({})),
    sendGmailMessage: vi.fn(async () => ({})),
    modifyGmailMessages: vi.fn(async () => undefined),
    createGmailFilterForSender: vi.fn(async () => ({
      filterId: "filter_default",
      trashed: true,
    })),
    ...service,
  };
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) => (serviceType === "google" ? googleService : null)),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
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
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MESSAGE_MUTATED,
      expect.objectContaining({
        messageSource: "gmail",
        messageId: "gmail:msg_1",
        operation: "replied",
        domainEventId: "gmail_reply:acct_google_1:sent_1",
      })
    );
  });

  it("advertises new-email send capability alongside reply", () => {
    expect(new GoogleGmailAdapter().capabilities().send).toEqual({
      reply: true,
      new: true,
      schedule: false,
    });
  });

  it("creates and sends a NEW email draft (no inReplyToId) through sendGmailMessage", async () => {
    const sendGmailMessage = vi.fn(async () => ({
      messageId: "sent_new_1",
      threadId: "thread_new_1",
      labelIds: ["SENT"],
    }));
    const runtime = runtimeWithGoogleService({ sendGmailMessage });
    const adapter = new GoogleGmailAdapter();

    const draft = await adapter.createDraft(runtime, {
      source: "gmail",
      to: [{ identifier: "shadow@example.com" }],
      subject: "Stop smoking",
      body: "Please stop smoking.",
      worldId: "acct_google_1",
    });
    const sent = await adapter.sendDraft(runtime, draft.draftId);

    expect(draft.preview).toBe("Please stop smoking.");
    expect(sendGmailMessage).toHaveBeenCalledWith({
      accountId: "acct_google_1",
      to: ["shadow@example.com"],
      subject: "Stop smoking",
      bodyText: "Please stop smoking.",
    });
    expect(sent.externalId).toBe("sent_new_1");
  });

  it("clips draft body preview without tearing UTF-16 surrogate pairs at 240 limit", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();

    const body = `${"x".repeat(236)}\u{1F98A}yyyy`;
    const draft = await adapter.createDraft(runtime, {
      source: "gmail",
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      body,
      worldId: "acct_google_1",
    });

    expect(draft.preview.length).toBeLessThanOrEqual(240);
    expect(draft.preview.isWellFormed()).toBe(true);
    expect(draft.preview.endsWith("...")).toBe(true);
    expect(draft.preview).toBe(`${"x".repeat(236)}...`);
  });

  it("preserves well-formed draft previews at and below the 240-code-unit limit", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();
    const bodies = ["ready 🦊", "x".repeat(240)];

    for (const body of bodies) {
      const draft = await adapter.createDraft(runtime, {
        source: "gmail",
        to: [{ identifier: "test@example.com" }],
        subject: "Test Subject",
        body,
        worldId: "acct_google_1",
      });

      expect(draft.preview).toBe(body);
      expect(draft.preview.isWellFormed()).toBe(true);
    }
  });

  it("normalizes lone surrogates in short and clipped draft previews", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();
    const baseRequest = {
      source: "gmail" as const,
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      worldId: "acct_google_1",
    };

    const shortDraft = await adapter.createDraft(runtime, {
      ...baseRequest,
      body: "short\ud800preview",
    });
    const longDraft = await adapter.createDraft(runtime, {
      ...baseRequest,
      body: `${"x".repeat(237)}\udc00tail`,
    });

    expect(shortDraft.preview).toBe("short�preview");
    expect(longDraft.preview).toBe(`${"x".repeat(237)}...`);
    expect(shortDraft.preview.isWellFormed()).toBe(true);
    expect(longDraft.preview.isWellFormed()).toBe(true);
    expect(longDraft.preview.length).toBeLessThanOrEqual(240);
  });

  it("normalizes either lone-surrogate half on both sides of the preview limit", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();
    const baseRequest = {
      source: "gmail" as const,
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      worldId: "acct_google_1",
    };
    const bodies = [
      "short\ud800preview",
      "short\udc00preview",
      `${"h".repeat(236)}\ud800tail`,
      `${"l".repeat(236)}\udc00tail`,
    ];

    const previews: string[] = [];
    for (const body of bodies) {
      const draft = await adapter.createDraft(runtime, { ...baseRequest, body });
      previews.push(draft.preview);
    }

    expect(previews).toEqual([
      "short�preview",
      "short�preview",
      `${"h".repeat(236)}�...`,
      `${"l".repeat(236)}�...`,
    ]);
    expect(previews.every((preview) => preview.isWellFormed())).toBe(true);
    expect(previews.every((preview) => preview.length <= 240)).toBe(true);
  });

  it("reserves the suffix only after the 240-code-unit boundary", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();
    const baseRequest = {
      source: "gmail" as const,
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      worldId: "acct_google_1",
    };

    const exact = await adapter.createDraft(runtime, { ...baseRequest, body: "m".repeat(240) });
    const over = await adapter.createDraft(runtime, { ...baseRequest, body: "n".repeat(241) });

    expect(exact.preview).toBe("m".repeat(240));
    expect(over.preview).toBe(`${"n".repeat(237)}...`);
  });

  it("refuses a new draft without an email-address recipient", async () => {
    const runtime = runtimeWithGoogleService({});
    await expect(
      new GoogleGmailAdapter().createDraft(runtime, {
        source: "gmail",
        to: [{ identifier: "not-an-address" }],
        body: "hello",
      })
    ).rejects.toThrow(/email-address recipient/);
  });

  it("rejects a new draft when any requested recipient is invalid (no silent drop)", async () => {
    const sendGmailMessage = vi.fn();
    const runtime = runtimeWithGoogleService({ sendGmailMessage });
    await expect(
      new GoogleGmailAdapter().createDraft(runtime, {
        source: "gmail",
        to: [{ identifier: "valid@example.com" }, { identifier: "typo" }],
        body: "hello",
      })
    ).rejects.toThrow(/invalid: typo/);
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("manages Gmail messages and unsubscribe requests with plugin-google-workspace operations", async () => {
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
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      EventType.MESSAGE_MUTATED,
      expect.objectContaining({
        messageSource: "gmail",
        messageId: "gmail:msg_1",
        operation: "mark_read",
        domainEventId: "gmail_mark_read:acct_google_1:msg_1",
      })
    );
  });
});
