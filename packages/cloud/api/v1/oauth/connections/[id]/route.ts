// Handles v1 cloud API v1 oauth connections id route traffic with route-local auth expectations.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * GET /api/v1/oauth/connections/:id - Get a specific OAuth connection
 * DELETE /api/v1/oauth/connections/:id - Revoke a connection
 */

import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import {
  Errors,
  internalErrorResponse,
  OAuthError,
  oauthService,
} from "@elizaos/cloud-shared/lib/services/oauth";
import { invalidateOAuthState } from "@elizaos/cloud-shared/lib/services/oauth/invalidation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";

async function getAccessibleConnection(
  organizationId: string,
  userId: string,
  connectionId: string,
) {
  const connection = await oauthService.getConnection({
    organizationId,
    connectionId,
  });
  if (!connection) return null;
  if (connection.userId && connection.userId !== userId) return null;
  return connection;
}

async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;

  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    organizationId = user.organization_id;

    logger.debug("[API] GET /api/v1/oauth/connections/:id", {
      organizationId,
      connectionId,
    });

    const connection = await getAccessibleConnection(
      organizationId,
      user.id,
      connectionId,
    );

    if (!connection) {
      const error = Errors.connectionNotFound(connectionId);
      return Response.json(error.toResponse(), { status: 404 });
    }

    return Response.json({
      connection: {
        ...connection,
        linkedAt: connection.linkedAt.toISOString(),
        lastUsedAt: connection.lastUsedAt?.toISOString(),
      },
    });
  } catch (error) {
    logger.error("[API] GET /api/v1/oauth/connections/:id error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }

    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), {
        status: error.httpStatus,
      });
    }

    return Response.json(internalErrorResponse("Failed to get connection"), {
      status: 500,
    });
  }
}

async function __hono_DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;
  let userId: string | undefined;

  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    organizationId = user.organization_id;
    userId = user.id;

    logger.info("[API] DELETE /api/v1/oauth/connections/:id", {
      organizationId,
      connectionId,
    });

    const connection = await getAccessibleConnection(
      organizationId,
      userId,
      connectionId,
    );
    if (!connection) {
      const error = Errors.connectionNotFound(connectionId);
      return Response.json(error.toResponse(), { status: 404 });
    }

    await oauthService.revokeConnection({
      organizationId,
      connectionId: connection.id,
    });

    await invalidateOAuthState(organizationId, "oauth", userId, {
      skipVersionBump: true,
    });

    return Response.json({ success: true });
  } catch (error) {
    logger.error("[API] DELETE /api/v1/oauth/connections/:id error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }

    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), {
        status: error.httpStatus,
      });
    }

    return Response.json(internalErrorResponse("Failed to revoke connection"), {
      status: 500,
    });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
