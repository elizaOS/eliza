/**
 * Surrogate-safe truncation for wallet EVM balance helpers.
 * Verifies NFT description 200, error 200/400 caps stay well-formed.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncateDescription(desc: string): string {
  return truncateWellFormed(toWellFormedUnicode(desc ?? ""), 200);
}
function truncateError(text: string, fallback: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 200) || fallback;
}
function truncateErrors(errors: string[]): string {
  return truncateWellFormed(toWellFormedUnicode(errors.join(" | ")), 400);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("wallet-evm-balance surrogate handling", () => {
  it("NFT description 200 backs off at surrogate", () => {
    const input = `${"a".repeat(199)}🦊${"b".repeat(20)}`;
    const out = truncateDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.length).toBe(199);
  });

  it("NFT description preserves fitting emoji", () => {
    const input = `${"a".repeat(198)}🦊`;
    const out = truncateDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(198)}🦊`);
  });

  it("error text 200 sanitizes lone surrogate", () => {
    const lone = `error \ud800 details ${"a".repeat(300)}`;
    const out = truncateError(lone, "HTTP 500");
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
  });

  it("errors join 400 stays well-formed sweep", () => {
    for (let off = 0; off < 20; off++) {
      const errs = [`${"a".repeat(380 + off)}🦊`, "b".repeat(100)];
      const out = truncateErrors(errs);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(400);
    }
  });
});
