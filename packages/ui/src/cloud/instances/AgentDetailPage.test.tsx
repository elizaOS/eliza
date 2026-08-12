/** Pure date helpers — no React tree / core keyword graph required. */
import { describe, expect, it, vi } from "vitest";
import {
  formatDate,
  formatRelativeShort,
  formatTime,
} from "./agent-detail-dates";

const t = vi.fn(
  (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
) as never;

/** Beyond ECMAScript TimeClip (±8.64e15 ms) — getTime is non-finite. */
const OUTSIDE_TIMECLIP = "275760-09-13T00:00:00.000Z";

describe("AgentDetailPage date formatting", () => {
  it("renders an unavailable fallback for malformed non-null dates", () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatRelativeShort("not-a-date", t)).toBe("Never");
    expect(formatTime("not-a-date")).toBe("");
  });

  it("returns empty time for out-of-range timestamps instead of Invalid Date", () => {
    expect(formatTime(OUTSIDE_TIMECLIP)).toBe("");
    expect(formatDate(OUTSIDE_TIMECLIP)).toBe("—");
    expect(formatTime("not-a-date")).not.toMatch(/Invalid Date/i);
  });

  it("preserves valid and null date behavior", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatTime(null)).toBe("");
    expect(formatRelativeShort(null, t)).toBe("Never");
    expect(formatRelativeShort(new Date().toISOString(), t)).toBe("Just now");
    const valid = "2024-05-31T15:30:00.000Z";
    expect(formatTime(valid).length).toBeGreaterThan(0);
    expect(formatTime(valid)).not.toMatch(/Invalid Date/i);
  });
});
