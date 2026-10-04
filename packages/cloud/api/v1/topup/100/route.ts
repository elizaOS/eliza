/**
 * POST /api/v1/topup/100 — x402 crypto topup of $100.
 *
 * Missing X-PAYMENT returns a 402 x402 quote. A valid payment is settled and
 * credited through the organization credit ledger.
 */

import {
  getIpKey,
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { createTopupHandler } from "@elizaos/cloud-shared/lib/services/topup-handler";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

const topup = createTopupHandler({
  amount: 100,
  getSourceId: (walletAddress, paymentId) =>
    `${walletAddress.toLowerCase()}:100:${paymentId}`,
});

// Money route: per-IP, fail-closed rate limit so a top-up flood is bounded
// even during a Redis blip (M11).
app.use(
  moneyRateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
  }),
);

app.post("/", (c) => topup(c.req.raw, c.env));

export default app;
