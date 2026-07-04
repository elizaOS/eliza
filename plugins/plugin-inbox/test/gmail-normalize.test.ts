/**
 * Guards the public Gmail normalization helpers used by inbox tests and
 * integration callers. These cases cover delimiter handling, address
 * canonicalization, and range checks for search and unresponded-age filters.
 */
import { describe, expect, it } from "vitest";
import {
  extractNormalizedEmailAddress,
  normalizeGmailSearchQuery,
  normalizeGmailUnrespondedOlderThanDays,
  parseGmailDateBoundary,
  parseGmailRelativeDuration,
  splitMailboxLikeList,
} from "../src/inbox/gmail-normalize.js";

describe("splitMailboxLikeList", () => {
  it("splits on , ; newline and || but not inside quotes or angle brackets", () => {
    expect(splitMailboxLikeList("a@b.com, c@d.com")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
    expect(splitMailboxLikeList("a@b.com || c@d.com")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
    expect(splitMailboxLikeList('"Doe, John" <j@d.com>, k@e.com')).toEqual([
      '"Doe, John" <j@d.com>',
      "k@e.com",
    ]);
    expect(splitMailboxLikeList("")).toEqual([]);
    expect(splitMailboxLikeList("   ")).toEqual([]);
  });
});

describe("extractNormalizedEmailAddress", () => {
  it("pulls the address from display/angle/mailto forms and lowercases it", () => {
    expect(extractNormalizedEmailAddress("John Doe <John@Example.COM>")).toBe(
      "john@example.com",
    );
    expect(extractNormalizedEmailAddress("mailto:Foo@Bar.com")).toBe(
      "foo@bar.com",
    );
    expect(extractNormalizedEmailAddress("plain@text.org")).toBe(
      "plain@text.org",
    );
  });

  it("returns null for non-addresses", () => {
    expect(extractNormalizedEmailAddress("not an email")).toBeNull();
    expect(extractNormalizedEmailAddress("a@b")).toBeNull(); // no TLD
    expect(extractNormalizedEmailAddress("")).toBeNull();
  });
});

describe("normalizeGmailSearchQuery", () => {
  it("keeps a valid query and rejects empty / over-long input", () => {
    expect(normalizeGmailSearchQuery("from:bob is:unread")).toBe(
      "from:bob is:unread",
    );
    expect(() => normalizeGmailSearchQuery("")).toThrow();
    expect(() => normalizeGmailSearchQuery("x".repeat(501))).toThrow();
  });
});

describe("normalizeGmailUnrespondedOlderThanDays", () => {
  it("defaults to 3, truncates, and enforces 1..3650", () => {
    expect(normalizeGmailUnrespondedOlderThanDays(undefined)).toBe(3);
    expect(normalizeGmailUnrespondedOlderThanDays("")).toBe(3);
    expect(normalizeGmailUnrespondedOlderThanDays("7.9")).toBe(7);
    expect(() => normalizeGmailUnrespondedOlderThanDays(0)).toThrow();
    expect(() => normalizeGmailUnrespondedOlderThanDays(4000)).toThrow();
  });
});

describe("parseGmailRelativeDuration", () => {
  it("parses d/m/y into milliseconds, else null", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(parseGmailRelativeDuration("3d")).toBe(3 * day);
    expect(parseGmailRelativeDuration("2M")).toBe(60 * day); // 2 * 30d
    expect(parseGmailRelativeDuration("1y")).toBe(365 * day);
    expect(parseGmailRelativeDuration("0d")).toBeNull();
    expect(parseGmailRelativeDuration("3w")).toBeNull();
    expect(parseGmailRelativeDuration("nope")).toBeNull();
  });
});

describe("parseGmailDateBoundary", () => {
  it("parses YYYY-MM-DD (and slash variant) as a UTC epoch, else null", () => {
    expect(parseGmailDateBoundary("2026-06-23")).toBe(Date.UTC(2026, 5, 23));
    expect(parseGmailDateBoundary("2026/06/23")).toBe(Date.UTC(2026, 5, 23));
    expect(parseGmailDateBoundary("2026-13-01")).toBeNull();
    expect(parseGmailDateBoundary("2026-06-40")).toBeNull();
    expect(parseGmailDateBoundary("garbage")).toBeNull();
  });
});
