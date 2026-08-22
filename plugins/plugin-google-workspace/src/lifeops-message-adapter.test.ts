/**
 * Unit coverage for `GoogleGmailAdapter`: message mapping, manage-operation
 * translation, reply drafting/sending, and post-commit mutation receipts
 * against a mock runtime whose "google" service is a `vi.fn` stub. The harness
 * is deterministic and does not call the live Gmail API.
 */

import { createHash } from "node:crypto";
import {
  __resetDefaultTriageServiceForTests,
  EventType,
  getDefaultTriageService,
  type IAgentRuntime,
  type Memory,
  messageAction,
  validateReadView,
} from "@elizaos/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";
import { GoogleGmailAdapter } from "./lifeops-message-adapter.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  __resetDefaultTriageServiceForTests();
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

function runtimeWithGoogleService(service: Record<string, unknown>): IAgentRuntime {
  const googleService = {
    listGmailTriageMessages: vi.fn(async () => []),
    searchGmailMessages: vi.fn(async () => []),
    getGmailMessageDetail: vi.fn(async () => null),
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

  it("sends a real-client mapped reply to Reply-To instead of From", async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: "msg_1" }] } });
    const get = vi.fn().mockResolvedValue({
      data: {
        id: "msg_1",
        threadId: "thread_1",
        snippet: "Reply here",
        labelIds: ["INBOX"],
        internalDate: "0",
        payload: {
          headers: [
            { name: "Subject", value: "Reply routing" },
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "Reply-To", value: '"Support, West" <support@example.com>' },
            { name: "To", value: "owner@example.com" },
          ],
        },
      },
    });
    const client = new GoogleGmailClient({
      gmail: vi.fn().mockResolvedValue({ users: { messages: { list, get } } }),
    } as unknown as GoogleApiClientFactory);
    const sendGmailReply = vi.fn(async () => ({ messageId: "sent_reply_to" }));
    const runtime = runtimeWithGoogleService({
      listGmailTriageMessages: client.listGmailTriageMessages.bind(client),
      sendGmailReply,
    });
    const adapter = new GoogleGmailAdapter();

    const [message] = await adapter.listMessages(runtime, {
      worldIds: ["acct_google_1"],
      limit: 1,
    });
    if (!message) throw new Error("expected mapped Gmail message");
    expect(message.from.identifier).toBe("sender@example.com");
    expect(message.metadata?.replyTo).toBe("support@example.com");

    const draft = await adapter.createDraft(runtime, {
      inReplyToId: message.id,
      body: "Routed correctly.",
    });
    await adapter.sendDraft(runtime, draft.draftId);

    expect(sendGmailReply).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["support@example.com"] })
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

  it("preserves complete long draft previews and normalizes malformed Unicode", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();

    const body = `${"x".repeat(240)}\u{1F98A}${"y".repeat(400)}tail`;
    const draft = await adapter.createDraft(runtime, {
      source: "gmail",
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      body,
      worldId: "acct_google_1",
    });

    expect(draft.preview).toBe(body);
    expect(draft.preview.isWellFormed()).toBe(true);
    expect(draft.preview.endsWith("tail")).toBe(true);
  });

  it("normalizes lone surrogates without dropping any surrounding draft text", async () => {
    const runtime = runtimeWithGoogleService({});
    const adapter = new GoogleGmailAdapter();
    const baseRequest = {
      source: "gmail" as const,
      to: [{ identifier: "test@example.com" }],
      subject: "Test Subject",
      worldId: "acct_google_1",
    };

    const body = `${"x".repeat(400)}\udc00${"y".repeat(400)}tail`;
    const draft = await adapter.createDraft(runtime, {
      ...baseRequest,
      body,
    });

    expect(draft.preview).toBe(`${"x".repeat(400)}�${"y".repeat(400)}tail`);
    expect(draft.preview.isWellFormed()).toBe(true);
    expect(draft.preview.endsWith("tail")).toBe(true);
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

const actionMessage = {
  id: "00000000-0000-0000-0000-0000000000aa",
  roomId: "00000000-0000-0000-0000-0000000000bb",
  entityId: "00000000-0000-0000-0000-0000000000cc",
  agentId: "00000000-0000-0000-0000-000000000001",
  content: { text: "read the email", source: "client_chat" },
  createdAt: 1,
} as unknown as Memory;

async function runReadAction(runtime: IAgentRuntime, parameters: Record<string, unknown>) {
  const result = await messageAction.handler(
    runtime,
    actionMessage,
    undefined,
    { parameters: { action: "read_message", source: "gmail", ...parameters } },
    undefined,
    undefined
  );
  if (!result) throw new Error("MESSAGE read_message returned no result");
  return result;
}

describe("MESSAGE Gmail progressive body reads", () => {
  it("fetches full current detail and reaches evidence beyond the triage snippet", async () => {
    const bodyText = "short\nLATE-EVIDENCE\n";
    const getGmailMessageDetail = vi.fn(async () => ({
      message: gmailMessage({ snippet: "short" }),
      bodyText,
    }));
    const runtime = runtimeWithGoogleService({ getGmailMessageDetail });
    getDefaultTriageService().register(new GoogleGmailAdapter());

    const first = await runReadAction(runtime, {
      accountId: "acct_google_1",
      messageId: "gmail:msg_1",
      unit: "byte",
      limit: 6,
    });
    expect(first.text).toBe("short\n");
    const firstProjection = first.data as {
      readView: { reference: { ref: string }; slice: { revision: string } };
      control: Record<string, unknown>;
    };
    expect(firstProjection.readView.reference.ref).not.toContain("acct_google_1");
    expect(firstProjection.readView.reference.ref).not.toContain("msg_1");
    expect(
      Buffer.from(firstProjection.readView.reference.ref, "base64url").toString("utf8")
    ).not.toMatch(/acct_google_1|msg_1/u);
    expect(validateReadView(firstProjection.readView)).toEqual(firstProjection.readView);
    expect(firstProjection.readView.reference).toMatchObject({
      revision: firstProjection.readView.slice.revision,
    });
    expect(firstProjection.readView.slice).toMatchObject({
      sliceSha256: createHash("sha256")
        .update(first.text ?? "")
        .digest("hex"),
    });
    expect(JSON.stringify(first.data)).not.toContain("LATE-EVIDENCE");
    expect(JSON.stringify(first.promptData)).not.toContain("LATE-EVIDENCE");

    const second = await runReadAction(runtime, {
      ...firstProjection.control,
      limit: 64,
    });
    expect(second.success).toBe(true);
    expect(second.text).toBe("LATE-EVIDENCE\n");
    expect(getGmailMessageDetail).toHaveBeenNthCalledWith(2, {
      accountId: "acct_google_1",
      messageId: "msg_1",
    });
  });

  it("fails a continuation after the provider body changes", async () => {
    let bodyText = "alpha\nbeta\n";
    const getGmailMessageDetail = vi.fn(async () => ({ message: gmailMessage(), bodyText }));
    const runtime = runtimeWithGoogleService({ getGmailMessageDetail });
    getDefaultTriageService().register(new GoogleGmailAdapter());
    const first = await runReadAction(runtime, { messageId: "msg_1", limit: 6 });
    const control = (first.data as { control: Record<string, unknown> }).control;

    bodyText = "alpha\nMUTATED\n";
    const stale = await runReadAction(runtime, control);
    expect(stale.success).toBe(false);
    expect(stale.text).toContain("changed before the continuation");
  });

  it("rechecks service availability and account authorization on every page", async () => {
    const getGmailMessageDetail = vi
      .fn()
      .mockResolvedValueOnce({ message: gmailMessage(), bodyText: "alpha\nbeta\n" })
      .mockRejectedValueOnce(new Error("OAuth grant revoked"));
    const runtime = runtimeWithGoogleService({ getGmailMessageDetail });
    getDefaultTriageService().register(new GoogleGmailAdapter());
    const first = await runReadAction(runtime, { messageId: "msg_1", limit: 6 });
    const control = (first.data as { control: Record<string, unknown> }).control;

    const revokedAuth = await runReadAction(runtime, control);
    expect(revokedAuth.success).toBe(false);
    expect(revokedAuth.text).toContain("OAuth grant revoked");

    vi.mocked(runtime.getService).mockReturnValue(null);
    const revokedService = await runReadAction(runtime, control);
    expect(revokedService.success).toBe(false);
    expect(revokedService.text).toContain("unavailable");
  });

  it("keeps Unicode intact and bounds a huge single-line body by UTF-8 bytes", async () => {
    const unicodeRuntime = runtimeWithGoogleService({
      getGmailMessageDetail: vi.fn(async () => ({ message: gmailMessage(), bodyText: "😀tail" })),
    });
    const unicodeAdapter = new GoogleGmailAdapter();
    const unicode = await unicodeAdapter.readMessage(unicodeRuntime, {
      messageId: "msg_1",
      unit: "byte",
      limit: 4,
    });
    expect(unicode.text).toBe("😀");
    expect(unicode.readView.slice.range).toEqual({ unit: "byte", start: 0, end: 4, total: 8 });
    await expect(
      unicodeAdapter.readMessage(unicodeRuntime, {
        messageId: "msg_1",
        unit: "byte",
        limit: 1,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_LIMIT_SPLITS_CODE_POINT" });

    const hugeRuntime = runtimeWithGoogleService({
      getGmailMessageDetail: vi.fn(async () => ({
        message: gmailMessage(),
        bodyText: "x".repeat(70_000),
      })),
    });
    const hugeAdapter = new GoogleGmailAdapter();
    const huge = await hugeAdapter.readMessage(hugeRuntime, {
      messageId: "msg_1",
    });
    expect(Buffer.byteLength(huge.text)).toBe(16_384);
    expect(huge.readView.slice).toMatchObject({
      range: { unit: "byte", start: 0, end: 16_384, total: 70_000 },
      hasMore: true,
      nextOffset: 16_384,
    });
    await expect(
      hugeAdapter.readMessage(hugeRuntime, {
        messageId: "msg_1",
        unit: "line",
        limit: 1,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_UNIT_TOO_LARGE" });
    await expect(
      hugeAdapter.readMessage(hugeRuntime, {
        messageId: "msg_1",
        offset: 1,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_EXPECTED_REVISION_REQUIRED" });
    await expect(
      hugeAdapter.readMessage(hugeRuntime, {
        messageId: "msg_1",
        offset: 70_001,
        expectedRevision: huge.readView.slice.revision,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_OFFSET_OUT_OF_RANGE" });
    await expect(
      hugeAdapter.readMessage(hugeRuntime, {
        messageId: "msg_1",
        unit: "line",
        offset: 2,
        expectedRevision: huge.readView.slice.revision,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_OFFSET_OUT_OF_RANGE" });

    const reference = huge.readView.reference.ref;
    await expect(
      new GoogleGmailAdapter().readMessage(hugeRuntime, {
        reference,
        expectedRevision: huge.readView.slice.revision,
      })
    ).rejects.toMatchObject({ code: "GMAIL_READ_REFERENCE_UNRESOLVED" });
  });
});
