/** Verifies agent detail date formatting rejects malformed API timestamps. */
import { describe, expect, it, vi } from "vitest";
import { formatDate, formatRelativeShort } from "./AgentDetailPage";

const t = vi.fn(
  (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
) as never;

describe("AgentDetailPage date formatting", () => {
  it("renders an unavailable fallback for malformed non-null dates", async () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatRelativeShort("not-a-date", t)).toBe("Never");
  });

  it("preserves valid and null date behavior", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatRelativeShort(null, t)).toBe("Never");
    expect(formatRelativeShort(new Date().toISOString(), t)).toBe("Just now");
  });
});
