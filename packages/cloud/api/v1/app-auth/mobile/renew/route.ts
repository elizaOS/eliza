/**
 * POST /api/v1/app-auth/mobile/renew
 *
 * Lets a first-party phone replace its own credential without a browser. The
 * caller presents its acknowledged, unexpired `eliza_mobile_` key in
 * `Authorization: Bearer`, in `X-API-Key`, or in both when they are the same
 * key, and a fresh PKCE binding for its own client. The answer is an authorization code of the
 * same shape the sign-in approval returns; the phone then exchanges and
 * acknowledges it on the existing token and ack routes and revokes the old
 * key with DELETE /api/v1/api-keys/current, naming the new key's credential
 * id in X-Renewed-Credential-Id so the request is not taken for a sign-out.
 *
 * Refusals use the canonical Cloud API error shape:
 *   401 authentication_required  key invalid or expired, two different keys sent,
 *                                client disabled or re-registered, or the key already has
 *                                an acknowledged successor (which ends the whole sign-in)
 *   403 access_denied            owner inactive, or the key left the owner's organization
 *   409 renewal_window_closed    the sign-in is older than the absolute cap, or the key
 *                                already lives until that cap
 *   429 rate_limit_exceeded
 *   503 service_unavailable      retryable
 */

import { readPresentedApiKey } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  failureResponse,
  ValidationError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { RateLimitDependencies } from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  authorizeMobileAppAuthRenewal,
  issueMobileAppAuthRenewalCode,
  MobileAppAuthProtocolError,
  MobileAppAuthRenewalError,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  canonicalRateLimitResponse,
  MOBILE_APP_AUTH_RENEW_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
  mobileAppAuthRenewCredentialRateLimit,
  runMobileAppAuthGrantAdmission,
} from "../_rate-limit";
import { mobileAppAuthPkceBindingSchema } from "../_schemas";

export interface MobileAppAuthRenewRouteDependencies {
  rateLimit?: RateLimitDependencies;
  now?: () => Date;
}

/**
 * The one credential this request presents, under the rule every route that
 * acts on the presented key shares (DELETE /api/v1/api-keys/current included):
 * either header, or both when they carry the same key.
 */
function readPresentedCredential(c: AppContext): string | null {
  const presented = readPresentedApiKey(c);
  return presented === "conflict" ? null : presented;
}

function renewalFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof MobileAppAuthRenewalError) {
    switch (error.refusal) {
      case "credential_invalid":
      case "client_unavailable":
        return AuthenticationError("Invalid or expired mobile credential");
      case "owner_ineligible":
        return ForbiddenError(
          "This credential can no longer act for its organization",
        );
      case "renewal_window_closed":
        return new ApiError(
          409,
          "renewal_window_closed",
          "This sign-in can no longer be renewed. Sign in again.",
        );
    }
  }
  if (
    error instanceof MobileAppAuthProtocolError &&
    error.protocolCode !== "server_configuration_error"
  ) {
    return ValidationError("Invalid mobile renewal request");
  }
  // error-policy:J1 anything else is a dependency or configuration outage the
  // phone may retry; it must never read as a revoked credential.
  logger.error("[MobileAppAuth] Renewal dependency failure", {
    error: error instanceof Error ? error.message : String(error),
  });
  return new ApiError(
    503,
    "service_unavailable",
    "Mobile credential renewal is temporarily unavailable",
    { retryAfterSeconds: 30 },
  );
}

export function createMobileAppAuthRenewRoute(
  dependencies: MobileAppAuthRenewRouteDependencies = {},
) {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    mobileAppAuthRateLimitMiddleware(
      MOBILE_APP_AUTH_RENEW_RATE_LIMIT,
      dependencies.rateLimit,
      canonicalRateLimitResponse,
    ),
  );

  app.post("/", async (c) => {
    try {
      const now = dependencies.now?.() ?? new Date();
      const secret = readPresentedCredential(c);
      if (!secret) {
        throw AuthenticationError("A mobile credential is required");
      }
      const authorization = await authorizeMobileAppAuthRenewal({
        env: c.env,
        secret,
        now,
      });
      c.set("authMethod", "api_key");
      c.set("apiKeyId", authorization.credentialId);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // error-policy:J3 Invalid JSON is an explicit caller error, not a dependency outage.
        throw ValidationError("Invalid mobile renewal request");
      }
      const parsed = mobileAppAuthPkceBindingSchema.safeParse(body);
      if (!parsed.success) {
        throw ValidationError("Invalid mobile renewal request");
      }

      return await runMobileAppAuthGrantAdmission(
        c,
        authorization.userId,
        async () => {
          const authCode = await issueMobileAppAuthRenewalCode({
            authorization,
            binding: parsed.data,
            now,
          });
          logger.info("[MobileAppAuth] Renewal code issued", {
            credentialId: authorization.credentialId,
            userId: authorization.userId,
          });
          return c.json({
            success: true,
            code: authCode.code,
            codeType: "mobile_app_auth_code",
            expiresAt: authCode.expiresAt,
            expiresIn: authCode.expiresIn,
          });
        },
        dependencies.rateLimit,
        {
          leading: [
            mobileAppAuthRenewCredentialRateLimit(authorization.credentialId),
          ],
          adaptResponse: canonicalRateLimitResponse,
        },
      );
    } catch (error) {
      // error-policy:J1 HTTP boundary returns the canonical renewal refusal.
      return failureResponse(c, renewalFailure(error));
    }
  });
  return app;
}

export default createMobileAppAuthRenewRoute();
