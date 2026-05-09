/**
 * GET /api/v1/x402/requests/:id
 * Public status check for a durable x402 payment request.
 */

import { Hono } from "hono";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { x402PaymentRequestsService } from "@/lib/services/x402-payment-requests";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  const id = c.req.param("id");
  if (!id) {
    return c.json({ success: false, error: "Payment request id is required" }, 400);
  }
  const paymentRequest = await x402PaymentRequestsService.get(id);
  if (!paymentRequest) {
    return c.json({ success: false, error: "Payment request not found" }, 404);
  }

  return c.json({
    success: true,
    paymentRequest: x402PaymentRequestsService.toView(paymentRequest),
  });
});

export default app;
