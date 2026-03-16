/**
 * Generic OAuth Callback Route
 *
 * GET /api/v1/oauth/[platform]/callback
 *
 * Handles OAuth callback from providers that use the generic OAuth system.
 * Exchanges authorization code for tokens and stores the connection.
 *
 * Security:
 * - Rate limited to prevent brute-force attacks
 * - State parameter provides CSRF protection
 * - Redirect URL whitelist prevents open redirect attacks
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { withRateLimit } from "@/lib/middleware/rate-limit";
import {
  getProvider,
  isProviderConfigured,
} from "@/lib/services/oauth/provider-registry";
import { handleOAuth2Callback } from "@/lib/services/oauth/providers";
import { invalidateByOrganization } from "@/lib/eliza/runtime-factory";
import { entitySettingsCache } from "@/lib/services/entity-settings/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Whitelist of allowed redirect paths to prevent open redirect attacks
const ALLOWED_REDIRECT_PATHS = [
  "/dashboard",
  "/dashboard/settings",
  "/dashboard/connections",
  "/dashboard/agents",
  "/settings",
  "/auth/success", // For chat-based OAuth flows (Telegram, iMessage, etc.)
];

interface RouteParams {
  params: Promise<{
    platform: string;
  }>;
}

/**
 * Normalize a path by resolving .. and . segments to prevent path traversal
 */
function normalizePath(path: string): string {
  const segments = path.split("/");
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      result.pop();
    } else if (segment !== "." && segment !== "") {
      result.push(segment);
    }
  }
  return "/" + result.join("/");
}

/**
 * Extract the path portion from a URL string, stripping query strings and fragments
 */
function extractPath(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  let endIndex = url.length;
  if (queryIndex !== -1) endIndex = Math.min(endIndex, queryIndex);
  if (hashIndex !== -1) endIndex = Math.min(endIndex, hashIndex);
  return url.substring(0, endIndex);
}

/**
 * Validate that a redirect URL is safe (same origin and allowed path)
 */
function isValidRedirectUrl(url: string, baseUrl: string): boolean {
  if (!url.startsWith("http")) {
    const rawPath = url.startsWith("/") ? url : `/${url}`;
    const pathOnly = extractPath(rawPath);
    const normalizedPath = normalizePath(pathOnly);
    return ALLOWED_REDIRECT_PATHS.includes(normalizedPath);
  }

  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) {
      return false;
    }
    return ALLOWED_REDIRECT_PATHS.includes(parsed.pathname);
  } catch {
    return false;
  }
}

function appendParam(url: string, param: string): string {
  return url.includes("?") ? `${url}&${param}` : `${url}?${param}`;
}

async function handleCallback(
  request: NextRequest,
  context?: { params: Promise<{ platform: string }> },
): Promise<NextResponse> {
  if (!context?.params) {
    return NextResponse.json(
      { error: "Missing route parameters" },
      { status: 400 },
    );
  }
  const { platform } = await context.params;
  const platformLower = platform.toLowerCase();
  const searchParams = request.nextUrl.searchParams;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
  const defaultRedirect = `${baseUrl}/dashboard/settings?tab=connections`;

  // Get provider configuration
  const provider = getProvider(platformLower);

  if (!provider) {
    logger.error(`[OAuth ${platform}] Unknown platform in callback`);
    return NextResponse.redirect(
      appendParam(defaultRedirect, `oauth_error=unknown_platform`),
    );
  }

  // Check if provider uses generic routes
  if (!provider.useGenericRoutes) {
    logger.error(`[OAuth ${platform}] Callback received for legacy provider`);
    return NextResponse.redirect(
      appendParam(defaultRedirect, `oauth_error=legacy_provider`),
    );
  }

  // Check if provider is configured
  if (!isProviderConfigured(provider)) {
    logger.error(`[OAuth ${platform}] Provider not configured in callback`);
    return NextResponse.redirect(
      appendParam(defaultRedirect, `oauth_error=not_configured`),
    );
  }

  // Handle OAuth errors from provider
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  if (error) {
    logger.warn(`[OAuth ${platform}] Authorization denied by user`, {
      error,
      errorDescription,
    });
    const errorParam = errorDescription
      ? `${platform}_error=${encodeURIComponent(error)}&${platform}_error_description=${encodeURIComponent(errorDescription)}`
      : `${platform}_error=${encodeURIComponent(error)}`;
    return NextResponse.redirect(appendParam(defaultRedirect, errorParam));
  }

  // Get required parameters
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    logger.error(`[OAuth ${platform}] Missing code or state in callback`);
    return NextResponse.redirect(
      appendParam(defaultRedirect, `${platform}_error=missing_params`),
    );
  }

  logger.info(`[OAuth ${platform}] Processing callback`, {
    hasCode: !!code,
    hasState: !!state,
  });

  try {
    const result = await handleOAuth2Callback(provider, code, state);

    // Validate redirect URL
    let redirectUrl = result.redirectUrl || "/dashboard/settings?tab=connections";

    if (!isValidRedirectUrl(redirectUrl, baseUrl)) {
      logger.error(
        `[OAuth ${platform}] SECURITY: Invalid redirect URL attempted`,
        {
          redirectUrl,
          organizationId: result.organizationId,
          ip:
            request.headers.get("x-forwarded-for") ||
            request.headers.get("x-real-ip") ||
            "unknown",
        },
      );
      redirectUrl = "/dashboard/settings?tab=connections";
    }

    const finalRedirectUrl = redirectUrl.startsWith("http")
      ? redirectUrl
      : `${baseUrl}${redirectUrl.startsWith("/") ? "" : "/"}${redirectUrl}`;

    // Add success parameters
    const successParams = `${platform}_connected=true&platform=${platform}&connection_id=${result.connectionId}`;
    const finalUrl = appendParam(finalRedirectUrl, successParams);

    try {
      await Promise.all([
        invalidateByOrganization(result.organizationId),
        entitySettingsCache.invalidateUser(result.userId),
      ]);
    } catch (e) {
      logger.warn(`[OAuth ${platform}] Cache invalidation failed`, { error: String(e) });
    }

    logger.info(`[OAuth ${platform}] Callback successful`, {
      organizationId: result.organizationId,
      userId: result.userId,
      connectionId: result.connectionId,
      platformUserId: result.platformUserId,
    });

    return NextResponse.redirect(finalUrl);
  } catch (error) {
    logger.error(`[OAuth ${platform}] Callback processing failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage =
      error instanceof Error
        ? encodeURIComponent(error.message)
        : "callback_failed";
    return NextResponse.redirect(
      appendParam(defaultRedirect, `${platform}_error=${errorMessage}`),
    );
  }
}

/**
 * Get IP address from request for rate limiting
 */
function getIpKey(request: NextRequest): string {
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return `oauth:generic:callback:ip:${ip}`;
}

// Export with rate limiting: 10 requests per minute per IP
export const GET = withRateLimit(handleCallback, {
  windowMs: 60000, // 1 minute
  maxRequests: 10,
  keyGenerator: getIpKey,
});
