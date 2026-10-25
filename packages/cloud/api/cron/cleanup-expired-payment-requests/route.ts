/** Expires canonical payment requests whose checkout deadline has elapsed. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { dispatchPaymentCallbacks } from "@elizaos/cloud-shared/lib/services/payment-request-settlement";
import { getPaymentRequestsService } from "@elizaos/cloud-shared/lib/services/payment-requests-default";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

interface PaymentRequestCronDependencies {
  paymentRequests: (
    env: Parameters<typeof getPaymentRequestsService>[0],
  ) => Pick<ReturnType<typeof getPaymentRequestsService>, "expirePast">;
  dispatchCallbacks: typeof dispatchPaymentCallbacks;
}

export function createPaymentRequestCronApp(
  dependencies: PaymentRequestCronDependencies = {
    paymentRequests: getPaymentRequestsService,
    dispatchCallbacks: dispatchPaymentCallbacks,
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    try {
      requireCronSecret(c);
      const expiredIds = await dependencies.paymentRequests(c.env).expirePast();
      const callbacks = await dependencies.dispatchCallbacks({ limit: 50 });
      return c.json({
        success: true,
        expiredCount: expiredIds.length,
        callbacks,
      });
    } catch (error) {
      // error-policy:J1 cron route boundary converts failure into a non-2xx response.
      logger.error("[PaymentRequests] expiry cron failed", { error });
      return failureResponse(c, error);
    }
  });

  return app;
}

const app = createPaymentRequestCronApp();
export default app;
