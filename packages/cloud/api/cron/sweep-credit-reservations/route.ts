import type { Context } from "hono";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

/**
 * Backstop for synchronous credit reservations (#11169): settle reservation
 * debits whose post-response waitUntil reconciliation never ran.
 */
async function handleSweepCreditReservations(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    const stats = await creditsService.sweepStaleReservations();
    logger.info("[Credits] stale reservation sweep complete", stats);
    return c.json({ success: true, stats });
  } catch (error) {
    logger.error("[Credits] stale reservation sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepCreditReservations);

export default app;
