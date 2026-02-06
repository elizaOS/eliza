/**
 * GET /api/v1/oauth/token/:platform
 *
 * Get a valid access token by platform name.
 * Uses the most recently used active connection for that platform.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  oauthService,
  OAuthError,
  Errors,
  internalErrorResponse,
  isValidProvider,
} from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { platform } = await params;

  logger.debug("[API] GET /api/v1/oauth/token/:platform", {
    organizationId: user.organization_id,
    platform,
  });

  if (!isValidProvider(platform)) {
    const error = Errors.platformNotSupported(platform);
    return NextResponse.json(error.toResponse(), { status: error.httpStatus });
  }

  try {
    const { token, connectionId } = await oauthService.getValidTokenByPlatformWithConnectionId({
      organizationId: user.organization_id,
      platform,
    });

    return NextResponse.json({
      accessToken: token.accessToken,
      accessTokenSecret: token.accessTokenSecret,
      expiresAt: token.expiresAt?.toISOString(),
      scopes: token.scopes,
      refreshed: token.refreshed,
      fromCache: token.fromCache,
      connectionId,
    });
  } catch (error) {
    logger.error("[API] GET /api/v1/oauth/token/:platform error", {
      organizationId: user.organization_id,
      platform,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof OAuthError) {
      return NextResponse.json(error.toResponse(), { status: error.httpStatus });
    }

    return NextResponse.json(internalErrorResponse(), { status: 500 });
  }
}
