/** Runs bounded generic subscription recovery and signed outbox delivery through the shared cron scheduler. */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { appBillingNotifications } from "@/lib/services/app-billing-notifications";
import { appBillingReconciliation } from "@/lib/services/app-billing-reconciliation";
import type { AppEnv } from "@/types/cloud-worker-env";

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
