/** Runs bounded generic subscription recovery and signed outbox delivery through the shared cron scheduler. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { appBillingNotifications } from "@elizaos/cloud-shared/lib/services/app-billing-notifications";
import { appBillingReconciliation } from "@elizaos/cloud-shared/lib/services/app-billing-reconciliation";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const intake = await appBillingReconciliation.recoverIntake(5);
    const commands = await appBillingReconciliation.recoverCommands(5);
    const subscriptions = await appBillingReconciliation.recoverPeriodic(5);
    const notifications = await appBillingNotifications.drain(5);
    return c.json({
      success: true,
      intake,
      commands,
      subscriptions,
      notifications,
    });
  } catch (error) {
    // error-policy:J1 The scheduler sees a failed run when recovery storage or configuration is unavailable.
    return failureResponse(c, error);
  }
});
export default app;
