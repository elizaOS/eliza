/**
 * POST /api/v1/topup/50 — x402 crypto topup of $50.
 *
 * Missing X-PAYMENT returns a 402 x402 quote. A valid payment is settled and
 * credited through the organization credit ledger.
 */

import { Hono } from "hono";

import { createTopupHandler } from "@/lib/services/topup-handler";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const topup = createTopupHandler({
  amount: 50,
  getSourceId: (walletAddress, paymentId) => `${walletAddress.toLowerCase()}:50:${paymentId}`,
});

app.post("/", (c) => topup(c.req.raw, c.env));

export default app;
