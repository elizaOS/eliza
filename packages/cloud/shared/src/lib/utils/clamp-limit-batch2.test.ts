/**
 * Pins cloud pagination limit/offset clamps for 4 routes — admin orgs/users,
 * documents, and my-agents characters — against the same `^\d+$` +
 * `isSafeInteger` contract as the shared helper.
 * Guards the `parseInt("5junk")→5` and `Math.min(NaN,…)→NaN` leaks where
 * `?limit=abc` produced `NaN` propagated to Drizzle (limit NaN / offset NaN /
 * totalPages NaN) and `?limit=-10` bypassed `Math.max` via `||` fallback.
 * Sibling correct: `packages/cloud/api/v1/admin/docker-containers/route.ts:36`
 * `parseContainerListLimit` with `/^[1-9]\d*$/` + `isSafeInteger` + `Math.min`,
 * and `packages/cloud/api/v1/redemptions/route.ts:22` `parseClampedLimit`.
 */

import { describe, expect, test } from "bun:test";
import { parseClampedLimit, parseClampedOffset } from "./clamp-limit";

function oldParseLimitAdmin(raw: string | undefined): number {
  return Math.min(parseInt(raw || "200", 10), 1000);
}
function oldParseDocumentsLimit(raw: string | undefined): number {
  return Math.min(Number.parseInt(raw ?? "100", 10) || 100, 200);
}
function oldParseDocumentsOffset(raw: string | undefined): number {
  return Math.max(Number.parseInt(raw ?? "0", 10) || 0, 0);
}
function oldParseMyAgentsPage(raw: string | undefined): number {
  return Math.max(1, parseInt(raw || "1", 10));
}
function oldParseMyAgentsLimit(raw: string | undefined): number {
  return Math.min(1000, Math.max(1, parseInt(raw || "30", 10)));
}

