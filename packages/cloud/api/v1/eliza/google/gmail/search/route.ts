/**
 * GET /api/v1/eliza/google/gmail/search
 *
 * Searches Gmail by query (e.g. "from:foo subject:bar") via the managed
 * Google connector. Results are capped at `maxResults` (default 12).
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  fetchManagedGoogleGmailSearch,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { parseCanonicalInteger } from "@elizaos/core/protocol";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const grantId = c.req.query("grantId")?.trim();
    const rawQuery = c.req.query("query") ?? null;
    const pageToken = c.req.query("pageToken");
    if (
      pageToken !== undefined &&
      (!pageToken.length || pageToken.length > 4096)
    )
      return c.json({ error: "Invalid Gmail page token." }, 400);
    const rawMaxResults = c.req.query("maxResults") ?? null;

    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    const query = rawQuery?.trim() ?? "";
    if (query.length === 0) {
      return c.json({ error: "query is required." }, 400);
    }
    const parsedMaxResults = parseCanonicalInteger(rawMaxResults, { min: 1 });
    if (parsedMaxResults === "invalid") {
      return c.json({ error: "maxResults must be a positive integer." }, 400);
    }
    const maxResults = parsedMaxResults ?? 12;

    const result = await fetchManagedGoogleGmailSearch({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId: grantId && grantId.length > 0 ? grantId : undefined,
      query,
      maxResults,
      pageToken,
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
