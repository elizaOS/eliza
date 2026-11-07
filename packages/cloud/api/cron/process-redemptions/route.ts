/**
 * /api/cron/process-redemptions — retired (#23022).
 *
 * This cron executed approved token payouts. Creator payouts are closed and
 * unpaid balances are frozen for manual settlement, so it is no longer
 * scheduled and never broadcasts a transfer. A CRON_SECRET caller gets 410
 * `creator_monetization_retired`; approved or in-flight rows stay untouched
 * for an operator to reconcile.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { CreatorMonetizationRetiredError } from "@elizaos/cloud-shared/lib/services/creator-monetization-retirement";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
