import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const role = c.req.query("connectionRole") === "agent" ? "agent" : ("owner" as const);

    await twitterAutomationService.removeCredentials(user.organization_id, user.id, role);

    await invalidateOAuthState(user.organization_id, "twitter", user.id);

    return c.json({ success: true, connectionRole: role });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
