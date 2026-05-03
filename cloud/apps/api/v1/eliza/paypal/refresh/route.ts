/**
 * POST /api/v1/eliza/paypal/refresh
 *
 * Exchanges a PayPal refresh token for a fresh access token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPaypalConnectorError,
  refreshPaypalAccessToken,
} from "@/lib/services/agent-paypal-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  refreshToken: z.string().trim().min(1),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "refreshToken is required.", details: parsed.error.issues }, 400);
    }
    const result = await refreshPaypalAccessToken(parsed.data);
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentPaypalConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
