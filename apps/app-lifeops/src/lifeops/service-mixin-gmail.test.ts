import { describe, expect, it, vi } from "vitest";
import type {
  LifeOpsConnectorGrant,
  LifeOpsGmailMessageSummary,
} from "../contracts/index.js";
import { LifeOpsService } from "./service.js";
import { LifeOpsServiceError } from "./service-types.js";

// Mock Gmail HTTP + OAuth sidecars so `manageGmailMessages` exercises the
// orchestration logic (capability gates, message resolution, cache update,
// audit recording) without making network calls. Other exports pass through
// so existing tests keep their real implementations.
vi.mock("./google-gmail.js", async () => {
  const actual = await vi.importActual<typeof import("./google-gmail.js")>(
    "./google-gmail.js",
  );
  return {
    ...actual,
    modifyGoogleGmailMessages: vi.fn(async () => undefined),
  };
});

vi.mock("./google-oauth.js", async () => {
  const actual = await vi.importActual<typeof import("./google-oauth.js")>(
    "./google-oauth.js",
  );
  return {
    ...actual,
    ensureFreshGoogleAccessToken: vi.fn(async () => ({
      provider: "google" as const,
      agentId: "agent-gmail-service",
      side: "owner" as const,
      mode: "local" as const,
      clientId: "test-client-id",
      redirectUri: "http://localhost/callback",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      tokenType: "Bearer",
      grantedScopes: [],
      expiresAt: Date.now() + 3600 * 1000,
      refreshTokenExpiresAt: null,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    })),
  };
});

// Imported AFTER `vi.mock` so the mocked exports are what the service sees
// when it dispatches to the Gmail HTTP layer.
const { modifyGoogleGmailMessages } = await import("./google-gmail.js");

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-gmail-service",
    character: { name: "Eliza" },
    ...overrides,
  } as unknown as ConstructorParameters<typeof LifeOpsService>[0];
}

