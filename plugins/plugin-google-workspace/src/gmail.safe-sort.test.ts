/**
 * Unit tests for safe NaN handling in Gmail message priority sorting.
 */
import { describe, expect, it } from "vitest";
import { sortGmailMessages } from "./gmail";
import type { GoogleGmailMessageSummary } from "./types";

describe("sortGmailMessages safe sort", () => {
  it("orders by receivedAt descending with invalid/NaN dates sorted as 0", () => {
    const msgs = [
      {
        externalId: "b",
        receivedAt: "invalid",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
      {
        externalId: "a",
        receivedAt: "invalid",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
      {
        externalId: "c",
        receivedAt: "2024-01-02T00:00:00.000Z",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
    ];
    const sorted = sortGmailMessages(msgs);
    expect(sorted[0].externalId).toBe("c");
    expect(sorted[1].externalId).toBe("a");
    expect(sorted[2].externalId).toBe("b");
  });

  it("respects priority flags over timestamps", () => {
    const msgs = [
      {
        externalId: "a",
        receivedAt: "2024-01-03T00:00:00.000Z",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
      {
        externalId: "b",
        receivedAt: "2024-01-02T00:00:00.000Z",
        isImportant: true,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
    ];
    const sorted = sortGmailMessages(msgs);
    expect(sorted[0].externalId).toBe("b");
    expect(sorted[1].externalId).toBe("a");
  });

  it("breaks ties deterministically on identical invalid dates via externalId tiebreak", () => {
    const msgs = [
      {
        externalId: "z",
        receivedAt: "bad",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
      {
        externalId: "a",
        receivedAt: "bad",
        isImportant: false,
        likelyReplyNeeded: false,
        isUnread: false,
      } as GoogleGmailMessageSummary,
    ];
    const sorted = sortGmailMessages(msgs);
    expect(sorted[0].externalId).toBe("a");
    expect(sorted[1].externalId).toBe("z");
  });
});
