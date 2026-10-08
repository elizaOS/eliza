import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatRelativeTimeShort } from "./format.ts";

describe("formatRelativeTime future boundaries", () => {
  it("does not jump to the next unit just after a boundary", () => {
    const now = Date.now();
    expect(formatRelativeTimeShort(new Date(now + 61_000))).toBe("in 1m");
    expect(formatRelativeTime(new Date(now + 61_000))).toBe("in 1m");
    expect(formatRelativeTimeShort(new Date(now + 61 * 60_000))).toBe("in 1h");
    expect(formatRelativeTimeShort(new Date(now + 86_400_000 + 60_000))).toBe(
      "in 1d",
    );
    expect(formatRelativeTimeShort(new Date(now - 61_000))).toBe("1m");
  });
});
