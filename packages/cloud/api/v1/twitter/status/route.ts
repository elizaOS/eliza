// Handles v1 cloud API v1 twitter status route traffic with route-local auth expectations.
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    // Role identity leftover after twitter-disconnect (#21144) / x-status
    // (#20945). The prior ternary mapped every non-"agent" token —
    // including AGENT, owner-typos, and 1e2 — onto the personal owner
    // Twitter status. Missing/empty still defaults to owner. Garbage
    // 400s before getConnectionStatus.
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
    const connectionId = `twitter:${user.organization_id}:${role}`;

    if (!twitterAutomationService.isConfigured()) {
      return c.json({
        configured: false,
        connected: false,
        connectionRole: role,
        connectionId: null,
      });
    }

    const status = await twitterAutomationService.getConnectionStatus(
      user.organization_id,
      role,
    );

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
