/**
 * GET /api/v1/oauth/connections
 *
 * List all OAuth connections for the authenticated organization.
 */

import { Hono } from "hono";
import { failureResponse, ApiError as WorkerApiError } from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { internalErrorResponse, OAuthError, oauthService } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const platform = c.req.query("platform") || undefined;
  const rawConnectionRole = c.req.query("connectionRole");
  const connectionRole =
    rawConnectionRole === "owner" || rawConnectionRole === "agent" ? rawConnectionRole : undefined;
  let organizationId: string | undefined;

  if (rawConnectionRole && !connectionRole) {
    return c.json(
      {
        error: "INVALID_CONNECTION_ROLE",
        message: "connectionRole must be 'owner' or 'agent'",
      },
      400,
    );
  }

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    logger.debug("[API] GET /api/v1/oauth/connections", {
      organizationId,
      platform,
      connectionRole,
    });

    const connections = await oauthService.listConnections({
      organizationId,
      userId: user.id,
      platform,
      connectionRole,
    });

    return c.json({
      connections: connections.map((conn) => ({
        ...conn,
        linkedAt: conn.linkedAt.toISOString(),
        lastUsedAt: conn.lastUsedAt?.toISOString(),
      })),
    });
  } catch (error) {
    logger.error("[API] GET /api/v1/oauth/connections error", {
      organizationId,
      platform,
      connectionRole,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof WorkerApiError) {
      return failureResponse(c, error);
    }
    if (error instanceof ApiError) {
      return c.json(error.toJSON(), error.status as 400);
    }
    if (error instanceof OAuthError) {
      return c.json(error.toResponse(), error.httpStatus as 400);
    }

    return c.json(internalErrorResponse("Failed to list OAuth connections"), 500);
  }
});

export default app;
