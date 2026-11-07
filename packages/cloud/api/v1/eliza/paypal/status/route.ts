/**
 * GET /api/v1/eliza/paypal/status
 *
 * Reports whether the PayPal connector is configured (env / secrets present)
 * for the caller's organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isPaypalConfigured } from "@elizaos/cloud-shared/lib/services/agent-paypal-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
