/**
 * Proves wallet boundedIntParam + market trades limit clamp fixes (rank 8 systematic).
 * Wallet: Number(params.get||fallback) + trunc → /^\\d+$/. Market: raw forwarding → parseClampedLimit/Offset.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const walletPath = new URL("../../../../api/v1/eliza/agents/[agentId]/api/wallet/[...path]/route.ts", import.meta.url).pathname;
const marketPath = new URL("../../../../api/v1/market/trades/[chain]/[address]/route.ts", import.meta.url).pathname;

describe("clamp wallet+market — file uses strict regex/parseClampedLimit", () => {
  test("wallet boundedIntParam uses /^\\d+$/ not Number(get||fallback)", () => {
    const src = readFileSync(walletPath, "utf8");
    expect(src).toContain('/^\\d+$/.test(trimmed)');
    expect(src).toContain('Number.isSafeInteger(parsed)');
    expect(src).not.toContain('Number(params.get(name) ?? fallback)');
    expect(src).not.toContain('Math.trunc(raw)');
  });

  test("market trades uses parseClampedLimit/Offset not raw forwarding", () => {
    const src = readFileSync(marketPath, "utf8");
    expect(src).toContain('parseClampedLimit');
    expect(src).toContain('parseClampedOffset');
    expect(src).toContain('rawLimit !== null && rawLimit !== ""');
    expect(src).not.toContain('const limit = searchParams.get("limit");\n  if (limit) requestParams.limit = limit;');
  });

  test("direct Number vs strict regex proof", () => {
    // Number("5junk") = NaN, but Number("1e4")=10000, Number("0x10")=16, Number("5.9")=5.9 trunc 5
    // Strict /\d+$/ rejects all except "5"
    const strict = (s: string) => /^\d+$/.test(s.trim()) ? Number(s.trim()) : null;
    expect(strict("5")).toBe(5);
    expect(strict("5junk")).toBe(null);
    expect(strict("1e4")).toBe(null);
    expect(strict("0x10")).toBe(null);
    expect(strict("5.9")).toBe(null);
    expect(strict("-5")).toBe(null);
    expect(strict(" 5 ")).toBe(5);
    expect(strict("")).toBe(null);
    // Old Number path
    expect(Number("5junk")).toBeNaN();
    expect(Number("1e4")).toBe(10000);
    expect(Number("0x10")).toBe(16);
    expect(Math.trunc(Number("5.9"))).toBe(5);
  });
});
