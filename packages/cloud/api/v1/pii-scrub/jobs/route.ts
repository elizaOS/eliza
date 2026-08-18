// Handles v1 cloud API PII scrub job enqueue traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  enqueuePiiScrubBatch,
  PII_SCRUB_MAX_CONTENT_BYTES,
  PII_SCRUB_MAX_ITEMS_PER_JOB,
  PII_SCRUB_MAX_RULESET_VERSION_LENGTH,
  PiiScrubJobDataError,
  toPiiScrubJobDto,
} from "@/lib/services/pii-scrub-jobs";
import type { AppEnv } from "@/types/cloud-worker-env";

const enqueueSchema = z.object({
  rulesetVersion: z.string().min(1).max(PII_SCRUB_MAX_RULESET_VERSION_LENGTH),
  stage: z.string().min(1).max(64).optional(),
  items: z
    .array(
      z.object({
        itemRef: z.string().min(1).max(256),
        content: z.string().min(1).max(PII_SCRUB_MAX_CONTENT_BYTES),
        candidateSpans: z.array(z.string().min(1)).max(256).optional(),
        contextPack: z.string().max(PII_SCRUB_MAX_CONTENT_BYTES).optional(),
      }),
    )
    .min(1)
    .max(PII_SCRUB_MAX_ITEMS_PER_JOB),
});

/**
 * Enqueue one CLOUD-lane PII scrub batch (#14808): creates a durable
 * `pii_scrub` job for the caller's org and answers 202 immediately — the
 * scrub never blocks the request. Poll GET /:id for progress. Overlapping or
 * re-submitted batches are free: every already-scrubbed item skips at drain
 * time via its tenant-scoped content-hash done-marker.
 */
interface PiiScrubJobsRouteDependencies {
  requireUserOrApiKeyWithOrg: typeof requireUserOrApiKeyWithOrg;
  rateLimit: typeof rateLimit;
  enqueuePiiScrubBatch: typeof enqueuePiiScrubBatch;
}

export function createPiiScrubJobsRoute(
  overrides: Partial<PiiScrubJobsRouteDependencies> = {},
) {
  const dependencies: PiiScrubJobsRouteDependencies = {
    requireUserOrApiKeyWithOrg,
    rateLimit,
    enqueuePiiScrubBatch,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.use("*", dependencies.rateLimit(RateLimitPresets.STANDARD));
  app.post("/", async (c) => {
    try {
      const user = await dependencies.requireUserOrApiKeyWithOrg(c);
      const body = enqueueSchema.parse(await c.req.json());
      const job = await dependencies.enqueuePiiScrubBatch({
        organizationId: user.organization_id,
        userId: user.id,
        rulesetVersion: body.rulesetVersion,
        stage: body.stage,
        items: body.items,
      });
      return c.json({ success: true, job: toPiiScrubJobDto(job) }, 202);
    } catch (error) {
      if (error instanceof PiiScrubJobDataError) {
        return jsonError(c, 400, error.message, "validation_error");
      }
      return failureResponse(c, error);
    }
  });
  return app;
}

export default createPiiScrubJobsRoute();
