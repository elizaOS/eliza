import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  getDefaultPlatformRedirectOrigins,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
} from "@/lib/security/redirect-validation";
import { connectionEnforcementService } from "@/lib/services/eliza-app";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import { getProvider, isProviderConfigured } from "@/lib/services/oauth/provider-registry";
import { handleOAuth2Callback } from "@/lib/services/oauth/providers";
import { logger } from "@/lib/utils/logger";

function appendParam(url: string, param: string): string {
  return url.includes("?") ? `${url}&${param}` : `${url}?${param}`;
}

export async function handleGenericOAuthCallback(
  request: Request,
  context: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const { platform } = await context.params;
  const platformLower = platform.toLowerCase();
  const searchParams = new URL(request.url).searchParams;

  const baseUrl = getCloudAwareEnv().NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const defaultRedirect = `${baseUrl}/dashboard/settings?tab=connections`;

  // Get provider configuration
  const provider = getProvider(platformLower);

  if (!provider) {
    logger.error(`[OAuth ${platform}] Unknown platform in callback`);
    return Response.redirect(appendParam(defaultRedirect, `oauth_error=unknown_platform`));
  }

  // Check if provider uses generic routes
  if (!provider.useGenericRoutes) {
    logger.error(`[OAuth ${platform}] Callback received for legacy provider`);
    return Response.redirect(appendParam(defaultRedirect, `oauth_error=legacy_provider`));
  }

  // Check if provider is configured
  if (!isProviderConfigured(provider)) {
    logger.error(`[OAuth ${platform}] Provider not configured in callback`);
    return Response.redirect(appendParam(defaultRedirect, `oauth_error=not_configured`));
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
    return Response.redirect(appendParam(defaultRedirect, errorParam));
  }

  // Get required parameters
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    logger.error(`[OAuth ${platform}] Missing code or state in callback`);
    return Response.redirect(appendParam(defaultRedirect, `${platform}_error=missing_params`));
  }

  logger.info(`[OAuth ${platform}] Processing callback`, {
    hasCode: !!code,
    hasState: !!state,
  });

  try {
    const result = await handleOAuth2Callback(provider, code, state);

    const allowedAbsoluteOrigins = [
      ...getDefaultPlatformRedirectOrigins(),
      ...LOOPBACK_REDIRECT_ORIGINS,
    ];

    const { target: redirectTarget, rejected } = resolveOAuthSuccessRedirectUrl({
      value: result.redirectUrl,
      baseUrl,
      fallbackPath: "/dashboard/settings?tab=connections",
      allowedAbsoluteOrigins,
    });

    if (rejected) {
      logger.error(`[OAuth ${platform}] SECURITY: Invalid redirect URL attempted`, {
        redirectUrl: result.redirectUrl,
        organizationId: result.organizationId,
        ip: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown",
      });
    }

    // Add success parameters
    const successParams = `${platform}_connected=true&platform=${platform}&connection_id=${result.connectionId}`;
    const finalUrl = appendParam(redirectTarget.toString(), successParams);

    try {
      await Promise.all([
        invalidateOAuthState(result.organizationId, platformLower, result.userId),
        connectionEnforcementService.invalidateRequiredConnectionCache(
          result.organizationId,
          result.userId,
        ),
      ]);
    } catch (e) {
      logger.warn(`[OAuth ${platform}] Cache invalidation failed`, {
        error: String(e),
      });
    }

    logger.info(`[OAuth ${platform}] Callback successful`, {
      organizationId: result.organizationId,
      userId: result.userId,
      connectionId: result.connectionId,
      platformUserId: result.platformUserId,
    });

    return Response.redirect(finalUrl);
  } catch (error) {
    logger.error(`[OAuth ${platform}] Callback processing failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage =
      error instanceof Error ? encodeURIComponent(error.message) : "callback_failed";
    return Response.redirect(appendParam(defaultRedirect, `${platform}_error=${errorMessage}`));
  }
}
