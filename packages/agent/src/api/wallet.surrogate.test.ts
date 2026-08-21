/**
 * Regression for wallet surrogate-safe truncation.
 *
 * Two independent clamps: the 200-char per-endpoint RPC body/error preview and
 * the 400-char aggregate that joins every endpoint's error on total failure.
 * Neither may split an astral pair, and both sanitize lone surrogates so the
 * text stays well-formed once it is JSON-encoded on the wire.
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

function clampWalletError(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 400);
}

function clampWalletErrors(errors: string[]): string {
  return truncateWellFormed(toWellFormedUnicode(errors.join(" | ")), 400);
}

describe("wallet surrogate handling", () => {
  it("backs off astral at 400 boundary to 399", () => {
    const input = `${"a".repeat(399)}🦊${"b".repeat(20)}`;
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(399);
    expect(out.endsWith("🦊")).toBe(false);
  });

  it("fitting emoji at 400 stays intact", () => {
    const input = `${"a".repeat(398)}🦊`;
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(400);
  });

  it("short error passthrough stays well-formed", () => {
    const input = "Solana RPC unavailable: timeout 🦊";
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("lone high surrogate is sanitized to replacement", () => {
    const input = `error \ud800 details ${"a".repeat(500)}`;
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
  });

  it("lone low surrogate is sanitized to replacement", () => {
    const input = `error \udc00 details ${"a".repeat(500)}`;
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\udc00")).toBe(false);
  });

  it("sweep 0..30 offsets at 400 all well-formed", () => {
    for (let off = 0; off < 30; off++) {
      const input = `${"a".repeat(385 + off)}🦊${"b".repeat(50)}`;
      const out = clampWalletError(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(400);
    }
  });

  it("errors join 400 sweep stays well-formed", () => {
    for (let off = 0; off < 30; off++) {
      const errs = [`${"a".repeat(380 + off)}🦊`, "b".repeat(50)];
      const out = clampWalletErrors(errs);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(400);
    }
  });

  it("JSON.stringify never throws on truncated output", () => {
    const input = `${"a".repeat(399)}🦊 bad \ud800 \udc00 tail`;
    const out = clampWalletError(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify({ error: out })).not.toThrow();
  });
});
