// Handles scheduled cloud API cron PII scrub job drain traffic with cron auth expectations.
import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { createPiiScrubItemExecutor } from "@/lib/services/pii-scrub-executor";
import { processPendingPiiScrubJobs } from "@/lib/services/pii-scrub-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Drains pending `pii_scrub` jobs (#14808 CLOUD lane): claims batches with
 * FOR UPDATE SKIP LOCKED, skips items whose tenant-scoped content-hash
 * done-marker already exists, runs the deterministic tier-0 executor on the
 * rest, and writes markers only on success. The serverless leg of the scrub
 * rails — same drain-consumer shape as process-stripe-queue.
 *
 * No escalation handler is registered on the Worker yet (the server compute
 * lanes — Cerebras passthrough / vllm container — are sibling slices of
 * #14808). Items whose candidate spans are not fully covered by tier-0
 * therefore FAIL CLOSED (bounded retries, then a loud failed job) instead of
 * passing un-inspected — the seam's throw-never-fabricate contract.
 */
interface PiiScrubCronDependencies {
  processPendingPiiScrubJobs: typeof processPendingPiiScrubJobs;
}

async function handleProcessPiiScrubJobs(
  c: Context<AppEnv>,
  dependencies: PiiScrubCronDependencies,
) {
  try {
    requireCronSecret(c);
    const stats = await dependencies.processPendingPiiScrubJobs({
      executor: createPiiScrubItemExecutor(),
    });
    logger.info("[PiiScrubCron] pii_scrub drain complete", stats);
    return c.json({ success: true, stats });
  } catch (error) {
    logger.error("[PiiScrubCron] pii_scrub drain failed", { error });
    return failureResponse(c, error);
  }
}

export function createPiiScrubCronRoute(
  overrides: Partial<PiiScrubCronDependencies> = {},
) {
  const dependencies: PiiScrubCronDependencies = {
    processPendingPiiScrubJobs,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.post("/", (c) => handleProcessPiiScrubJobs(c, dependencies));
  return app;
}

export default createPiiScrubCronRoute();
