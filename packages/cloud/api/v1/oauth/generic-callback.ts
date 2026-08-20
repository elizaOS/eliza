// Handles v1 cloud API v1 oauth generic callback route traffic with route-local auth expectations.
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import {
  getDefaultPlatformRedirectOrigins,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
} from "@/lib/security/redirect-validation";
import { connectionEnforcementService } from "@/lib/services/eliza-app";
import { invalidateOAuthState } from "@/lib/services/oauth/invalidation";
import {
  getProvider,
  isProviderConfigured,
} from "@/lib/services/oauth/provider-registry";
import { handleOAuth2Callback } from "@/lib/services/oauth/providers";
import {
  clearOAuthSuccessParams,
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
} from "@/lib/services/oauth/success-proof";
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

  const baseUrl =
    getCloudAwareEnv().NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
  const defaultRedirect = `${baseUrl}/cloud/settings?tab=connections`;

  // Get provider configuration
  const provider = getProvider(platformLower);

  if (!provider) {
    logger.error(`[OAuth ${platform}] Unknown platform in callback`);
    return Response.redirect(
      appendParam(defaultRedirect, `oauth_error=unknown_platform`),
    );
  }

  // Check if provider uses generic routes
  if (!provider.useGenericRoutes) {
    logger.error(`[OAuth ${platform}] Callback received for legacy provider`);
    return Response.redirect(
      appendParam(defaultRedirect, `oauth_error=legacy_provider`),
    );
  }

  // Check if provider is configured
  if (!isProviderConfigured(provider)) {
    logger.error(`[OAuth ${platform}] Provider not configured in callback`);
    return Response.redirect(
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
    return Response.redirect(appendParam(defaultRedirect, errorParam));
  }

  // Get required parameters
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    logger.error(`[OAuth ${platform}] Missing code or state in callback`);
    return Response.redirect(
      appendParam(defaultRedirect, `${platform}_error=missing_params`),
    );
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

    const { target: redirectTarget, rejected } = resolveOAuthSuccessRedirectUrl(
      {
        value: result.redirectUrl,
        baseUrl,
        fallbackPath: "/cloud/settings?tab=connections",
        allowedAbsoluteOrigins,
      },
    );

    if (rejected) {
      logger.error(
        `[OAuth ${platform}] SECURITY: Invalid redirect URL attempted`,
        {
          redirectUrl: result.redirectUrl,
          organizationId: result.organizationId,
          ip:
            request.headers.get("x-forwarded-for") ||
            request.headers.get("x-real-ip") ||
            "unknown",
        },
      );
    }

    // Replace only reserved OAuth success markers (known provider `*_connected`,
    // proof/platform/connection_id). Unrelated caller query state such as
    // `socket_connected` is preserved.
    clearOAuthSuccessParams(redirectTarget);
    redirectTarget.searchParams.set(`${platformLower}_connected`, "true");
    redirectTarget.searchParams.set("platform", platformLower);
    redirectTarget.searchParams.set("connection_id", result.connectionId);
    // Proofs are only consumed by `/auth/success`. Do not attach transferable
    // tokens to dashboard/settings or other callback consumers that strip
    // markers but historically leave unknown query keys in history/Referer.
    if (isOAuthSuccessLandingPath(redirectTarget.pathname)) {
      const proof = await mintOAuthSuccessProof({
        platform: platformLower,
        connectionId: result.connectionId,
        organizationId: result.organizationId,
        userId: result.userId,
        capabilityContinuation: result.capabilityContinuation,
      });
      if (proof) {
        redirectTarget.searchParams.set("proof", proof);
      } else {
        // connection_id remains for sessioned ownership; without a mintable
        // ticket the success page cannot claim Connected from a proof alone.
        logger.error(
          `[OAuth ${platform}] success proof secret/ticket unavailable; /auth/success will require a browser session to verify connection_id`,
        );
      }
    }
    const finalUrl = redirectTarget.toString();

    try {
      await Promise.all([
        invalidateOAuthState(
          result.organizationId,
          platformLower,
          result.userId,
        ),
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
      error instanceof Error
        ? encodeURIComponent(error.message)
        : "callback_failed";
    return Response.redirect(
      appendParam(defaultRedirect, `${platform}_error=${errorMessage}`),
    );
  }
}
