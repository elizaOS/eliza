/**
 * GET /api/v1/oauth/connections
 *
 * List all OAuth connections for the authenticated organization.
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import {
  internalErrorResponse,
  OAuthError,
  oauthService,
} from "@elizaos/cloud-shared/lib/services/oauth";
import { getProvider } from "@elizaos/cloud-shared/lib/services/oauth/provider-registry";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  // OAuth-connection catalog identity, not leftover tax on ad-account
  // platform, promote-assets platform, or X connectionRole. The prior
  // raw `platform` pass-through sent GOOGLE / gmail / foo into
  // getAdapter, which either missed the static map or minted a
  // wrong-cased generic adapter, so operators asking for Google
  // received an empty connection catalog. Missing / empty still means
  // unfiltered. Garbage 400s before listConnections.
  const requestedPlatform = c.req.query("platform");
  const rawConnectionRole = c.req.query("connectionRole");
  const connectionRole =
    rawConnectionRole === "owner" || rawConnectionRole === "agent"
      ? rawConnectionRole
      : undefined;
  let organizationId: string | undefined;
  let platform: string | undefined;

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

    if (requestedPlatform != null && requestedPlatform !== "") {
      const provider = getProvider(requestedPlatform);
      if (!provider || provider.id !== requestedPlatform) {
        return c.json(
          {
            error: "INVALID_PLATFORM",
            message: "platform must be a registered OAuth provider id",
          },
          400,
        );
      }
    }
    platform = requestedPlatform || undefined;
    if ((!platform || platform === "google") && connectionRole !== "agent")
      await requirePrivateOwnerAccess(c, user);

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

    return c.json(
      internalErrorResponse("Failed to list OAuth connections"),
      500,
    );
  }
});

export default app;
