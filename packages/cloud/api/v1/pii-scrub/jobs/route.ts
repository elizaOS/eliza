/** Handles v1 cloud API PII scrub job enqueue traffic with route-local auth expectations. */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  jsonError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { resolveCloudPiiScrubEscalationHandler } from "@elizaos/cloud-shared/lib/services/pii-scrub-executor";
import {
  enqueuePiiScrubBatch,
  PII_SCRUB_INSPECTION_SCOPES,
  PII_SCRUB_MAX_CONTENT_BYTES,
  PII_SCRUB_MAX_ITEMS_PER_JOB,
  PII_SCRUB_MAX_RULESET_VERSION_LENGTH,
  PiiScrubJobDataError,
  toPiiScrubJobDto,
} from "@elizaos/cloud-shared/lib/services/pii-scrub-jobs";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const enqueueSchema = z.object({
  rulesetVersion: z.string().min(1).max(PII_SCRUB_MAX_RULESET_VERSION_LENGTH),
  stage: z.string().min(1).max(64).optional(),
  inspectionScope: z.enum(PII_SCRUB_INSPECTION_SCOPES).optional(),
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
  /** True when the drain can inspect full content (server discovery). */
  serverDiscoveryAvailable: () => boolean;
}

export function createPiiScrubJobsRoute(
  overrides: Partial<PiiScrubJobsRouteDependencies> = {},
) {
  const dependencies: PiiScrubJobsRouteDependencies = {
    requireUserOrApiKeyWithOrg,
    rateLimit,
    enqueuePiiScrubBatch,
    serverDiscoveryAvailable: () =>
      resolveCloudPiiScrubEscalationHandler() !== undefined,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.use("*", dependencies.rateLimit(RateLimitPresets.STANDARD));
  app.post("/", async (c) => {
    try {
      const user = await dependencies.requireUserOrApiKeyWithOrg(c);
      const decodedRawBody = await decodeRequestJson(c.req);
      if (!decodedRawBody.ok) {
        // error-policy:J3 malformed JSON is invalid request input.
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      const rawBody = decodedRawBody.value;
      const body = enqueueSchema.parse(rawBody);
      if (
        body.inspectionScope === "server_discovery" &&
        !dependencies.serverDiscoveryAvailable()
      ) {
        // Fail closed at the front door: without a discovery handler the
        // drain could only quarantine these items after burning retries.
        return jsonError(
          c,
          422,
          "server_discovery inspection is not available on this deployment",
          "validation_error",
          { reason: "pii_scrub_server_discovery_unavailable" },
        );
      }
      const job = await dependencies.enqueuePiiScrubBatch({
        organizationId: user.organization_id,
        userId: user.id,
        rulesetVersion: body.rulesetVersion,
        stage: body.stage,
        inspectionScope: body.inspectionScope,
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
