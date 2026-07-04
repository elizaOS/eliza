// Handles scheduled cloud API cron sweep inference charges route traffic with cron auth expectations.
import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import {
  isOptimisticBillingEnabled,
  sweepStalePendingInferenceCharges,
} from "@/lib/services/inference-billing-fast-path";
import { sweepStalePendingInferenceChargesDb } from "@/lib/services/inference-billing-ledger";
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

    // Sweep BOTH backstops every run, regardless of INFERENCE_BILLING_LEDGER. Each
    // is exactly-once/idempotent and a cheap no-op when its store is empty, so
    // sweeping the currently-inactive backend closes the orphan window where a flag
    // flip (or rollback) between a charge's admit-time and the next sweep would
    // otherwise strand its pending row on the no-longer-selected backend (#9899).
    const [db, kv] = await Promise.all([
      sweepStalePendingInferenceChargesDb(),
      sweepStalePendingInferenceCharges(),
    ]);
    logger.info("[Inference Billing] pending-charge sweep complete", {
      db,
      kv,
    });
    return c.json({ success: true, db, kv });
  } catch (error) {
    logger.error("[Inference Billing] pending-charge sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepInferenceCharges);

export default app;
