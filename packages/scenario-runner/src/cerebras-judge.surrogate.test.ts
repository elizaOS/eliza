import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function trunc(text: string, cap: number) {
  return truncateWellFormed(toWellFormedUnicode(text), cap);
}
const isWellFormed = (s: string) => {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
};

describe("cerebras-judge errBody 300 surrogate safety (Cerebras strict)", () => {
  const R = "🦊";
  it("300 cap backs off mid-pair", () => {
    const input = `${"a".repeat(299)}${R}b`;
    const out = trunc(input, 300);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(299);
  });
  it("preserves fitting emoji at 300", () => {
    const input = `${"a".repeat(298)}${R}`;
    expect(trunc(input, 300)).toBe(`${"a".repeat(298)}${R}`);
  });
  it("sweep 0..65 at 300 stays well-formed", () => {
    for (let off = 0; off <= 65; off++) {
      const input = `${"a".repeat(off)}${R}${"b".repeat(500)}`;
      expect(isWellFormed(trunc(input, 300))).toBe(true);
      expect(() => JSON.stringify(trunc(input, 300))).not.toThrow();
    }
  });
  it("lone surrogate sanitised", () => {
    const out = trunc(`ok \ud83d end ${"x".repeat(500)}`, 300);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud83d")).toBe(false);
    expect(out.includes("�")).toBe(true);
  });
  it("error message stays well-formed across wire", () => {
    const errBody = `${"a".repeat(299)}${R}${"b".repeat(100)}`;
    const msg = `cerebras error 500: ${trunc(errBody, 300)}`;
    expect(isWellFormed(msg)).toBe(true);
    expect(() => JSON.stringify(msg)).not.toThrow();
    // Cerebras strict parser would reject lone surrogate — ensure not present
    expect(msg.includes("\ud83d") && !msg.includes(R)).toBe(false);
  });
});
