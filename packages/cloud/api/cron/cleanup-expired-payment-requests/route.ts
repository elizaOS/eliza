/** Expires canonical payment requests whose checkout deadline has elapsed. */
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { getPaymentRequestsService } from "@/lib/services/payment-requests-default";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);
    const expiredIds = await getPaymentRequestsService(c.env).expirePast();
    return c.json({ success: true, expiredCount: expiredIds.length });
  } catch (error) {
    // error-policy:J1 cron route boundary converts failure into a non-2xx response.
    logger.error("[PaymentRequests] expiry cron failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
