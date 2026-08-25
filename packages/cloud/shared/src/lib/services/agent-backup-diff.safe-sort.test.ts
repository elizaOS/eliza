/**
 * Safe NaN handling for backup diff newestFirst sort.
 */
import { describe, expect, it } from "vitest";

function safeSort(nodes: { createdAtMs: number; id: string }[]) {
  return [...nodes].sort((a, b) => {
    const aTime = Number.isFinite(a.createdAtMs) ? a.createdAtMs : 0;
    const bTime = Number.isFinite(b.createdAtMs) ? b.createdAtMs : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

describe("backup-diff safe-sort", () => {
  it("sorts descending", () => {
    expect(
      safeSort([
        { createdAtMs: 1, id: "a" },
        { createdAtMs: 2, id: "b" },
      ])[0].id,
    ).toBe("b");
  });
  it("NaN fallback", () => {
    expect(
      safeSort([
        { createdAtMs: NaN, id: "a" },
        { createdAtMs: 1, id: "b" },
      ])[0].id,
    ).toBe("b");
  });
  it("tiebreak", () => {
    expect(
      safeSort([
        { createdAtMs: 1, id: "b" },
        { createdAtMs: 1, id: "a" },
      ])[0].id,
    ).toBe("a");
  });
});
