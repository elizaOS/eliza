/**
 * Covers Gmail input normalization for owner and LLM-supplied query values.
 * These tests pin address extraction, mailbox-list splitting, duration parsing,
 * and label/message id validation before values reach Gmail API calls.
 */

import type { LifeOpsGmailMessageSummary } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  extractNormalizedEmailAddress,
  filterGmailMessagesBySearch,
  normalizeGeneratedGmailReplyDraftBody,
  normalizeGmailSearchQueryMatches,
  normalizeOptionalGmailLabelIdArray,
  normalizeOptionalMessageIdArray,
  parseGmailDateBoundary,
  parseGmailRelativeDuration,
  splitMailboxLikeList,
} from "./gmail-normalize.ts";

describe("extractNormalizedEmailAddress", () => {
  it("pulls + lowercases the address from common forms", () => {
    expect(
      extractNormalizedEmailAddress("Ada Lovelace <Ada@Example.COM>"),
    ).toBe("ada@example.com");
    expect(extractNormalizedEmailAddress("mailto:Bob@Example.com")).toBe(
      "bob@example.com",
    );
    expect(extractNormalizedEmailAddress("plain@host.io")).toBe(
      "plain@host.io",
    );
  });

  it("returns null for non-addresses", () => {
    expect(extractNormalizedEmailAddress("not an email")).toBeNull();
    expect(extractNormalizedEmailAddress("missing@domain")).toBeNull();
    expect(extractNormalizedEmailAddress("")).toBeNull();
  });

  it("scans adversarial punctuation and angle brackets in one pass", () => {
    expect(extractNormalizedEmailAddress(`${"!".repeat(50_000)}a@b.com`)).toBe(
      `${"!".repeat(50_000)}a@b.com`,
    );
    expect(extractNormalizedEmailAddress(`${"<".repeat(50_000)}a@b.com>`)).toBe(
      "a@b.com",
    );
  });
});

describe("normalizeGeneratedGmailReplyDraftBody", () => {
  it("removes repeated thinking blocks while preserving visible prose", () => {
    const thinking = "<think>hidden</think>".repeat(20_000);
    expect(normalizeGeneratedGmailReplyDraftBody(`${thinking}Visible`)).toBe(
      "Visible",
    );
  });

  it("keeps original offsets when a Unicode prefix expands under lowercase", () => {
    expect(
      normalizeGeneratedGmailReplyDraftBody("İ<think>secret</think>Visible"),
    ).toBe("İ Visible");
  });
});

describe("splitMailboxLikeList", () => {
  it("splits on commas/semicolons but not inside quotes or angle brackets", () => {
    expect(splitMailboxLikeList("a@x.com, b@y.com; c@z.com")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
    // a comma inside the quoted display name must NOT split the entry.
    expect(
      splitMailboxLikeList('"Lovelace, Ada" <ada@x.com>, bob@y.com'),
    ).toEqual(['"Lovelace, Ada" <ada@x.com>', "bob@y.com"]);
  });
});

describe("parseGmailRelativeDuration", () => {
  it("parses Nd/Nm/Ny into milliseconds, null otherwise", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(parseGmailRelativeDuration("7d")).toBe(7 * day);
    expect(parseGmailRelativeDuration("1m")).toBe(30 * day);
    expect(parseGmailRelativeDuration("1y")).toBe(365 * day);
    expect(parseGmailRelativeDuration("0d")).toBeNull();
    expect(parseGmailRelativeDuration("garbage")).toBeNull();
  });
});

