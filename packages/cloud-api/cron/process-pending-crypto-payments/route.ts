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

import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { directWalletPaymentsService } from "@/lib/services/direct-wallet-payments";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) => c.json({ ok: true, route: "process-pending-crypto-payments" }));

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const stats = await directWalletPaymentsService.processBroadcastBatch(c.env);
    return c.json({ success: true, ...stats });
  } catch (error) {
    logger.error("[Cron process-pending-crypto-payments] failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
