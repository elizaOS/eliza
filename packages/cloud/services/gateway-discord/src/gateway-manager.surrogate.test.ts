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
describe("gateway-manager 2000 Discord cap surrogate safety", () => {
  const R = "🦊";
  it("2000 cap backs off mid-pair", () => {
    const input = `${"a".repeat(1999)}${R}b`;
    const out = trunc(input, 2000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(1999);
  });
  it("preserves fitting emoji at 2000", () => {
    const input = `${"a".repeat(1998)}${R}`;
    expect(trunc(input, 2000)).toBe(`${"a".repeat(1998)}${R}`);
  });
  it("sweep 0..65 at 2000", () => {
    for (let off = 0; off <= 65; off++) {
      const input = `${"a".repeat(off)}${R}${"b".repeat(2100)}`;
      expect(isWellFormed(trunc(input, 2000))).toBe(true);
    }
  });
  it("lone surrogate sanitised", () => {
    const out = trunc(`ok \ud83d end ${"x".repeat(2100)}`, 2000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud83d")).toBe(false);
    expect(out.includes("�")).toBe(true);
  });
  it("under cap sanitises lone", () => {
    const input = `hi \ud83d ${"a".repeat(10)}`;
    const out = toWellFormedUnicode(input);
    expect(isWellFormed(out)).toBe(true);
  });
});
