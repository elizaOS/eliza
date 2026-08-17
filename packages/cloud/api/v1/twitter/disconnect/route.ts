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
    // Role identity leftover after x/status (#20945) / x/feed (#21130).
    // The prior ternary mapped every non-"agent" token — including AGENT,
    // owner-typos, and 1e2 — onto the personal owner Twitter disconnect.
    // Missing/empty still defaults to owner. Garbage 400s before
    // removeCredentials and OAuth invalidation.
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
