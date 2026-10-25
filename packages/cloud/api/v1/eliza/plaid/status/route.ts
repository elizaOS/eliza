/**
 * GET /api/v1/eliza/plaid/status
 *
 * Reports whether the Plaid connector is configured (env / secrets present)
 * for this deployment.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentPlaidConnectorError,
  isPlaidConfigured,
} from "@elizaos/cloud-shared/lib/services/agent-plaid-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
