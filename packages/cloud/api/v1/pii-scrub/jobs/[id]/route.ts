// Handles v1 cloud API PII scrub job status traffic with route-local auth expectations.

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  jsonError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  getPiiScrubJobForOrg,
  toPiiScrubJobDto,
} from "@elizaos/cloud-shared/lib/services/pii-scrub-jobs";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const jobIdSchema = z.string().uuid();

/**
 * Tenant-scoped progress read for a `pii_scrub` job (#14808 CLOUD lane): the
 * row advances pending → in_progress → completed/failed with per-item counts
 * in `progress`. A job belonging to another org reads as 404 — never leaked.
 */
interface PiiScrubJobRouteDependencies {
  requireUserOrApiKeyWithOrg: typeof requireUserOrApiKeyWithOrg;
  rateLimit: typeof rateLimit;
  getPiiScrubJobForOrg: typeof getPiiScrubJobForOrg;
}

export function createPiiScrubJobRoute(
  overrides: Partial<PiiScrubJobRouteDependencies> = {},
) {
  const dependencies: PiiScrubJobRouteDependencies = {
    requireUserOrApiKeyWithOrg,
    rateLimit,
    getPiiScrubJobForOrg,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.use("*", dependencies.rateLimit(RateLimitPresets.STANDARD));
  app.get("/", async (c) => {
    try {
      const user = await dependencies.requireUserOrApiKeyWithOrg(c);
      const jobId = jobIdSchema.parse(c.req.param("id"));
      const job = await dependencies.getPiiScrubJobForOrg(
        jobId,
        user.organization_id,
      );
      if (!job) {
        return jsonError(c, 404, "Job not found", "resource_not_found");
      }
      return c.json({ success: true, job: toPiiScrubJobDto(job) });
    } catch (error) {
      return failureResponse(c, error);
    }
  });
  return app;
}

export default createPiiScrubJobRoute();
