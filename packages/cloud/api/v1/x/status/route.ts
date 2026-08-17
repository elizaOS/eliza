/**
 * GET /api/v1/x/status
 * Returns the X cloud connection status for the authenticated org. Query:
 * connectionRole ("owner" | "agent", default "owner").
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getXCloudStatus } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../error-response";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    // Role identity, not leftover page-size tax. The prior ternary mapped
    // every non-"agent" token — including AGENT, owner-typos, and 1e2 — onto
    // the personal owner X connection. Missing/empty still defaults to owner
    // (this route's documented default). Garbage 400s before status lookup.
    const requestedRole = c.req.query("connectionRole");
    if (
      requestedRole !== undefined &&
      requestedRole !== "" &&
      requestedRole !== "agent" &&
      requestedRole !== "owner"
    ) {
      return c.json(
        {
          error: "invalid_connection_role",
          message: 'connectionRole must be "agent" or "owner".',
        },
        400,
      );
    }
    const connectionRole = requestedRole === "agent" ? "agent" : "owner";
    const status = await getXCloudStatus(user.organization_id, connectionRole);
    return c.json({ success: true, ...status });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
