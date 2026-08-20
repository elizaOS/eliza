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

import type { Context } from "hono";
import {
  failureResponse,
  ApiError as WorkerApiError,
} from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  getDefaultPlatformRedirectOrigins,
  isAllowedAbsoluteRedirectUrl,
  isSafeRelativeRedirectPath,
  LOOPBACK_REDIRECT_ORIGINS,
} from "@/lib/security/redirect-validation";
import { OAuthError, oauthService } from "@/lib/services/oauth";
import {
  getProvider,
  isProviderConfigured,
} from "@/lib/services/oauth/provider-registry";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface InitiateRequestBody {
  redirectUrl?: string;
  scopes?: string[];
  capabilities?: string[];
  capabilityRequest?: unknown;
  connectionId?: string;
  connectionRole?: "owner" | "agent";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
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

    const redirectUrl =
      body.redirectUrl ||
      (body.capabilityRequest
        ? "/auth/success"
        : "/cloud/settings?tab=connections");
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

    if (body.scopes !== undefined && !isNonEmptyStringArray(body.scopes)) {
      return c.json(
        {
          error: "INVALID_SCOPES",
          message: "scopes must be a non-empty string array",
        },
        400,
      );
    }
    if (
      body.capabilities !== undefined &&
      !isNonEmptyStringArray(body.capabilities)
    ) {
      return c.json(
        {
          error: "INVALID_CAPABILITIES",
          message: "capabilities must be a non-empty string array",
        },
        400,
      );
    }
    if (body.scopes !== undefined && body.capabilities !== undefined) {
      return c.json(
        {
          error: "AMBIGUOUS_OAUTH_REQUEST",
          message: "Request either named capabilities or raw scopes, not both",
        },
        400,
      );
    }
    if (
      body.capabilityRequest !== undefined &&
      body.capabilities === undefined
    ) {
      return c.json(
        {
          error: "INVALID_CAPABILITY_REQUEST",
          message: "capabilityRequest requires named capabilities",
        },
        400,
      );
    }
    if (
      body.connectionId !== undefined &&
      (typeof body.connectionId !== "string" ||
        body.connectionId.trim().length === 0 ||
        !UUID_PATTERN.test(body.connectionId) ||
        body.capabilities === undefined)
    ) {
      return c.json(
        {
          error: "INVALID_CONNECTION_ID",
          message: "connectionId is only valid with named capabilities",
        },
        400,
      );
    }
    const scopes = body.scopes;
    const capabilities = body.capabilities;
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
      scopeCount: scopes?.length,
      capabilityCount: capabilities?.length,
      connectionRole,
    });

    const result = await oauthService.initiateAuth({
      organizationId,
      userId: user.id,
      platform: provider.id,
      redirectUrl,
      scopes,
      capabilities,
      capabilityRequest: body.capabilityRequest,
      connectionId: body.connectionId,
      connectionRole,
    });

    return c.json({
      authUrl: result.authUrl,
      state: result.state,
      provider: {
        id: provider.id,
        name: provider.name,
      },
      capabilityAccess: result.capabilityAccess,
      retryAfterConsent: result.retryAfterConsent ?? false,
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
