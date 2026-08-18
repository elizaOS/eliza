// Handles v1 cloud API v1 twitter disconnect route traffic with route-local auth expectations.
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
    const role = requestedRole === "agent" ? "agent" : ("owner" as const);

    await twitterAutomationService.removeCredentials(
      user.organization_id,
      user.id,
      role,
    );

    await invalidateOAuthState(user.organization_id, "twitter", user.id);

    return c.json({ success: true, connectionRole: role });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
