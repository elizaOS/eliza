/**
 * POST /api/v1/x402/requests/:id/settle
 * Public settlement endpoint. The x402 payment payload is supplied in
 * X-PAYMENT / PAYMENT-SIGNATURE or as body.paymentPayload.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  X402PaymentRequestError,
  x402PaymentRequestsService,
} from "@/lib/services/x402-payment-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Payment request id is required" }, 400);
    }
    const paymentHeader =
      c.req.header("X-PAYMENT") ?? c.req.header("x-payment") ?? c.req.header("PAYMENT-SIGNATURE");
    const body = paymentHeader ? null : await c.req.json().catch(() => ({}));
    const result = await x402PaymentRequestsService.settle(
      id,
      paymentHeader ?? (body as { paymentPayload?: unknown }).paymentPayload,
    );

    return c.json(
      {
        success: true,
        paymentRequest: result.paymentRequest,
      },
      {
        headers: {
          "PAYMENT-RESPONSE": result.paymentResponse,
          "Payment-Response": result.paymentResponse,
          "Access-Control-Expose-Headers": "PAYMENT-RESPONSE, Payment-Response",
        },
      },
    );
  } catch (error) {
    logger.error("[x402-payment-requests] settle failed", error);
    if (error instanceof X402PaymentRequestError) {
      return Response.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
