/**
 * Covers Gmail input normalization for owner and LLM-supplied query values.
 * These tests pin address extraction, mailbox-list splitting, duration parsing,
 * and label/message id validation before values reach Gmail API calls.
 */
import { describe, expect, it } from "vitest";
import {
  extractNormalizedEmailAddress,
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
