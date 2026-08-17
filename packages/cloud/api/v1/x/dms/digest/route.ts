/**
 * GET /api/v1/x/dms/digest
 * Returns a digest of recent X DMs for the authenticated org. Query:
 *   - maxResults: positive integer (optional)
 *   - connectionRole: "owner" | "agent" (default "owner")
 */

import { parsePositiveInteger } from "@elizaos/shared/utils/number-parsing";
import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getXDmDigest } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../../error-response";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawMaxResults = c.req.query("maxResults");
    // Role identity leftover after x/feed (#21130) / x/status (#20945).
    // The prior ternary mapped every non-"agent" token — including AGENT,
    // owner-typos, and 1e2 — onto the personal owner X DM digest.
    // Missing/empty still defaults to owner (this route's documented
    // default). Garbage 400s before getXDmDigest. maxResults parser
    // stays untouched.
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

    const result = await getXDmDigest({
      organizationId: user.organization_id,
      connectionRole,
      maxResults,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
