import { describe, expect, it } from "vitest";
import type { LifeOpsGmailMessageSummary } from "@elizaos/app-lifeops/contracts";
import {
  buildGmailRecommendations,
  summarizeGmailRecommendations,
} from "./service-normalize-gmail.js";

function message(
  overrides: Partial<LifeOpsGmailMessageSummary>,
): LifeOpsGmailMessageSummary {
  return {
    id: "life-gmail-1",
    externalId: "msg-1",
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    threadId: "thr-1",
    subject: "Newsletter",
    from: "Digest",
    fromEmail: "digest@example.test",
    replyTo: null,
    to: ["owner@example.test"],
    cc: [],
    snippet: "Latest updates",
    receivedAt: "2026-04-22T12:00:00.000Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 1,
    triageReason: "unread",
    labels: ["INBOX", "UNREAD"],
    htmlLink: null,
    metadata: {},
    syncedAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildGmailRecommendations", () => {
  it("returns read-only recommendations with executable message ids", () => {
    const recommendations = buildGmailRecommendations([
      message({
        id: "reply-1",
        subject: "Need your review",
        isImportant: true,
        likelyReplyNeeded: true,
        triageReason: "direct-unread-reply-needed",
      }),
      message({
        id: "digest-1",
        labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
        metadata: { precedence: "bulk" },
      }),
      message({
        id: "spam-1",
        labels: ["SPAM"],
        metadata: {},
      }),
    ]);

    expect(recommendations.map((item) => item.kind)).toEqual([
      "reply",
      "archive",
      "mark_read",
      "review_spam",
    ]);
    expect(
      recommendations.find((item) => item.kind === "archive")?.messageIds,
    ).toEqual(["digest-1"]);
    expect(recommendations.every((item) => item.requiresConfirmation)).toBe(
      true,
    );
    expect(summarizeGmailRecommendations(recommendations)).toMatchObject({
      totalCount: 4,
      replyCount: 1,
      archiveCount: 1,
      markReadCount: 1,
      spamReviewCount: 1,
    });
  });
});
