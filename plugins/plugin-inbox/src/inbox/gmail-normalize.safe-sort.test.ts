/**
 * Unit tests for safe NaN handling in gmail-normalize priority sort.
 */
import type { LifeOpsGmailMessageSummary } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { compareGmailMessagePriority } from "./gmail-normalize";

describe("gmail-normalize safe sort", () => {
  it("handles NaN receivedAt by falling back to 0", () => {
    const a = {
      id: "b",
      receivedAt: "bad",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;
    const b = {
      id: "a",
      receivedAt: "bad",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;
    const c = {
      id: "c",
      receivedAt: "2024-01-02T00:00:00.000Z",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;

    const sorted = [a, b, c].sort(compareGmailMessagePriority);
    expect(sorted[0].id).toBe("c");
    expect(sorted[1].id).toBe("a");
    expect(sorted[2].id).toBe("b");
  });

  it("breaks ties deterministically with id comparison when receivedAt dates are both invalid", () => {
    const a = {
      id: "z",
      receivedAt: "bad",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;
    const b = {
      id: "a",
      receivedAt: "bad",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;

    expect(compareGmailMessagePriority(a, b)).toBeGreaterThan(0);
    expect(compareGmailMessagePriority(b, a)).toBeLessThan(0);
  });

  it("orders valid dates descending", () => {
    const a = {
      id: "a",
      receivedAt: "2024-01-01T00:00:00.000Z",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;
    const b = {
      id: "b",
      receivedAt: "2024-01-03T00:00:00.000Z",
      isImportant: false,
      likelyReplyNeeded: false,
      isUnread: false,
    } as LifeOpsGmailMessageSummary;

    const sorted = [a, b].sort(compareGmailMessagePriority);
    expect(sorted[0].id).toBe("b");
    expect(sorted[1].id).toBe("a");
  });
});
