import type {
  LifeOpsConnectorGrant,
  LifeOpsGmailMessageSummary,
} from "@elizaos/app-lifeops/contracts";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";

function runtime() {
  return {
    agentId: "agent-gmail-service",
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
