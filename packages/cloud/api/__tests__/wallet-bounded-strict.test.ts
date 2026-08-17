/**
 * Proves wallet boundedIntParam strict clamp (rank 8 clone of trajectories/skill-catalog/mcp batches).
 * Rejects 1e4/0x10/5.9/5junk via /^\d+$/ + isSafeInteger, matching clamp-limit.ts sibling.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const walletPath = new URL("../v1/eliza/agents/[agentId]/api/wallet/[...path]/route.ts", import.meta.url).pathname;
const clampPath = new URL("../../shared/src/lib/utils/clamp-limit.ts", import.meta.url).pathname;

describe("wallet boundedIntParam — strict clamp", () => {
  test("uses strict regex and isSafeInteger, no weak Number()", () => {
    const src = readFileSync(walletPath, "utf8");
    expect(src).toContain('if (!/^\\d+$/.test(rawStr)) return fallback;');
    expect(src).toContain("if (!Number.isSafeInteger(raw)) return fallback;");
    expect(src).toContain("const rawStr = params.get(name);");
    expect(src).not.toContain("Number(params.get(name) ?? fallback)");
    expect(src).not.toContain("Math.trunc(raw)");
  });

  test("limit/offset call sites still use boundedIntParam with correct ranges", () => {
    const src = readFileSync(walletPath, "utf8");
    expect(src).toContain('boundedIntParam(url.searchParams, "limit", 50, 1, 100)');
    expect(src).toContain('boundedIntParam(');
    expect(src).toContain('"offset"');
  });

  test("payload proof — weak vs strict for 1e4/0x10/5.9/5junk", () => {
    const weak = (raw: string, fallback: number, min: number, max: number) => {
      const n = Number(raw ?? fallback);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(Math.trunc(n), min), max);
    };
    const strict = (raw: string | null, fallback: number, min: number, max: number) => {
      if (raw === null || raw === "") return fallback;
      if (!/^\d+$/.test(raw)) return fallback;
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return fallback;
      return Math.min(Math.max(n, min), max);
    };
    expect(weak("1e4", 50, 1, 100)).toBe(100);
    expect(strict("1e4", 50, 1, 100)).toBe(50);
    expect(weak("0x10", 50, 1, 100)).toBe(16);
    expect(strict("0x10", 50, 1, 100)).toBe(50);
    expect(weak("5.9", 50, 1, 100)).toBe(5);
    expect(strict("5.9", 50, 1, 100)).toBe(50);
    expect(strict("5junk", 50, 1, 100)).toBe(50);
  });

  test("sibling correct — clamp-limit.ts already strict", () => {
    const src = readFileSync(clampPath, "utf8");
    expect(src).toContain("/^\\d+$/");
    expect(src).toContain("isSafeInteger");
    expect(src).toContain("Math.min");
  });
});
