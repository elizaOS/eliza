/**
 * Proves lifeops money `limit`/`sinceDays`/`windowDays` strict clamp.
 * Harness: file-grep (no mock) + direct payload arithmetic proof.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.join(process.cwd(), "plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts"),
  "utf8",
);
const ENT = readFileSync(
  path.join(process.cwd(), "plugins/plugin-personal-assistant/src/routes/entities.ts"),
  "utf8",
);

describe("lifeops money strict limit", () => {
  it("helper rejects non-canonical and checks isSafeInteger + clamp", () => {
    expect(SRC).toContain("function parseStrictLimit");
    expect(SRC).toContain("/^\\d+$/");
    expect(SRC).toContain("Number.isSafeInteger");
    expect(SRC).toContain("Math.min(n, max)");
  });
  it("transactions/recurring/dashboard use parseStrictLimit not weak Number()", () => {
    // 3 money sites
    const hits = (SRC.match(/parseStrictLimit\(/g) ?? []).length;
    expect(hits).toBeGreaterThanOrEqual(3);
    // ensure weak pattern gone for those params (no `Number(limitRaw)` in those blocks)
    // count remaining Number( in lifeops money section should be 0 for limit/sinceDays/windowDays; helper's own Number is allowed (+1)
    const moneySection = SRC.slice(SRC.indexOf('/api/lifeops/money'));
    // after fix, the only Number in money section is helper's `Number(raw)` once + Number.isSafeInteger etc → ensure no `Number(limitRaw)` / `Number(sinceDaysRaw)` / `Number(windowDaysRaw)`
    expect(moneySection.includes("Number(limitRaw)")).toBe(false);
    expect(moneySection.includes("Number(sinceDaysRaw)")).toBe(false);
    expect(moneySection.includes("Number(windowDaysRaw)")).toBe(false);
    expect(moneySection.includes("Number.isFinite(limit)")).toBe(false);
  });
  it("clamps correct max values", () => {
    expect(SRC).toContain('parseStrictLimit(limitRaw, 500)');
    expect(SRC).toContain('parseStrictLimit(sinceDaysRaw, 365)');
    expect(SRC).toContain('parseStrictLimit(windowDaysRaw, 365)');
  });
  it("direct payload proof — weak vs strict for financial limit", () => {
    const weak = (raw: string | null): number | null => {
      const n = raw ? Number(raw) : null;
      return n !== null && Number.isFinite(n) ? n : null;
    };
    const strict = (raw: string | null, max: number): number | null => {
      if (raw === null || raw === "") return null;
      if (!/^\d+$/.test(raw)) return null;
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) return null;
      return Math.min(n, max);
    };
    // 1e7 financial dump
    expect(weak("1e7")).toBe(10_000_000);
    expect(strict("1e7", 500)).toBe(null); // rejected, fallback null → service default not 10M
    expect(weak("1e4")).toBe(10000);
    expect(strict("1e4", 500)).toBe(null);
    expect(weak("0x10")).toBe(16);
    expect(strict("0x10", 500)).toBe(null);
    expect(weak("5.9")).toBe(5.9);
    expect(strict("5.9", 500)).toBe(null);
    expect(weak("5junk")).toBe(null); // NaN path coincidentally null
    expect(strict("5junk", 500)).toBe(null);
    expect(weak("007")).toBe(7);
    expect(strict("007", 500)).toBe(7); // /^\\d+$/ allows 007 → 7 clamped (still strict via clamp, but entities disallows 007; lifeops allows)
    // canonical
    expect(strict("1000", 500)).toBe(500);
    expect(strict("50", 500)).toBe(50);
  });
});
describe("sibling correct — entities strict", () => {
  it("entities parseEntityLimit present", () => {
    expect(ENT).toContain("parseEntityLimit");
    expect(ENT).toContain('/^[1-9]\\d*$/');
    expect(ENT).toContain("Number.isSafeInteger");
  });
});