function grant(
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant & { identityEmail: string } {
  return {
    id: "grant-1",
    agentId: "agent-gmail-service",
    provider: "google",
    side: "owner",
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [],
    capabilities: ["google.gmail.triage"],
    tokenRef: "token-ref",
    metadata: {},
    lastRefreshAt: null,
    cloudConnectionId: null,
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

function message(
  overrides: Partial<LifeOpsGmailMessageSummary> = {},
): LifeOpsGmailMessageSummary {
  return {
    id: "life-gmail-1",
    externalId: "gmail-ext-1",
    agentId: "agent-gmail-service",
    provider: "google",
    side: "owner",
    threadId: "thread-1",
    subject: "Spam candidate",
    from: "Sender",
    fromEmail: "sender@example.test",
    replyTo: null,
    to: ["owner@example.test"],
    cc: [],
    snippet: "spam body",
    receivedAt: "2026-04-22T12:00:00.000Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 1,
    triageReason: "unread",
    labels: ["SPAM"],
    htmlLink: null,
    metadata: {},
    syncedAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

const REPLY_DRAFT_ARGS = {
  message: message({
    labels: ["INBOX"],
    likelyReplyNeeded: true,
    subject: "Project update",
    from: "Alex",
    fromEmail: "alex@example.test",
    snippet: "Can you confirm this still works for Friday?",
  }),
  tone: "neutral" as const,
  includeQuotedOriginal: false,
  senderName: "Owner",
  sendAllowed: true,
  subjectType: "owner" as const,
  conversationContext: ["Owner asked for concise, direct email replies."],
  actionHistory: [],
  trajectorySummary: null,
};

describe("LifeOps Gmail reply draft rendering", () => {
  it("uses the generated model body and preserves explicit confirmation", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValue("Hi Alex,\n\nFriday still works for me.\n\nOwner");
    const service = new LifeOpsService(runtime({ useModel }));

    const draft = await service.renderGmailReplyDraft(REPLY_DRAFT_ARGS);

    expect(draft.bodyText).toBe(
      "Hi Alex,\n\nFriday still works for me.\n\nOwner",
    );
    expect(draft.previewLines).toEqual([
      "Hi Alex,",
      "Friday still works for me.",
      "Owner",
    ]);
    expect(draft.sendAllowed).toBe(true);
    expect(draft.requiresConfirmation).toBe(true);
  });

  it("fails safely when no model is configured", async () => {
    const service = new LifeOpsService(runtime({ useModel: undefined }));

    await expect(
      service.renderGmailReplyDraft(REPLY_DRAFT_ARGS),
    ).rejects.toMatchObject({
      status: 503,
      message:
        "Gmail reply draft generation requires a configured language model. No fallback draft was created.",
    });
  });

  it("fails safely when the model call fails", async () => {
    const useModel = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const service = new LifeOpsService(runtime({ useModel }));

    await expect(
      service.renderGmailReplyDraft(REPLY_DRAFT_ARGS),
    ).rejects.toMatchObject({
      status: 502,
      message:
        "Gmail reply draft generation failed. No fallback draft was created.",
    });
  });

  it("fails safely when the model output has no usable draft text", async () => {
    const useModel = vi.fn().mockResolvedValue("<think>reasoning</think>");
    const service = new LifeOpsService(runtime({ useModel }));

    await expect(
      service.renderGmailReplyDraft(REPLY_DRAFT_ARGS),
    ).rejects.toMatchObject({
      status: 502,
      message:
        "Gmail reply draft generation returned no usable text. No fallback draft was created.",
    });
  });

  it("uses LifeOps service errors for unsafe draft generation failures", async () => {
    const service = new LifeOpsService(runtime({ useModel: undefined }));

    await expect(
      service.renderGmailReplyDraft(REPLY_DRAFT_ARGS),
    ).rejects.toBeInstanceOf(LifeOpsServiceError);
  });
});

describe("LifeOps Gmail service spam review queue", () => {
  it("persists spam candidates when Gmail recommendations are built", async () => {
    const service = new LifeOpsService(runtime());
    const upsert = vi
      .spyOn(service.repository, "upsertGmailSpamReviewItem")
      .mockResolvedValue();
    vi.spyOn(service, "requireGoogleGmailGrant").mockResolvedValue(grant());
    vi.spyOn(service, "getGmailTriage").mockResolvedValue({
      messages: [
        message(),
        message({
          id: "digest-1",
          externalId: "gmail-digest-1",
          labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
          metadata: { precedence: "bulk" },
        }),
      ],
      source: "synced",
      syncedAt: "2026-04-22T12:00:00.000Z",
      summary: {
        unreadCount: 2,
        importantNewCount: 0,
        likelyReplyNeededCount: 0,
      },
    });

    const feed = await service.getGmailRecommendations(
      new URL("http://localhost/api/lifeops/gmail/recommendations"),
      { grantId: "grant-1" },
      new Date("2026-04-22T12:10:00.000Z"),
    );

    expect(feed.recommendations.map((item) => item.kind)).toEqual([
      "archive",
      "mark_read",
      "review_spam",
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: "grant-1",
        accountEmail: "owner@example.test",
        messageId: "life-gmail-1",
        externalMessageId: "gmail-ext-1",
        status: "pending",
      }),
    );
  });
});

describe("LifeOps Gmail manageGmailMessages", () => {
  it("archives matched messages, refreshes the local cache, and writes an audit event", async () => {
    const service = new LifeOpsService(runtime());
    const inboxMessage = message({
      id: "life-gmail-archive-1",
      externalId: "gmail-ext-archive-1",
      labels: ["INBOX", "UNREAD"],
      isUnread: true,
      subject: "Newsletter",
    });

    // Grant must include the manage capability or `manageGmailMessages`
    // short-circuits with HTTP 409 before reaching modify/cache steps.
    vi.spyOn(service, "requireGoogleGmailGrant").mockResolvedValue(
      grant({ capabilities: ["google.gmail.triage", "google.gmail.manage"] }),
    );
    // Stub message resolution so the test does not hit Gmail or the local
    // search path; just hand back the one message we want to archive.
    vi.spyOn(service, "resolveGmailMessagesForManagement").mockResolvedValue([
      inboxMessage,
    ]);
    const upsertMessage = vi
      .spyOn(service.repository, "upsertGmailMessage")
      .mockResolvedValue();
    const createAuditEvent = vi
      .spyOn(service.repository, "createAuditEvent")
      .mockResolvedValue();
    // No-op the auth-failure clear path so we do not require a real grant
    // upsert round-trip.
    vi.spyOn(service, "clearGoogleGrantAuthFailure").mockResolvedValue(
      grant({ capabilities: ["google.gmail.triage", "google.gmail.manage"] }),
    );
    const modifyMock = vi.mocked(modifyGoogleGmailMessages);
    modifyMock.mockClear();

    const result = await service.manageGmailMessages(
      new URL("http://localhost/api/lifeops/gmail/manage"),
      {
        grantId: "grant-1",
        operation: "archive",
        messageIds: [inboxMessage.id],
      },
    );

    // Result reflects the archived message and the non-destructive flag.
    expect(result).toEqual({
      ok: true,
      operation: "archive",
      messageIds: [inboxMessage.id],
      affectedCount: 1,
      labelIds: [],
      destructive: false,
      grantId: "grant-1",
      accountEmail: "owner@example.test",
    });

    // Gmail HTTP layer was called exactly once with the external Gmail id
    // and the archive operation.
    expect(modifyMock).toHaveBeenCalledTimes(1);
    expect(modifyMock).toHaveBeenCalledWith({
      accessToken: "test-access-token",
      operation: "archive",
      messageIds: [inboxMessage.externalId],
      labelIds: [],
    });

    // Local cache was updated to drop the INBOX label so the next sync does
    // not show this message as inbox-unread.
    expect(upsertMessage).toHaveBeenCalledTimes(1);
    const [cachedMessage, cachedSide] = upsertMessage.mock.calls[0] ?? [];
    expect(cachedSide).toBe("owner");
    expect(cachedMessage).toMatchObject({
      id: inboxMessage.id,
      externalId: inboxMessage.externalId,
      labels: ["UNREAD"],
      isUnread: true,
    });

    // Audit trail records the management action with the affected count.
    expect(createAuditEvent).toHaveBeenCalledTimes(1);
    const [auditEvent] = createAuditEvent.mock.calls[0] ?? [];
    expect(auditEvent).toMatchObject({
      eventType: "gmail_messages_managed",
      ownerType: "connector",
      decision: expect.objectContaining({
        affectedCount: 1,
        destructive: false,
      }),
    });
  });

  it("rejects destructive operations without explicit confirmation", async () => {
    const service = new LifeOpsService(runtime());
    // Even with the manage capability, `trash`/`delete`/`report_spam` must
    // require `confirmDestructive: true` — this is a fail-closed gate.
    vi.spyOn(service, "requireGoogleGmailGrant").mockResolvedValue(
      grant({ capabilities: ["google.gmail.triage", "google.gmail.manage"] }),
    );
    const modifyMock = vi.mocked(modifyGoogleGmailMessages);
    modifyMock.mockClear();

    await expect(
      service.manageGmailMessages(
        new URL("http://localhost/api/lifeops/gmail/manage"),
        {
          grantId: "grant-1",
          operation: "trash",
          messageIds: ["life-gmail-archive-1"],
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "trash requires explicit destructive confirmation.",
    });

    // No Gmail HTTP call when the gate trips.
    expect(modifyMock).not.toHaveBeenCalled();
  });
});
