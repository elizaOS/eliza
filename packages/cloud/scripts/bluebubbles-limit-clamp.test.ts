/**
 * Pins bluebubbles limit clamp batch (2 sites: filteredInboundDeliveries 20/100 and pending-replies/retry 10/50):
 * - bluebubbles-local-bridge.ts:1684 `Number.parseInt(limit ?? "20") + isFinite+min(max)` (5junk→5, 1e4→1, 5.5→5, +5→5, unsafe→100) → strict `rawLimit.trim() + /^\\d+$/ + isSafeInteger + min(MAX)` (fallback 20)
 * - bluebubbles-local-bridge.ts:1855 `Number.parseInt(limit ?? "10")` (5junk→5, 1e4→1, 0→0, -5→-5) → strict `trim + /^\\d+$/ + isSafeInteger + min(50)` (fallback 10, no max overflow)
 * Sibling correct: cloud/shared clamp-limit.ts:8 `parseClampedLimit` (`/^\\d+$/ + isSafeInteger + min(max)`), orgs/route:5, docker-containers:36, gallery batch3, etc.
 */
import { describe, expect, it } from "bun:test";

function oldInboundLimit(raw: string | null): number {
  const MAX = 100;
  const requestedLimit = Number.parseInt(raw ?? "20", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX)
    : 20;
  return limit;
}
function fixedInboundLimit(raw: string | null): number {
  const MAX = 100;
  const rawLimit = (raw ?? "").trim();
  if (!rawLimit) return 20;
  if (!/^\d+$/.test(rawLimit)) return 20;
  const parsed = Number(rawLimit);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX)
    : 20;
}
function oldRetryLimit(raw: string | null): number {
  const limit = Number.parseInt(raw ?? "10", 10);
  return limit;
}
function fixedRetryLimit(raw: string | null): number {
  const rawLimit = (raw ?? "").trim();
  if (!rawLimit) return 10;
  if (!/^\d+$/.test(rawLimit)) return 10;
  const parsed = Number(rawLimit);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

describe("bluebubbles limit clamp batch — 2 sites strict", () => {
  it("inbound: valid 20→20, 50→50, 999→100, missing→20", () => {
    expect(fixedInboundLimit("20")).toBe(20);
    expect(fixedInboundLimit("50")).toBe(50);
    expect(fixedInboundLimit("999")).toBe(100);
    expect(fixedInboundLimit(null)).toBe(20);
    expect(fixedInboundLimit("")).toBe(20);
    expect(fixedInboundLimit(" 20 ")).toBe(20);
  });
  it("inbound: 5junk old 5 vs fixed 20", () => {
    expect(oldInboundLimit("5junk")).toBe(5);
    expect(fixedInboundLimit("5junk")).toBe(20);
  });
  it("inbound: 1e4 old 1 vs fixed 20", () => {
    expect(oldInboundLimit("1e4")).toBe(1);
    expect(fixedInboundLimit("1e4")).toBe(20);
  });
  it("inbound: 5.5 old 5 vs fixed 20, +5 old 5 vs fixed 20, -5 old 1 vs fixed 20, 0 old 1 vs fixed 20", () => {
    expect(oldInboundLimit("5.5")).toBe(5);
    expect(fixedInboundLimit("5.5")).toBe(20);
    expect(oldInboundLimit("+5")).toBe(5);
    expect(fixedInboundLimit("+5")).toBe(20);
    expect(oldInboundLimit("-5")).toBe(1);
    expect(fixedInboundLimit("-5")).toBe(20);
    expect(oldInboundLimit("0")).toBe(1);
    expect(fixedInboundLimit("0")).toBe(20);
  });
  it("inbound: unsafe 9007199254740993 old 100 vs fixed 20", () => {
    expect(oldInboundLimit("9007199254740993")).toBe(100);
    expect(fixedInboundLimit("9007199254740993")).toBe(20);
  });
  it("retry: 5junk old 5 vs fixed 10, 1e4 old 1 vs fixed 10, 0 old 0 vs fixed 10, 999 old 999 vs fixed 50", () => {
    expect(oldRetryLimit("5junk")).toBe(5);
    expect(fixedRetryLimit("5junk")).toBe(10);
    expect(oldRetryLimit("1e4")).toBe(1);
    expect(fixedRetryLimit("1e4")).toBe(10);
    expect(oldRetryLimit("0")).toBe(0);
    expect(fixedRetryLimit("0")).toBe(10);
    expect(oldRetryLimit("999")).toBe(999);
    expect(fixedRetryLimit("999")).toBe(50);
    expect(fixedRetryLimit("10")).toBe(10);
    expect(fixedRetryLimit(null)).toBe(10);
  });
  it("retry: valid 5→5, 50→50, 007→7", () => {
    expect(fixedRetryLimit("5")).toBe(5);
    expect(fixedRetryLimit("50")).toBe(50);
    expect(fixedRetryLimit("007")).toBe(7);
  });
  it("source-inspection: files reserve strict clamp", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const repoRoot = fs.existsSync(
      "packages/cloud/scripts/bluebubbles-local-bridge.ts",
    )
      ? "."
      : fs.existsSync(
            "../../packages/cloud/scripts/bluebubbles-local-bridge.ts",
          )
        ? "../.."
        : "/tmp/eliza-verify2";
    const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");
    const content = read("packages/cloud/scripts/bluebubbles-local-bridge.ts");
    expect(content).toContain("rawLimit");
    expect(content).toContain("/^\\d+$/");
    expect(content).toContain("isSafeInteger");
    expect(content).toContain("MAX_RECENT_INBOUND_DELIVERIES");
    expect(content).not.toContain(
      'Number.parseInt(url.searchParams.get("limit") ?? "10"',
    );
    expect(content).not.toContain(
      'Number.parseInt(\n    url.searchParams.get("limit") ?? "20"',
    );
    // sibling still present
    expect(
      read("packages/cloud/shared/src/lib/utils/clamp-limit.ts"),
    ).toContain("/^\\d+$/");
    expect(read("packages/cloud/api/v1/admin/orgs/route.ts")).toContain(
      "parseClampedLimit",
    );
  });
});
