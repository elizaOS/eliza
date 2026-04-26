import type {
  LifeOpsConnectorGrant,
  LifeOpsGmailMessageSummary,
} from "../contracts/index.js";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";
import { LifeOpsServiceError } from "./service-types.js";

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-gmail-service",
    character: { name: "Milady" },
    ...overrides,
  } as unknown as ConstructorParameters<typeof LifeOpsService>[0];
}

function grant(): LifeOpsConnectorGrant & { identityEmail: string } {
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
