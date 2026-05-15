/**
 * GET /api/v1/x/dms/digest
 * Returns a digest of recent X DMs for the authenticated org. Query:
 *   - maxResults: positive integer (optional)
 *   - connectionRole: "owner" | "agent" (default "owner")
 */

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
    const connectionRole = c.req.query("connectionRole") === "agent" ? "agent" : "owner";
    const maxResults =
      rawMaxResults && rawMaxResults.trim().length > 0
        ? Number.parseInt(rawMaxResults, 10)
        : undefined;

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
