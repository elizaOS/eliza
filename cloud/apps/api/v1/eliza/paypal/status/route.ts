/**
 * GET /api/v1/eliza/paypal/status
 *
 * Reports whether the PayPal connector is configured (env / secrets present)
 * for the caller's organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { isPaypalConfigured } from "@/lib/services/agent-paypal-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    return c.json({ configured: isPaypalConfigured() });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
