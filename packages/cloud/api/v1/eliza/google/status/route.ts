/**
 * GET /api/v1/eliza/google/status
 *
 * Returns the managed Google connector status for the caller's organization
 * on the given `side` (default `owner`).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  getManagedGoogleConnectorStatus,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const grantId = c.req.query("grantId")?.trim();
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    const status = await getManagedGoogleConnectorStatus({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId: grantId && grantId.length > 0 ? grantId : undefined,
    });
    return c.json(status);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
