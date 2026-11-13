/** Prepare the current account's inference caches without dispatch or billing. */
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { publishInferenceAdmissionSnapshotToGate } from "@elizaos/cloud-shared/lib/services/inference-admission-snapshot";
import { getCachedMergedModelCatalog } from "@elizaos/cloud-shared/lib/services/model-catalog";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { requireGenerativeRouteCaller } from "../../../src/lib/generative-route-auth";

const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  try {
    if (!/^Bearer\s+\S+$/i.test(c.req.header("authorization") ?? "")) {
      return c.json({ error: "API key required" }, 401);
    }
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength)
            return c.json(
              { error: "Warmup does not accept a request body" },
              400,
            );
        }
      } finally {
        await reader.cancel();
      }
    }
    let executionCtx:
      | { waitUntil(promise: Promise<unknown>): void }
      | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      // error-policy:J4 local hosts await this separate advisory request.
    }
    const caller = await requireGenerativeRouteCaller(c, {});
    const orgId = caller.user.organization_id;
    const admission = caller.admissionSnapshot;
    // Cost: one foreground-triggered request per credential per minute. Reuse
    // the authenticated snapshot, cached catalog and existing coalesced gate
    // calls. No model request, quota lease, credit reservation or polling loop.
    const warm = Promise.allSettled([
      admission
        ? publishInferenceAdmissionSnapshotToGate(orgId, admission)
        : Promise.resolve(),
      getCachedMergedModelCatalog(),
    ]).then((results) => {
      // error-policy:J7 independent warmups finish even if another one fails.
      // The next request still performs all canonical admission checks.
      for (const result of results)
        if (result.status === "rejected") {
          logger.debug("[Inference warmup] cache preparation failed", {
            errorName:
              result.reason instanceof Error
                ? result.reason.name
                : "UnknownError",
          });
        }
    });
    if (executionCtx) executionCtx.waitUntil(warm);
    else await warm;
    c.header("Cache-Control", "no-store");
    return c.json({ accepted: true }, 202);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default app;
