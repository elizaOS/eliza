import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const role = c.req.query("connectionRole") === "agent" ? "agent" : ("owner" as const);
    const connectionId = `twitter:${user.organization_id}:${role}`;

    if (!twitterAutomationService.isConfigured()) {
      return c.json({
        configured: false,
        connected: false,
        connectionRole: role,
        connectionId: null,
      });
    }

    const status = await twitterAutomationService.getConnectionStatus(user.organization_id, role);

    return c.json({
      configured: true,
      connectionRole: role,
      connectionId: status.connected ? connectionId : null,
      ...status,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
