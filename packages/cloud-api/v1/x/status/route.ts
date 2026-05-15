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
    const connectionRole = c.req.query("connectionRole") === "agent" ? "agent" : "owner";
    const status = await getXCloudStatus(user.organization_id, connectionRole);
    return c.json({ success: true, ...status });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
