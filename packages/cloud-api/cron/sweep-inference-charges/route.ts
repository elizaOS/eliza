import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import {
  isOptimisticBillingEnabled,
  sweepStalePendingInferenceCharges,
} from "@/lib/services/inference-billing-fast-path";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/**
 * Backstop for Tier-2 optimistic inference billing (#9899): settle any durable
 * pending charges whose post-response inline settle never ran (isolate eviction
 * / dropped waitUntil). No-op when optimistic billing is disabled.
 */
async function handleSweepInferenceCharges(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    if (!isOptimisticBillingEnabled()) {
      return c.json({ success: true, skipped: "optimistic_billing_disabled" });
    }

    const stats = await sweepStalePendingInferenceCharges();
    logger.info("[Inference Billing] pending-charge sweep complete", stats);
    return c.json({ success: true, ...stats });
  } catch (error) {
    logger.error("[Inference Billing] pending-charge sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepInferenceCharges);

export default app;
