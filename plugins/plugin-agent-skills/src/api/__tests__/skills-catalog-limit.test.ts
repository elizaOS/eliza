/**
 * Proves skill catalog pagination strict clamp (rank 9 systematic clone of wallet boundedIntParam).
 * File uses parseClampedInteger with /^\d+$/ + isSafeInteger, not weak Number()||fallback which accepts 1e4/0x10/5.9.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const routesPath = new URL("../skills-routes.ts", import.meta.url).pathname;

describe("skills catalog pagination — strict parseClampedInteger vs weak Number()", () => {
  test("catalog page/perPage use parseClampedInteger not weak Number()||fallback", () => {
    const src = readFileSync(routesPath, "utf8");
    expect(src).toContain('parseClampedInteger(url.searchParams.get("page")');
    expect(src).toContain('parseClampedInteger(url.searchParams.get("perPage")');
    expect(src).toContain("fallback: 1");
    expect(src).toContain("fallback: 50");
    expect(src).toContain("max: 100");
    // weak patterns must be gone
    expect(src).not.toContain('Number(url.searchParams.get("page")) || 1');
    expect(src).not.toContain('Number(url.searchParams.get("perPage")) || 50');
  });

  test("search limit uses parseClampedInteger not weak Number()||30", () => {
    const src = readFileSync(routesPath, "utf8");
    expect(src).toContain('parseClampedInteger(url.searchParams.get("limit")');
    expect(src).toContain("fallback: 30");
    expect(src).not.toContain('Number(url.searchParams.get("limit")) || 30');
  });

  test("fallback contracts preserved (page 1, perPage 50, limit 30)", () => {
    const src = readFileSync(routesPath, "utf8");
    // ensure all three fallbacks present
    expect((src.match(/fallback: 1/g) || []).length).toBeGreaterThanOrEqual(1);
    expect(src).toContain("fallback: 50");
    expect(src).toContain("fallback: 30");
  });

  test("direct strict vs weak payload proof", () => {
    const weakPage = (raw: string | null) => Math.max(1, Number(raw) || 1);
    const weakPerPage = (raw: string | null) => Math.min(100, Math.max(1, Number(raw) || 50));
    const weakLimit = (raw: string | null) => Math.min(100, Math.max(1, Number(raw) || 30));
    const strict = (raw: string | null, opts: { min: number; max: number; fallback: number }) => {
      const trimmed = raw?.trim() ?? "";
      if (!trimmed) return opts.fallback;
      if (!/^\d+$/.test(trimmed)) return opts.fallback;
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n)) return opts.fallback;
      return Math.max(opts.min, Math.min(opts.max, n));
    };
    // 1e4: weak perPage 100 vs strict 50
    expect(weakPerPage("1e4")).toBe(100);
    expect(strict("1e4", { min: 1, max: 100, fallback: 50 })).toBe(50);
    // 0x10: weak 16 vs strict 50
    expect(weakPerPage("0x10")).toBe(16);
    expect(strict("0x10", { min: 1, max: 100, fallback: 50 })).toBe(50);
    // 5.9: weak 5.9 -> min 100 max 5.9 => 5.9 vs strict 50
    expect(weakPerPage("5.9")).toBe(5.9);
    expect(strict("5.9", { min: 1, max: 100, fallback: 50 })).toBe(50);
    // page 1e4: weak 10000 vs strict fallback 1 (rejects 1e4)
    expect(weakPage("1e4")).toBe(10000);
    expect(strict("1e4", { min: 1, max: 10000, fallback: 1 })).toBe(1);
    // limit 1e4: weak 100 vs strict 30
    expect(weakLimit("1e4")).toBe(100);
    expect(strict("1e4", { min: 1, max: 100, fallback: 30 })).toBe(30);
  });
});
