import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import {
  isOptimisticBillingEnabled,
  sweepStalePendingInferenceCharges,
} from "@/lib/services/inference-billing-fast-path";
import {
  resolveInferenceBillingLedger,
  sweepStalePendingInferenceChargesDb,
} from "@/lib/services/inference-billing-ledger";
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

    // Sweep the backstop the route writes to: the DB ledger drains oldest-first in
    // age-ordered batches (exactly-once via the row claim), the KV backstop scans
    // its pending prefix. Selected by INFERENCE_BILLING_LEDGER (#9899).
    if (resolveInferenceBillingLedger() === "db") {
      const stats = await sweepStalePendingInferenceChargesDb();
      logger.info(
        "[Inference Billing] DB-ledger pending-charge sweep complete",
        stats,
      );
      return c.json({ success: true, backend: "db", ...stats });
    }

    const stats = await sweepStalePendingInferenceCharges();
    logger.info("[Inference Billing] pending-charge sweep complete", stats);
    return c.json({ success: true, backend: "kv", ...stats });
  } catch (error) {
    logger.error("[Inference Billing] pending-charge sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepInferenceCharges);

export default app;