describe("parseGmailDateBoundary", () => {
  it("parses YYYY-MM-DD (and slash form) to a UTC epoch, null on invalid", () => {
    expect(parseGmailDateBoundary("2026-01-02")).toBe(Date.UTC(2026, 0, 2));
    expect(parseGmailDateBoundary("2026/01/02")).toBe(Date.UTC(2026, 0, 2));
    expect(parseGmailDateBoundary("2026-13-02")).toBeNull();
    expect(parseGmailDateBoundary("nope")).toBeNull();
  });

  it("rejects calendar-impossible days instead of letting Date.UTC roll them over", () => {
    // Date.UTC(2026, 1, 31) is 2026-03-03. Month 13 already returns null;
    // day 31 in a 30-day month was accepted and shifted the after:/before:
    // search window to a later real day.
    expect(parseGmailDateBoundary("2026-02-31")).toBeNull();
    expect(parseGmailDateBoundary("2026-04-31")).toBeNull();
    expect(parseGmailDateBoundary("2025-02-29")).toBeNull();
    expect(parseGmailDateBoundary("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  });

  it("preserves literal UTC years from 0000 through 0099", () => {
    const yearZeroLeapDay = parseGmailDateBoundary("0000-02-29");
    const yearNinetyNineEnd = parseGmailDateBoundary("0099-12-31");

    expect(new Date(yearZeroLeapDay as number).toISOString()).toBe(
      "0000-02-29T00:00:00.000Z",
    );
    expect(new Date(yearNinetyNineEnd as number).toISOString()).toBe(
      "0099-12-31T00:00:00.000Z",
    );
    expect(parseGmailDateBoundary("0000-02-30")).toBeNull();
  });
});

describe("normalizeOptionalMessageIdArray", () => {
  it("dedupes, and returns undefined when absent", () => {
    expect(normalizeOptionalMessageIdArray(undefined, "ids")).toBeUndefined();
    expect(normalizeOptionalMessageIdArray(["a", "a", "b"], "ids")).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("normalizeOptionalGmailLabelIdArray", () => {
  it("accepts valid label ids, rejects out-of-charset ones", () => {
    expect(
      normalizeOptionalGmailLabelIdArray(["INBOX", "Label_1"], "labelIds"),
    ).toEqual(["INBOX", "Label_1"]);
    expect(() =>
      normalizeOptionalGmailLabelIdArray(["bad id!"], "labelIds"),
    ).toThrow();
  });
});

describe("normalizeGmailSearchQueryMatches — standalone OR", () => {
  const gmailMessage = (
    overrides: Partial<LifeOpsGmailMessageSummary>,
  ): LifeOpsGmailMessageSummary =>
    ({
      id: "m1",
      agentId: "agent",
      provider: "google",
      side: "personal",
      externalId: "x1",
      threadId: "t1",
      subject: "Quarterly report",
      from: "Bob Smith <bob@corp.com>",
      fromEmail: "bob@corp.com",
      replyTo: null,
      snippet: "Please find the numbers attached.",
      to: ["me@me.com"],
      cc: [],
      labels: ["INBOX", "UNREAD"],
      receivedAt: new Date().toISOString(),
      isUnread: true,
      isImportant: false,
      likelyReplyNeeded: false,
      triageReason: "",
      htmlLink: null,
      metadata: {},
      syncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      grantId: "g",
      accountEmail: "me@me.com",
      ...overrides,
    }) as LifeOpsGmailMessageSummary;

  const fromBob = gmailMessage({});
  const fromAlice = gmailMessage({
    id: "m2",
    from: "Alice <alice@corp.com>",
    fromEmail: "alice@corp.com",
    subject: "Lunch",
    snippet: "Are you free Friday?",
  });
  const fromCarol = gmailMessage({
    id: "m3",
    from: "Carol <carol@corp.com>",
    fromEmail: "carol@corp.com",
    subject: "Standup notes",
    snippet: "Notes from today.",
  });

  it("evaluates 'from:alice OR from:bob' as a disjunction", () => {
    const query = "from:alice OR from:bob";
    expect(normalizeGmailSearchQueryMatches(query, fromBob)).toBe(true);
    expect(normalizeGmailSearchQueryMatches(query, fromAlice)).toBe(true);
    expect(normalizeGmailSearchQueryMatches(query, fromCarol)).toBe(false);
  });

  it("matches a receipt-only message for 'invoice OR receipt'", () => {
    const receiptOnly = gmailMessage({
      id: "m4",
      subject: "Your receipt",
      snippet: "Thanks for your purchase.",
    });
    expect(
      normalizeGmailSearchQueryMatches("invoice OR receipt", receiptOnly),
    ).toBe(true);
  });

  it("keeps AND semantics for plain multi-token queries", () => {
    expect(
      normalizeGmailSearchQueryMatches("from:alice invoice", fromAlice),
    ).toBe(false);
    const aliceInvoice = gmailMessage({
      id: "m5",
      from: "Alice <alice@corp.com>",
      fromEmail: "alice@corp.com",
      subject: "Invoice attached",
    });
    expect(
      normalizeGmailSearchQueryMatches("from:alice invoice", aliceInvoice),
    ).toBe(true);
  });

  it("splits flat disjunct runs: 'a b OR c' means (a AND b) OR c", () => {
    // Matches Gmail: `from:alice invoice OR receipt` is
    // (from:alice AND invoice) OR receipt.
    const query = "from:alice invoice OR receipt";
    const bobReceipt = gmailMessage({ id: "m6", subject: "Your receipt" });
    expect(normalizeGmailSearchQueryMatches(query, bobReceipt)).toBe(true);
    expect(normalizeGmailSearchQueryMatches(query, fromAlice)).toBe(false);
  });

  it("treats redundant uppercase OR inside brace groups as syntax, not a substring", () => {
    const query = "{from:alice OR from:bob}";
    expect(normalizeGmailSearchQueryMatches(query, fromBob)).toBe(true);
    expect(normalizeGmailSearchQueryMatches(query, fromAlice)).toBe(true);
    // Carol's address contains `corp`, so the old bare-OR substring fallback
    // incorrectly matched this unrelated message through the group's `some`.
    expect(normalizeGmailSearchQueryMatches(query, fromCarol)).toBe(false);
    expect(normalizeGmailSearchQueryMatches("{OR}", fromBob)).toBe(false);
  });

  it("treats lowercase 'or' as a plain search term (Gmail requires uppercase OR)", () => {
    const orText = gmailMessage({
      id: "m7",
      subject: "Vendor form",
      snippet: "Choose one or the other option.",
    });
    expect(normalizeGmailSearchQueryMatches("invoice or receipt", orText)).toBe(
      false,
    );
    const invoiceOrReceipt = gmailMessage({
      id: "m8",
      subject: "Invoice",
      snippet: "Pay this invoice or keep the receipt.",
    });
    expect(
      normalizeGmailSearchQueryMatches("invoice or receipt", invoiceOrReceipt),
    ).toBe(true);
  });

  it("drops empty runs from leading/trailing/doubled OR; all-OR matches nothing", () => {
    expect(normalizeGmailSearchQueryMatches("OR from:bob OR", fromBob)).toBe(
      true,
    );
    expect(
      normalizeGmailSearchQueryMatches("from:alice OR OR from:bob", fromBob),
    ).toBe(true);
    expect(normalizeGmailSearchQueryMatches("OR OR", fromBob)).toBe(false);
  });

  it("does not treat after:2026-02-31 as after March 3", () => {
    const marchThird = gmailMessage({
      id: "m-mar3",
      subject: "March standup",
      receivedAt: "2026-03-03T12:00:00.000Z",
    });
    expect(
      normalizeGmailSearchQueryMatches("after:2026-02-31", marchThird),
    ).toBe(false);
    expect(
      normalizeGmailSearchQueryMatches("after:2026-03-03", marchThird),
    ).toBe(true);
  });

  it("filters end-to-end through filterGmailMessagesBySearch", () => {
    const result = filterGmailMessagesBySearch({
      messages: [fromBob, fromAlice, fromCarol],
      query: "from:alice OR from:bob",
    });
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });
});
