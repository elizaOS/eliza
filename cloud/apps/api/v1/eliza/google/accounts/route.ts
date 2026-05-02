/**
 * GET /api/v1/eliza/google/accounts
 *
 * Lists managed Google connector accounts for the caller's organization.
 * `side` query param scopes the result to either `owner` or `agent` accounts.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  listManagedGoogleConnectorAccounts,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    const accounts = await listManagedGoogleConnectorAccounts({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "owner" || rawSide === "agent" ? rawSide : undefined,
    });
    return c.json(accounts);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
