import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * Guardrail for the embeddings rate-limit parity fix: embeddings must stay
 * at RELAXED (200/min) so RAG flows (N embeddings to 1 completion) aren't
 * bottlenecked below /v1/chat/completions.
 */

// Sentinel-checked repo root: fails loud if the relative walk ever becomes
// wrong (e.g. if this file is moved), instead of silently reading the wrong
// route and passing vacuously.
const REPO_ROOT = (() => {
  const candidate = join(import.meta.dir, "..", "..", "..");
  statSync(join(candidate, "package.json"));
  return candidate;
})();

// Mirror getRateLimitMultiplier() from rate-limit.ts so the test pins the
// documented base values regardless of RATE_LIMIT_MULTIPLIER in the env
// (dev/CI can set it to inflate limits; production forces it to 1).
const multiplier = (() => {
  if (process.env.NODE_ENV === "production") return 1;
  const raw = process.env.RATE_LIMIT_MULTIPLIER;
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
})();

describe("Embeddings rate-limit parity", () => {
  test("RELAXED preset is 200 req/min with multiplier", () => {
    expect(RateLimitPresets.RELAXED.windowMs).toBe(60_000);
    expect(RateLimitPresets.RELAXED.maxRequests).toBe(200 * multiplier);
  });

  test("embeddings route is wired to RELAXED", () => {
    const source = readFileSync(join(REPO_ROOT, "apps/api/v1/embeddings/route.ts"), "utf8");
    expect(source).toMatch(
      /app\.use\(\s*["']\*["']\s*,\s*rateLimit\(\s*RateLimitPresets\.RELAXED\s*\)\s*\)/,
    );
  });
});
