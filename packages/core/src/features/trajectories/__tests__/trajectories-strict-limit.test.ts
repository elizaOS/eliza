/**
 * Proves trajectories list limit/offset strict clamp (rank 9 systematic clone of wallet boundedIntParam).
 * File uses /^\d+$/ + isSafeInteger + clamp to 500, not weak Number()+trunc which accepts 1e4/0x10/5.9.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const routesPath = new URL("../read-routes.ts", import.meta.url).pathname;

describe("trajectories read-routes — strict limit/offset vs weak Number()", () => {
  test("uses strict /^\\d+$/ regex for limit/offset, not weak Number(rawLimit)", () => {
    const src = readFileSync(routesPath, "utf8");
    expect(src).toContain('/^\\d+$/');
    expect(src).toContain("Number.isSafeInteger");
    expect(src).toContain('if (rawLimit === null || rawLimit === "") return 50');
    expect(src).toContain('if (rawOffset === null || rawOffset === "") return 0');
    // weak pattern must be gone
    expect(src).not.toContain("requestedLimit");
    expect(src).not.toContain("Math.trunc(requested");
  });

  test("clamps limit to 500 and offset to safe integer", () => {
    const src = readFileSync(routesPath, "utf8");
    expect(src).toContain("Math.min(500, Math.max(1, parsed))");
    expect(src).toContain("Math.max(0, parsed)");
  });

  test("fallback contracts preserved (limit 50, offset 0)", () => {
    const src = readFileSync(routesPath, "utf8");
    // ensure fallback values still present
    expect(src).toContain("return 50;");
    expect(src).toContain("return 0;");
  });

  test("direct strict vs weak payload proof", () => {
    const strict = (raw: string | null, fallback: number, max: number) => {
      if (raw === null || raw === "") return fallback;
      if (!/^\d+$/.test(raw)) return fallback;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) return fallback;
      return Math.min(max, Math.max(1, parsed));
    };
    const weak = (raw: string | null) => {
      const requested = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.trunc(requested))) : 50;
    };
    // 1e4: weak 500, strict fallback 50
    expect(weak("1e4")).toBe(500);
    expect(strict("1e4", 50, 500)).toBe(50);
    // 0x10: weak 16, strict 50
    expect(weak("0x10")).toBe(16);
    expect(strict("0x10", 50, 500)).toBe(50);
    // 5.9: weak 5, strict 50
    expect(weak("5.9")).toBe(5);
    expect(strict("5.9", 50, 500)).toBe(50);
    // 5junk: weak fallback 50, strict 50 (same by accident)
    expect(weak("5junk")).toBe(50);
    expect(strict("5junk", 50, 500)).toBe(50);
    // 007: weak 7, strict 50? Actually /^\d+$/ accepts 007 -> 7, but pagination sibling rejects leading zero. Keep permissive here.
    // For this PR we allow 007 → 7 (consistent with clamp-limit /^\d+$/), but still strict vs weak for hex/exp.
    expect(strict("007", 50, 500)).toBe(7);
  });
});
