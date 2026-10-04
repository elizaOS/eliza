/**
 * POST /api/v1/eliza/paypal/authorize
 *
 * Returns the PayPal Login URL the client should redirect the user to.
 * Caller is responsible for round-tripping `state` through the redirect to
 * mitigate CSRF; we just echo whatever was supplied.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentPaypalConnectorError,
  buildPaypalAuthorizeUrl,
} from "@elizaos/cloud-shared/lib/services/agent-paypal-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req.json().catch(() => ({}))) as { state?: string };
    const state = body.state;
    if (!state || state.trim().length === 0) {
      return c.json({ error: "state is required for CSRF protection." }, 400);
    }
    const result = buildPaypalAuthorizeUrl({
      organizationId: user.organization_id,
      userId: user.id,
      state,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentPaypalConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
