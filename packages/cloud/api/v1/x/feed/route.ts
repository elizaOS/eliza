/**
 * GET /api/v1/x/feed
 * Returns the X feed for the authenticated org. Query: feedType, query,
 * maxResults, connectionRole.
 */

import { parsePositiveInteger } from "@elizaos/shared/utils/number-parsing";
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
    const hasMaxResults = Boolean(rawMaxResults?.trim());
    const maxResults = hasMaxResults
      ? parsePositiveInteger(rawMaxResults)
      : undefined;
    if (hasMaxResults && maxResults === undefined) {
      return c.json(
        { success: false, error: "maxResults must be a positive integer" },
        400,
      );
    }
    const connectionRole =
      c.req.query("connectionRole") === "agent" ? "agent" : "owner";

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