describe("clamp-limit batch2 — 4 routed sites", () => {
  test("admin orgs/users: fallback 200 max 1000 strict", () => {
    expect(parseClampedLimit(null, 200, 1000)).toBe(200);
    expect(parseClampedLimit("", 200, 1000)).toBe(200);
    expect(parseClampedLimit("200", 200, 1000)).toBe(200);
    expect(parseClampedLimit("500", 200, 1000)).toBe(500);
    expect(parseClampedLimit("1000", 200, 1000)).toBe(1000);
    expect(parseClampedLimit("2000", 200, 1000)).toBe(1000);
    // strict rejects
    for (const bad of ["abc", "-5", "0", "5junk", " 5", "5.5", "+5", "Infinity"]) {
      expect(parseClampedLimit(bad, 200, 1000)).toBe(200);
    }
    // old leak: 5junk→5 not 200
    expect(oldParseLimitAdmin("5junk")).toBe(5);
    expect(parseClampedLimit("5junk", 200, 1000)).toBe(200);
    // old leak: abc→NaN (no fallback)
    expect(Number.isNaN(oldParseLimitAdmin("abc"))).toBe(true);
    expect(parseClampedLimit("abc", 200, 1000)).toBe(200);
  });

  test("documents limit: fallback 100 max 200 strict", () => {
    expect(parseClampedLimit(null, 100, 200)).toBe(100);
    expect(parseClampedLimit("100", 100, 200)).toBe(100);
    expect(parseClampedLimit("50", 100, 200)).toBe(50);
    expect(parseClampedLimit("300", 100, 200)).toBe(200);
    for (const bad of ["abc", "-10", "0", "5junk", "Infinity", "5.5"]) {
      expect(parseClampedLimit(bad, 100, 200)).toBe(100);
    }
    // old documents limit: -10→ -10 (||100 short-circuit fails)
    expect(oldParseDocumentsLimit("-10")).toBe(-10);
    expect(parseClampedLimit("-10", 100, 200)).toBe(100);
    // old 5junk→5 not fallback
    expect(oldParseDocumentsLimit("5junk")).toBe(5);
    expect(parseClampedLimit("5junk", 100, 200)).toBe(100);
  });

  test("documents offset: allow 0 strict, fallback 0", () => {
    expect(parseClampedOffset(null, 0)).toBe(0);
    expect(parseClampedOffset("", 0)).toBe(0);
    expect(parseClampedOffset("0", 0)).toBe(0);
    expect(parseClampedOffset("5", 0)).toBe(5);
    expect(parseClampedOffset("100", 0)).toBe(100);
    for (const bad of ["abc", "-5", "5junk", " 5", "5.5", "+5", "Infinity"]) {
      expect(parseClampedOffset(bad, 0)).toBe(0);
    }
    // old offset: -10→0 correctly but via Math.max not strict; 5junk→5 leak
    expect(oldParseDocumentsOffset("-10")).toBe(0);
    expect(oldParseDocumentsOffset("5junk")).toBe(5);
    expect(parseClampedOffset("5junk", 0)).toBe(0);
  });

  test("my-agents page: fallback 1 strict, allows 1..10000", () => {
    expect(parseClampedLimit(null, 1, 10_000)).toBe(1);
    expect(parseClampedLimit("1", 1, 10_000)).toBe(1);
    expect(parseClampedLimit("5", 1, 10_000)).toBe(5);
    expect(parseClampedLimit("0", 1, 10_000)).toBe(1);
    for (const bad of ["abc", "-1", "5junk", "5.5", "Infinity", ""]) {
      expect(parseClampedLimit(bad, 1, 10_000)).toBe(1);
    }
    expect(Number.isNaN(oldParseMyAgentsPage("abc"))).toBe(true);
    expect(parseClampedLimit("abc", 1, 10_000)).toBe(1);
    expect(oldParseMyAgentsPage("5junk")).toBe(5);
    expect(parseClampedLimit("5junk", 1, 10_000)).toBe(1);
    // derived offset must not be NaN
    const page = parseClampedLimit("abc", 1, 10_000);
    const limit = parseClampedLimit("abc", 30, 1000);
    const offset = (page - 1) * limit;
    expect(offset).toBe(0);
    expect(Number.isNaN(offset)).toBe(false);
  });

  test("my-agents limit: fallback 30 max 1000 strict", () => {
    expect(parseClampedLimit(null, 30, 1000)).toBe(30);
    expect(parseClampedLimit("30", 30, 1000)).toBe(30);
    expect(parseClampedLimit("500", 30, 1000)).toBe(500);
    expect(parseClampedLimit("2000", 30, 1000)).toBe(1000);
    for (const bad of ["abc", "0", "-5", "5junk", "Infinity"]) {
      expect(parseClampedLimit(bad, 30, 1000)).toBe(30);
    }
    expect(Number.isNaN(oldParseMyAgentsLimit("abc"))).toBe(true);
    expect(oldParseMyAgentsLimit("5junk")).toBe(5);
    expect(parseClampedLimit("5junk", 30, 1000)).toBe(30);
  });

  test("sabotage: totalPages never NaN, offset never NaN", () => {
    for (const raw of ["abc", "5junk", "-10", "Infinity", "0"]) {
      const pageOld = oldParseMyAgentsPage(raw);
      const limitOld = oldParseMyAgentsLimit(raw);
      const offsetOld =
        Number.isNaN(pageOld) || Number.isNaN(limitOld) ? NaN : (pageOld - 1) * limitOld;
      // old leaks NaN for abc
      if (raw === "abc") expect(Number.isNaN(offsetOld)).toBe(true);
      const pageNew = parseClampedLimit(raw, 1, 10_000);
      const limitNew = parseClampedLimit(raw, 30, 1000);
      const offsetNew = (pageNew - 1) * limitNew;
      expect(Number.isNaN(offsetNew)).toBe(false);
      expect(Number.isNaN(pageNew)).toBe(false);
      expect(Number.isNaN(limitNew)).toBe(false);
    }
    for (const raw of ["abc", "5junk", "-10"]) {
      const limitNew = parseClampedLimit(raw, 100, 200);
      const offsetNew = parseClampedOffset(raw, 0);
      expect(Number.isNaN(limitNew)).toBe(false);
      expect(Number.isNaN(offsetNew)).toBe(false);
    }
  });
});
