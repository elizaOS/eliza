/**
 * Regression for Telegram surrogate-safe truncation (issue #23500).
 * Uses real well-formed helpers, no mocks.
 */
import { describe, expect, it } from "vitest";
import { truncateTelegramCommandReply } from "./command-registration";
import { truncateForumTopicName } from "./service";

function isWellFormed(s: string): boolean {
  return s.isWellFormed();
}

describe("truncateTelegramCommandReply (4096)", () => {
  it("keeps short text intact", () => {
    const s = "hello";
    expect(truncateTelegramCommandReply(s)).toBe(s);
    expect(isWellFormed(truncateTelegramCommandReply(s))).toBe(true);
  });

  it("keeps exact 4096 with emoji at boundary", () => {
    const s = `${"a".repeat(4094)}🦊`;
    expect(s.length).toBe(4096);
    expect(truncateTelegramCommandReply(s)).toBe(s);
    expect(isWellFormed(truncateTelegramCommandReply(s))).toBe(true);
  });

  it("backs off one unit when 4095 + 🦊 would split at 4096", () => {
    const s = `${"a".repeat(4095)}🦊${"b".repeat(10)}`;
    const out = truncateTelegramCommandReply(s);
    expect(out.length).toBe(4095);
    expect(out).toBe("a".repeat(4095));
    expect(isWellFormed(out)).toBe(true);
    const raw = s.slice(0, 4096);
    expect(isWellFormed(raw)).toBe(false);
  });

  it("sanitizes lone high surrogate", () => {
    const s = `ok \ud800 end ${"a".repeat(4090)}`;
    const out = truncateTelegramCommandReply(s);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone low surrogate", () => {
    const s = `ok \udc00 end ${"a".repeat(4090)}`;
    const out = truncateTelegramCommandReply(s);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("preserves well-formed under limit", () => {
    const s = `a\ud800bc`;
    const out = truncateTelegramCommandReply(s);
    expect(out).toBe(`a\ufffdbc`);
    expect(isWellFormed(out)).toBe(true);
  });
});

describe("truncateForumTopicName (128)", () => {
  it("keeps short name intact", () => {
    const s = "thread";
    expect(truncateForumTopicName(s)).toBe(s);
  });

  it("keeps exact 128 with emoji", () => {
    const s = `${"a".repeat(126)}🦊`;
    expect(s.length).toBe(128);
    expect(truncateForumTopicName(s)).toBe(s);
    expect(isWellFormed(truncateForumTopicName(s))).toBe(true);
  });

  it("backs off when 127 + 🦊 would split at 128", () => {
    const s = `${"a".repeat(127)}🦊${"b".repeat(10)}`;
    const out = truncateForumTopicName(s);
    expect(out.length).toBe(127);
    expect(out).toBe("a".repeat(127));
    expect(isWellFormed(out)).toBe(true);
    const raw = s.slice(0, 128);
    expect(isWellFormed(raw)).toBe(false);
  });

  it("sanitizes lone surrogates", () => {
    for (const lone of [`ok \ud800 end`, `ok \udc00 end`]) {
      const out = truncateForumTopicName(lone);
      expect(out).toContain("�");
      expect(isWellFormed(out)).toBe(true);
    }
  });

  it("handles undefined via default thread", () => {
    const out = truncateForumTopicName(undefined);
    expect(out).toBe("thread");
  });
});
