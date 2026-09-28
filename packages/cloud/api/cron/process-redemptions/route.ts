/**
 * /api/cron/process-redemptions — retired (#23022).
 *
 * This cron executed approved token payouts. Creator payouts are closed and
 * unpaid balances are frozen for manual settlement, so it is no longer
 * scheduled and never broadcasts a transfer. A CRON_SECRET caller gets 410
 * `creator_monetization_retired`; approved or in-flight rows stay untouched
 * for an operator to reconcile.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { CreatorMonetizationRetiredError } from "@/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    return failureResponse(
      c,
      new CreatorMonetizationRetiredError("payout_processing"),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
