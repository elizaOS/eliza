// Handles v1 cloud API PII scrub job status traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  getPiiScrubJobForOrg,
  toPiiScrubJobDto,
} from "@/lib/services/pii-scrub-jobs";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

const jobIdSchema = z.string().uuid();

/**
 * Tenant-scoped progress read for a `pii_scrub` job (#14808 CLOUD lane): the
 * row advances pending → in_progress → completed/failed with per-item counts
 * in `progress`. A job belonging to another org reads as 404 — never leaked.
 */
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const jobId = jobIdSchema.parse(c.req.param("id"));
    const job = await getPiiScrubJobForOrg(jobId, user.organization_id);
    if (!job) return jsonError(c, 404, "Job not found", "resource_not_found");
    return c.json({ success: true, job: toPiiScrubJobDto(job) });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
