/**
 * Regression for wallet RPC surrogate-safe truncation (200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const WALLET_LIMIT = 200;

function clampWallet(text: string): string {
  const wellFormed = toWellFormedUnicode(text ?? "");
  return truncateWellFormed(wellFormed, WALLET_LIMIT);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("wallet RPC well-formed", () => {
  it("backs off astral at 200 boundary (199+fox->199)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(199)}${fox}${"b".repeat(20)}`;
    const out = clampWallet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(199);
    expect(out).toBe("a".repeat(199));
  });

  it("preserves fitting astral at 200 (198+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(198)}${fox}`;
    const out = clampWallet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(200);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `wallet ${String.fromCharCode(0xd800)} text`;
    const out = clampWallet(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough", () => {
    expect(clampWallet("short")).toBe("short");
  });

  it("sweep around 200 well-formed", () => {
    const fox = "🦊";
    for (let n = 195; n <= 205; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampWallet(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(200);
    }
  });
});
