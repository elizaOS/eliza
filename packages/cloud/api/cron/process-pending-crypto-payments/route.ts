/**
 * /api/cron/process-pending-crypto-payments
 *
 * Auto-confirms direct crypto payments stuck in `broadcast` — the user's
 * wallet returned a tx hash but the user-driven confirm step never landed
 * (browser closed, network drop, transient confirm failure). The cron polls
 * each broadcast tx on-chain and either confirms it, leaves it pending, or
 * marks it `failed_chain`. Runs every minute.
 *
 * POST is protected by CRON_SECRET; GET is an unauthenticated health probe.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { directWalletPaymentsService } from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({ ok: true, route: "process-pending-crypto-payments" }),
);

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const [stats, sweeps] = await Promise.all([
      directWalletPaymentsService.processBroadcastBatch(c.env),
      directWalletPaymentsService.drainSweepOutbox(c.env),
    ]);
    return c.json({ success: true, ...stats, sweeps });
  } catch (error) {
    // error-policy:J1 cron is the transport boundary for durable crypto
    // verification and sweep recovery and returns retryable failure.
    logger.error("[Cron process-pending-crypto-payments] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
