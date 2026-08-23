/**
 * GET /api/v1/x/feed
 * Returns the X feed for the authenticated org. Query: feedType, query,
 * maxResults, connectionRole.
 */

import { parseCanonicalInteger } from "@elizaos/shared";
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
    const parsedMaxResults = parseCanonicalInteger(rawMaxResults, { min: 1 });
    if (parsedMaxResults === "invalid") {
      return c.json(
        { success: false, error: "maxResults must be a positive integer" },
        400,
      );
    }
    const maxResults = parsedMaxResults;
    // Role identity leftover after x/status (#20945). The prior ternary
    // mapped every non-"agent" token — including AGENT, owner-typos, and
    // 1e2 — onto the personal owner X feed. Missing/empty still defaults
    // to owner (this route's documented default). Garbage 400s before
    // getXFeed. maxResults parser stays strict via parseCanonicalInteger.
    const requestedRoleValues = c.req.queries("connectionRole") ?? [];
    const requestedRole = requestedRoleValues[0];
    if (
      requestedRoleValues.length > 1 ||
      (requestedRole !== undefined &&
        requestedRole !== "" &&
        requestedRole !== "agent" &&
        requestedRole !== "owner")
    ) {
      return c.json(
        {
          error: "invalid_connection_role",
          message:
            'connectionRole must be specified at most once as "agent" or "owner".',
        },
        400,
      );
    }
    const connectionRole = requestedRole === "agent" ? "agent" : "owner";

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
