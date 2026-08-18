/**
 * GET /api/v1/eliza/plaid/status
 *
 * Reports whether the Plaid connector is configured (env / secrets present)
 * for this deployment.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  isPlaidConfigured,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    return c.json({ configured: isPlaidConfigured() });
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as 503,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
