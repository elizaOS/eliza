import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function trunc(s: string, cap: number) {
  return truncateWellFormed(toWellFormedUnicode(s), cap);
}
const isWellFormed = (s: string) => {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
};
describe("browser-workspace-desktop 240/800 surrogate safety", () => {
  const R = "🦊";
  it("240 backs off mid-pair", () => {
    const out = trunc(`${"a".repeat(239)}${R}b`, 240);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
  });
  it("800 backs off mid-pair", () => {
    const out = trunc(`${"a".repeat(799)}${R}b`, 800);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(799);
  });
  it("preserves fitting emoji", () => {
    expect(trunc(`${"a".repeat(238)}${R}`, 240)).toBe(`${"a".repeat(238)}${R}`);
    expect(trunc(`${"a".repeat(798)}${R}`, 800)).toBe(`${"a".repeat(798)}${R}`);
  });
  it("sweep at 240", () => {
    for (let off = 0; off <= 65; off++) {
      expect(
        isWellFormed(trunc(`${"a".repeat(off)}${R}${"b".repeat(500)}`, 240)),
      ).toBe(true);
    }
  });
  it("lone surrogate sanitised", () => {
    const out = trunc(`ok \ud83d ${"x".repeat(500)}`, 240);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud83d")).toBe(false);
  });
});
