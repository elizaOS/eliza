/**
 * POST /api/v1/eliza/plaid/link-token
 *
 * Creates a Plaid Link token for the caller's organization. The Agent
 * runtime client uses this token to open the Plaid Link UI.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  createPlaidLinkToken,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const result = await createPlaidLinkToken({
      organizationId: user.organization_id,
      userId: user.id,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
