/**
 * GET /api/v1/x/feed
 * Returns the X feed for the authenticated org. Query: feedType, query,
 * maxResults, connectionRole.
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getXFeed } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../error-response";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawMaxResults = c.req.query("maxResults");
    const maxResults =
      rawMaxResults && rawMaxResults.trim().length > 0
        ? Number.parseInt(rawMaxResults, 10)
        : undefined;
    const connectionRole = c.req.query("connectionRole") === "agent" ? "agent" : "owner";

    const result = await getXFeed({
      organizationId: user.organization_id,
      connectionRole,
      feedType: c.req.query("feedType") ?? undefined,
      query: c.req.query("query") ?? undefined,
      maxResults,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
