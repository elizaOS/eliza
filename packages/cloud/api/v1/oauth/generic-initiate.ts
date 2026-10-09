/**
 * Shared handler for the generic OAuth `initiate` flow.
 *
 * Used by:
 *   - POST /api/v1/oauth/[platform]/initiate
 *   - GET / POST /api/v1/oauth/initiate?provider=...
 *
 * Hono-native: takes the request context directly. The Next-shaped helper at
 * `[platform]/initiate/route.ts` historically held this logic; it's lifted
 * here so both the dynamic-segment route and the legacy `?provider=` wrapper
 * can share it without resorting to fake `params: Promise<...>` shapes.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { ApiError } from "@elizaos/cloud-shared/lib/api/errors";
import {
  getDefaultPlatformRedirectOrigins,
  isAllowedAbsoluteRedirectUrl,
  isSafeRelativeRedirectPath,
  LOOPBACK_REDIRECT_ORIGINS,
} from "@elizaos/cloud-shared/lib/security/redirect-validation";
import { OAuthError } from "@elizaos/cloud-shared/lib/services/oauth";
import {
  getProvider,
  isProviderConfigured,
} from "@elizaos/cloud-shared/lib/services/oauth/provider-registry";
import { initiateOAuth2 } from "@elizaos/cloud-shared/lib/services/oauth/providers";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context } from "hono";

interface InitiateRequestBody {
  redirectUrl?: string;
  scopes?: string[];
  connectionRole?: "owner" | "agent";
}

export async function handleGenericOAuthInitiate(
  c: Context<AppEnv>,
  rawPlatform: string,
): Promise<Response> {
  const platform = rawPlatform;
  const platformLower = platform.toLowerCase();
  let organizationId: string | undefined;

  const provider = getProvider(platformLower);

  if (!provider) {
    return c.json(
      {
        error: "PLATFORM_NOT_SUPPORTED",
        message: `Platform '${platform}' is not supported`,
      },
      400,
    );
  }

  if (!provider.useGenericRoutes) {
    return c.json(
      {
        error: "PLATFORM_HAS_LEGACY_ROUTES",
        message: `Platform '${platform}' uses legacy routes. Use ${provider.routes?.initiate || "the platform-specific endpoint"} instead.`,
      },
      400,
    );
  }

  if (!isProviderConfigured(provider)) {
    logger.error(`[OAuth ${platform}] Provider not configured`, {
      missingEnvVars: provider.envVars.filter((v) => !process.env[v]),
    });
    return c.json(
      {
        error: "PLATFORM_NOT_CONFIGURED",
        message: `${provider.name} OAuth is not configured on this platform`,
      },
      503,
    );
  }

  if (provider.type !== "oauth2") {
    return c.json(
      {
        error: "UNSUPPORTED_AUTH_TYPE",
        message: `Platform '${platform}' uses ${provider.type} authentication which is not supported by generic routes`,
      },
      400,
    );
  }

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    let body: InitiateRequestBody = {};
    try {
      body = (await c.req.json()) as InitiateRequestBody;
    } catch {
      // Empty body is fine — defaults apply.
    }

    const redirectUrl = body.redirectUrl || "/cloud/connectors";
    if (redirectUrl.startsWith("http")) {
      const allowedAbsoluteOrigins = [
        ...getDefaultPlatformRedirectOrigins(),
        ...LOOPBACK_REDIRECT_ORIGINS,
      ];
      if (!isAllowedAbsoluteRedirectUrl(redirectUrl, allowedAbsoluteOrigins)) {
        return c.json(
          {
            error: "INVALID_REDIRECT_URL",
            message: "redirectUrl origin is not allowlisted",
          },
          400,
        );
      }
    } else if (!isSafeRelativeRedirectPath(redirectUrl)) {
      return c.json(
        {
          error: "INVALID_REDIRECT_URL",
          message:
            "redirectUrl must be an absolute URL on an allowlisted origin or a relative path",
        },
        400,
      );
    }

    const scopes = body.scopes || provider.defaultScopes || [];
    const connectionRole =
      body.connectionRole === "owner" || body.connectionRole === "agent"
        ? body.connectionRole
        : undefined;

    if (body.connectionRole && !connectionRole) {
      return c.json(
        {
          error: "INVALID_CONNECTION_ROLE",
          message: "connectionRole must be 'owner' or 'agent'",
        },
        400,
      );
    }

    logger.info(`[OAuth ${platform}] Initiating auth`, {
      organizationId,
      userId: user.id,
      scopeCount: scopes.length,
      connectionRole,
    });

    const result = await initiateOAuth2(provider, {
      organizationId,
      userId: user.id,
      redirectUrl,
      scopes,
      connectionRole,
    });

    return c.json({
      authUrl: result.authUrl,
      state: result.state,
      provider: {
        id: provider.id,
        name: provider.name,
      },
    });
  } catch (error) {
    logger.error(`[OAuth ${platform}] Failed to initiate auth`, {
      organizationId,
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
      {
        error: "INITIATE_FAILED",
        message: "Failed to initiate OAuth flow",
        details: error instanceof Error ? error.message : undefined,
      },
      500,
    );
  }
}
