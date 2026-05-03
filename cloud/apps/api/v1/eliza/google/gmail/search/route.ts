/**
 * GET /api/v1/eliza/google/gmail/search
 *
 * Searches Gmail by query (e.g. "from:foo subject:bar") via the managed
 * Google connector. Results are capped at `maxResults` (default 12).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  fetchManagedGoogleGmailSearch,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const grantId = c.req.query("grantId")?.trim();
    const rawQuery = c.req.query("query") ?? null;
    const rawMaxResults = c.req.query("maxResults") ?? null;

    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    const query = rawQuery?.trim() ?? "";
    if (query.length === 0) {
      return c.json({ error: "query is required." }, 400);
    }
    const maxResults =
      rawMaxResults && rawMaxResults.trim().length > 0 ? Number.parseInt(rawMaxResults, 10) : 12;
    if (!Number.isFinite(maxResults) || maxResults <= 0) {
      return c.json({ error: "maxResults must be a positive integer." }, 400);
    }

    const result = await fetchManagedGoogleGmailSearch({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId: grantId && grantId.length > 0 ? grantId : undefined,
      query,
      maxResults,
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
