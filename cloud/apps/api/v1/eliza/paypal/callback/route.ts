/**
 * POST /api/v1/eliza/paypal/callback
 *
 * Exchanges the PayPal `code` for an access + refresh token, fetches the
 * payer identity, and reports which capabilities (Reporting API vs identity
 * only) the granted scope unlocks. Personal-tier accounts typically only
 * grant identity → the caller should fall back to CSV import.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPaypalConnectorError,
  describePaypalCapability,
  exchangePaypalAuthorizationCode,
  getPaypalIdentity,
  type PaypalIdentity,
} from "@/lib/services/agent-paypal-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  code: z.string().trim().min(1),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "code is required.", details: parsed.error.issues }, 400);
    }
    const exchange = await exchangePaypalAuthorizationCode({ code: parsed.data.code });
    let identity: PaypalIdentity | null = null;
    try {
      identity = await getPaypalIdentity({ accessToken: exchange.accessToken });
    } catch {
      // Identity is optional — the auth itself is what matters.
    }
    const capability = describePaypalCapability(exchange.scope);
    return c.json({
      accessToken: exchange.accessToken,
      refreshToken: exchange.refreshToken,
      expiresIn: exchange.expiresIn,
      scope: exchange.scope,
      capability,
      identity,
    });
  } catch (error) {
    if (error instanceof AgentPaypalConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
