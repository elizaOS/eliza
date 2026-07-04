/**
 * POST /api/v1/topup/50 — x402 crypto topup of $50.
 *
 * Missing X-PAYMENT returns a 402 x402 quote. A valid payment is settled and
 * credited through the organization credit ledger.
 */

import { Hono } from "hono";

import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { createTopupHandler } from "@/lib/services/topup-handler";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const topup = createTopupHandler({
  amount: 50,
  getSourceId: (walletAddress, paymentId) =>
    `${walletAddress.toLowerCase()}:50:${paymentId}`,
});

// Money route: per-IP, fail-closed rate limit so a top-up flood is bounded
// even during a Redis blip (M11).
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
  }),
);

app.post("/", (c) => topup(c.req.raw, c.env));

export default app;
