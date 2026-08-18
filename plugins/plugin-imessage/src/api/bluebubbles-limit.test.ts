/**
 * Deterministically exercises BlueBubbles pagination parser.
 * Matches upstream ss251 validation (#21682) — rejects non-canonical
 * spellings to null (route returns 400), accepts canonical and clamps.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHATS_LIMIT,
  DEFAULT_MESSAGES_LIMIT,
  MAX_LIST_LIMIT,
  parseBlueBubblesLimit,
  parseBlueBubblesOffset,
} from "./bluebubbles-limit";

describe("bluebubbles limit strict", () => {
  it.each(["1e4", "0x10", "5.9", "0", "01", " 5", "5 "])(
    "limit rejects non-canonical %s to null",
    (value) => {
      expect(parseBlueBubblesLimit(value, 100)).toBeNull();
      expect(parseBlueBubblesLimit(value, 50)).toBeNull();
    }
  );

  it("limit returns default on null/empty", () => {
    expect(parseBlueBubblesLimit(null, 100)).toBe(100);
    expect(parseBlueBubblesLimit("", 100)).toBe(100);
    expect(parseBlueBubblesLimit(null, 50)).toBe(50);
  });

  it.each(["1e4", "0x10", "5.9", "-1", "01", " 5"])(
    "offset rejects non-canonical %s to null",
    (value) => {
      expect(parseBlueBubblesOffset(value)).toBeNull();
    }
  );

  it("offset returns 0 on null/empty", () => {
    expect(parseBlueBubblesOffset(null)).toBe(0);
    expect(parseBlueBubblesOffset("")).toBe(0);
  });

  it("accepts canonical integers and clamps large limit", () => {
    expect(parseBlueBubblesLimit("1", 100)).toBe(1);
    expect(parseBlueBubblesLimit("50", 100)).toBe(50);
    expect(parseBlueBubblesLimit("500", 100)).toBe(500);
    expect(parseBlueBubblesLimit("600", 100)).toBe(500);
    expect(parseBlueBubblesLimit("1000", 100)).toBe(500);
    expect(parseBlueBubblesLimit(String(MAX_LIST_LIMIT), 100)).toBe(500);
    expect(parseBlueBubblesLimit(String(MAX_LIST_LIMIT + 1), 100)).toBe(500);
  });

  it("accepts canonical offset including zero", () => {
    expect(parseBlueBubblesOffset("0")).toBe(0);
    expect(parseBlueBubblesOffset("10")).toBe(10);
    expect(parseBlueBubblesOffset("15")).toBe(15);
  });

  it("exposes defaults and max", () => {
    expect(DEFAULT_CHATS_LIMIT).toBe(100);
    expect(DEFAULT_MESSAGES_LIMIT).toBe(50);
    expect(MAX_LIST_LIMIT).toBe(500);
  });
});
