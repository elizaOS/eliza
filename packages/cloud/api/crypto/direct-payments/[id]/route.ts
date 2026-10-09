/**
 * GET /api/crypto/direct-payments/:id
 *
 * Polling status endpoint for the frontend waiting overlay. Returns the
 * payment's current status, attached tx hash, explorer URL, and any
 * captured failure reason. Frontend polls every ~3s until status is
 * `confirmed` or `failed_chain`.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { directWalletPaymentsService } from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import { logger, redact } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const status = await directWalletPaymentsService.getPaymentStatusForUser({
      paymentId: id,
      userId: user.id,
    });
    if (!status) {
      return c.json({ error: "Payment not found" }, 404);
    }
    return c.json({ success: true, data: status });
  } catch (error) {
    logger.warn("[direct-payments/:id GET] failed", {
      paymentId: redact.paymentId(c.req.param("id") ?? ""),
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
