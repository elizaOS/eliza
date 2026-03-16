/**
 * GET /api/v1/oauth/connections
 *
 * List all OAuth connections for the authenticated organization.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { oauthService, OAuthError, internalErrorResponse } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get("platform") || undefined;

  logger.debug("[API] GET /api/v1/oauth/connections", {
    organizationId: user.organization_id,
    platform,
  });

  try {
    const connections = await oauthService.listConnections({
      organizationId: user.organization_id,
      platform,
    });

    return NextResponse.json({
      connections: connections.map((conn) => ({
        ...conn,
        linkedAt: conn.linkedAt.toISOString(),
        lastUsedAt: conn.lastUsedAt?.toISOString(),
      })),
    });
  } catch (error) {
    logger.error("[API] GET /api/v1/oauth/connections error", {
      organizationId: user.organization_id,
      platform,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof OAuthError) {
      return NextResponse.json(error.toResponse(), { status: error.httpStatus });
    }

    return NextResponse.json(internalErrorResponse("Failed to list OAuth connections"), { status: 500 });
  }
}
