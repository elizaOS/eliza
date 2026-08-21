/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const enqueuePiiScrubBatch = mock(async () => ({
  id: "job-1",
  status: "queued",
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/pii-scrub-jobs", () => ({
  PII_SCRUB_MAX_CONTENT_BYTES: 10_000,
  PII_SCRUB_MAX_ITEMS_PER_JOB: 10,
  PII_SCRUB_MAX_RULESET_VERSION_LENGTH: 64,
  PiiScrubJobDataError: class PiiScrubJobDataError extends Error {},
  enqueuePiiScrubBatch,
  toPiiScrubJobDto: (job: unknown) => job,
}));

const { default: app } = await import("./route");

describe("POST /api/v1/pii-scrub/jobs malformed JSON", () => {
  test("returns 400 instead of 500 and never enqueues a job", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(enqueuePiiScrubBatch).not.toHaveBeenCalled();
  });

  test("canonical JSON still enqueues a job", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rulesetVersion: "v1",
        items: [{ itemRef: "item-1", content: "hello" }],
      }),
    });
    expect(response.status).toBe(202);
    expect(enqueuePiiScrubBatch).toHaveBeenCalled();
  });
});
