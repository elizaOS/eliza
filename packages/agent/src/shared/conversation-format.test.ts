/**
 * Unit tests for conversation presentation helpers used by recent/relevant
 * conversation providers. Covers relative-timestamp fail-closed behavior for
 * non-finite and out-of-range createdAt values, plus the healthy finite buckets.
 */

import { describe, expect, it, vi } from "vitest";

import {
  formatRelativeTimestamp,
  formatRelativeTimestampPrefix,
  roomSourceTag,
} from "./conversation-format.ts";

describe("formatRelativeTimestamp", () => {
  it("returns empty for missing, zero, and non-finite timestamps", () => {
    expect(formatRelativeTimestamp(undefined)).toBe("");
    expect(formatRelativeTimestamp(0)).toBe("");
    expect(formatRelativeTimestamp(Number.NaN)).toBe("");
    expect(formatRelativeTimestamp(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatRelativeTimestamp(Number.NEGATIVE_INFINITY)).toBe("");
    // Outside the Date range: getTime() is NaN even though the number is finite.
    expect(formatRelativeTimestamp(Number.MAX_VALUE)).toBe("");
  });

  it("does not emit NaN-based garbage labels", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
    ]) {
      const label = formatRelativeTimestamp(value);
      expect(label).not.toMatch(/NaN/i);
      expect(label).toBe("");
    }
  });

  it("formats finite recent past timestamps into coarse buckets", () => {
    const now = Date.now();
    expect(formatRelativeTimestamp(now - 5_000)).toBe("just now");
    expect(formatRelativeTimestamp(now - 2 * 60_000)).toBe("2m ago");
    expect(formatRelativeTimestamp(now - 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeTimestamp(now - 4 * 86_400_000)).toBe("4d ago");
  });

  it("treats near-future timestamps as just now (clock skew)", () => {
    expect(formatRelativeTimestamp(Date.now() + 15_000)).toBe("just now");
  });
});

describe("formatRelativeTimestampPrefix", () => {
  it("omits both the label and parentheses for unavailable timestamps", () => {
    expect(formatRelativeTimestampPrefix()).toBe("");
    expect(formatRelativeTimestampPrefix(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatRelativeTimestampPrefix(Number.MAX_VALUE)).toBe("");
  });

  it("renders healthy labels as a parenthesized line prefix", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    expect(formatRelativeTimestampPrefix(1_700_000_000_000 - 120_000)).toBe(
      "(2m ago) ",
    );
  });
});

describe("roomSourceTag", () => {
  it("renders source and name, with fallbacks for missing room", () => {
    expect(roomSourceTag(null)).toBe("[unknown]");
    expect(
      roomSourceTag({
        id: "11111111-1111-1111-1111-111111111111",
        source: "discord",
        name: "general",
        type: "GROUP",
      } as never),
    ).toBe("[discord] general");
  });

  it("preserves complete room UUID without eight-character truncation when name is missing", () => {
    expect(
      roomSourceTag({
        id: "11111111-2222-3333-4444-555566667777",
        source: "slack",
        type: "GROUP",
      } as never),
    ).toBe("[slack] 11111111-2222-3333-4444-555566667777");

    expect(
      roomSourceTag({
        id: "11111111-2222-3333-4444-555566667777",
        name: "",
        type: "DIRECT",
      } as never),
    ).toBe("[DIRECT] 11111111-2222-3333-4444-555566667777");
  });
});
