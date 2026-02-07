/**
 * GET /api/v1/oauth/connections/:id - Get a specific OAuth connection
 * DELETE /api/v1/oauth/connections/:id - Revoke a connection
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { oauthService, OAuthError, Errors, internalErrorResponse } from "@/lib/services/oauth";
import { invalidateByOrganization } from "@/lib/eliza/runtime-factory";
import { entitySettingsCache } from "@/lib/services/entity-settings/cache";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: connectionId } = await params;

  logger.debug("[API] GET /api/v1/oauth/connections/:id", {
    organizationId: user.organization_id,
    connectionId,
  });

  try {
    const connection = await oauthService.getConnection({
      organizationId: user.organization_id,
      connectionId,
    });

    if (!connection) {
      const error = Errors.connectionNotFound(connectionId);
      return NextResponse.json(error.toResponse(), { status: 404 });
    }

    return NextResponse.json({
      connection: {
        ...connection,
        linkedAt: connection.linkedAt.toISOString(),
        lastUsedAt: connection.lastUsedAt?.toISOString(),
      },
    });
  } catch (error) {
    logger.error("[API] GET /api/v1/oauth/connections/:id error", {
      organizationId: user.organization_id,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof OAuthError) {
      return NextResponse.json(error.toResponse(), { status: error.httpStatus });
    }

    return NextResponse.json(internalErrorResponse("Failed to get connection"), { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: connectionId } = await params;

  logger.info("[API] DELETE /api/v1/oauth/connections/:id", {
    organizationId: user.organization_id,
    connectionId,
  });

  try {
    // Invalidate caches FIRST to prevent race condition where requests could use
    // stale cached OAuth tokens after DB revocation but before cache invalidation
    try {
      await Promise.all([
        invalidateByOrganization(user.organization_id),
        entitySettingsCache.invalidateUser(user.id),
      ]);
    } catch (e) {
      logger.warn("[API] Cache invalidation failed", { error: String(e) });
    }

    // Then revoke the connection in the database
    await oauthService.revokeConnection({
      organizationId: user.organization_id,
      connectionId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[API] DELETE /api/v1/oauth/connections/:id error", {
      organizationId: user.organization_id,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof OAuthError) {
      return NextResponse.json(error.toResponse(), { status: error.httpStatus });
    }

    return NextResponse.json(internalErrorResponse("Failed to revoke connection"), { status: 500 });
  }
}
