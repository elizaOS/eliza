/**
 * Native Google sign-in for first-party mobile apps, in one Cloud call.
 *
 *   GET  /api/v1/app-auth/mobile/google   public config: Cloud's Google web
 *        client id (the `serverClientId` for `requestOfflineAccess`) and the
 *        connector scopes to request.
 *   POST /api/v1/app-auth/mobile/google   body:
 *     { clientId, environment, redirectUri, state, codeVerifier, deviceName?,
 *       steward: { clientId, challengeId, idToken, codeVerifier },
 *       serverAuthCode? }
 *
 * Before the POST the app asks Steward for a challenge
 * (`/steward/auth/oauth/google/native/challenge`), gets an id_token with that
 * nonce from Credential Manager and, for Gmail and Calendar, a
 * `serverAuthCode` from `Identity.getAuthorizationClient().authorize(...)`
 * with `requestOfflineAccess(<serverClientId>, true)`.
 *
 * Cloud then, in order: verifies the identity with Steward (which consumes the
 * challenge and the id_token once), creates or finds the Cloud user and
 * organization, records the app connection, issues and exchanges a mobile
 * App Auth grant (the same grant lineage, TTL and inactive-until-acknowledged
 * key as `/app-auth/connect` + `/mobile/token`), stores the Google connector
 * connection when the code belongs to the same Google account, and revokes the
 * temporary Steward session. The app stores the returned secret and calls the
 * existing `POST /api/v1/app-auth/mobile/ack` with `{clientId, environment,
 * redirectUri, code, state, codeVerifier, credentialId, secret}` before
 * `acknowledgeBy`.
 *
 * A failed Google exchange never fails the sign-in: `google.connected` is false
 * with a code, and the app can retry with `/api/v1/eliza/google/connect/native`
 * once the key is acknowledged.
 */

import { appsRepository } from "@elizaos/cloud-shared/db/repositories/apps";
import { requirePrivateOwnerCredential } from "@elizaos/cloud-shared/lib/auth/private-owner-credential";
import {
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS,
  verifyStewardTokenCached,
} from "@elizaos/cloud-shared/lib/auth/steward-client";
import { getCloudAwareEnv } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { connectionEnforcementService } from "@elizaos/cloud-shared/lib/services/eliza-app";
import {
  deriveMobileAppAuthS256Challenge,
  exchangeMobileAppAuthCode,
  issueMobileAppAuthCode,
  MobileAppAuthProtocolError,
  validateMobileAppAuthPkceBinding,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import { invalidateOAuthState } from "@elizaos/cloud-shared/lib/services/oauth/invalidation";
import {
  getProvider,
  isProviderConfigured,
  resolveRequestedScopes,
} from "@elizaos/cloud-shared/lib/services/oauth/provider-registry";
import { exchangeGoogleServerAuthCode } from "@elizaos/cloud-shared/lib/services/oauth/providers";
import {
  signStewardClientIp,
  signStewardMutatingRequest,
} from "@elizaos/cloud-shared/lib/steward/sign";
import {
  describeSyncError,
  syncUserFromSteward,
} from "@elizaos/cloud-shared/lib/steward-sync";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { resolveStewardBaseUrl } from "@/api-app/steward/base-url";
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
  runMobileAppAuthGrantAdmission,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthClientBindingSchema } from "../_schemas";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const GOOGLE_CLIENT_ID =
  /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

export const mobileGoogleSignInSchema = mobileAppAuthClientBindingSchema
  .extend({
    state: z.string().min(1).max(256),
    codeVerifier: z.string().min(43).max(128),
    deviceName: z.string().trim().min(1).max(80).optional(),
    steward: z
      .object({
        clientId: z.string().min(1).max(200),
        challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        idToken: z.string().min(20).max(8192),
        codeVerifier: z.string().min(43).max(128),
      })
      .strict(),
    serverAuthCode: z
      .string()
      .min(10)
      .max(2048)
      .regex(/^[A-Za-z0-9/_.~-]+$/)
      .optional(),
  })
  .strict();
export type MobileGoogleSignInRequest = z.infer<
  typeof mobileGoogleSignInSchema
>;

export type StewardNativeVerifyResult =
  | {
      kind: "ok";
      token: string;
      refreshToken?: string;
    }
  | { kind: "mfa"; mfa: Record<string, unknown> }
  | { kind: "rejected"; status: number }
  | { kind: "unavailable" };

/** The Google `sub` of an id_token Steward has just verified (signature checked there). */
export function idTokenSubject(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { sub?: unknown };
    return typeof json.sub === "string" && /^[0-9]{1,64}$/.test(json.sub)
      ? json.sub
      : null;
  } catch {
    // error-policy:J4 an unreadable payload binds no Google account.
    return null;
  }
}

async function signedStewardPost(
  c: AppContext,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const base = resolveStewardBaseUrl(c.env);
  if (!base) return null;
  const url = new URL(`${base}${path}`);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders,
  });
  const tenant = c.env.STEWARD_TENANT_ID?.trim();
  if (tenant) headers.set("X-Steward-Tenant", tenant);
  const text = JSON.stringify(body);
  const secret = c.env.STEWARD_REQUEST_SIGNING_SECRET;
  if (secret)
    await signStewardMutatingRequest(
      secret,
      "POST",
      `${url.pathname}${url.search}`,
      headers,
      new TextEncoder().encode(text),
    );
  // Steward rate-limits native sign-in per client IP: bind the edge address,
  // or every phone would share the Worker's egress bucket.
  await signStewardClientIp(
    secret ?? null,
    "POST",
    `${url.pathname}${url.search}`,
    headers,
    c.req.header("cf-connecting-ip")?.trim(),
  );
  return fetch(url.toString(), {
    method: "POST",
    headers,
    body: text,
    signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
  });
}

export interface MobileGoogleSignInDependencies {
  stewardVerify(
    c: AppContext,
    steward: MobileGoogleSignInRequest["steward"],
  ): Promise<StewardNativeVerifyResult>;
  stewardLogout(
    c: AppContext,
    token: string,
    refreshToken?: string,
  ): Promise<void>;
  verifyToken: typeof verifyStewardTokenCached;
  syncUser: typeof syncUserFromSteward;
  connectUser: typeof appsRepository.connectUser;
  issueCode: typeof issueMobileAppAuthCode;
  exchangeCode: typeof exchangeMobileAppAuthCode;
  requireOwner: typeof requirePrivateOwnerCredential;
  exchangeGoogle: typeof exchangeGoogleServerAuthCode;
  googleProvider(): ReturnType<typeof getProvider>;
  invalidate(organizationId: string, userId: string): Promise<void>;
  admitGrant: typeof runMobileAppAuthGrantAdmission;
}

export const defaultMobileGoogleSignInDependencies: MobileGoogleSignInDependencies =
  {
    async stewardVerify(c, steward) {
      let response: Response | null;
      try {
        response = await signedStewardPost(
          c,
          "/auth/oauth/google/native/verify",
          {
            tenantId: c.env.STEWARD_TENANT_ID?.trim() || undefined,
            clientId: steward.clientId,
            challengeId: steward.challengeId,
            idToken: steward.idToken,
            codeVerifier: steward.codeVerifier,
          },
        );
      } catch (error) {
        // error-policy:J1 a Steward transport failure is an upstream outage.
        logger.warn("[mobile-google] Steward verify transport failure", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return { kind: "unavailable" };
      }
      if (!response) return { kind: "unavailable" };
      const json = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const data =
        json && typeof json.data === "object" && json.data && !("token" in json)
          ? (json.data as Record<string, unknown>)
          : json;
      if (!response.ok || !data || data.ok === false)
        return response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "rejected", status: response.status };
      if (data.mfaRequired === true && data.mfa && typeof data.mfa === "object")
        return { kind: "mfa", mfa: data.mfa as Record<string, unknown> };
      if (typeof data.token !== "string" || !data.token)
        return { kind: "unavailable" };
      return {
        kind: "ok",
        token: data.token,
        ...(typeof data.refreshToken === "string"
          ? { refreshToken: data.refreshToken }
          : {}),
      };
    },
    async stewardLogout(c, token, refreshToken) {
      try {
        const response = await signedStewardPost(
          c,
          "/auth/logout",
          refreshToken ? { refreshToken } : {},
          { Authorization: `Bearer ${token}` },
        );
        await response?.body?.cancel();
      } catch {
        // error-policy:J4 the temporary session expires on its own (15 minutes).
        logger.warn("[mobile-google] Steward session revocation failed");
      }
    },
    verifyToken: verifyStewardTokenCached,
    syncUser: syncUserFromSteward,
    connectUser: (input) => appsRepository.connectUser(input),
    issueCode: issueMobileAppAuthCode,
    exchangeCode: exchangeMobileAppAuthCode,
    requireOwner: requirePrivateOwnerCredential,
    exchangeGoogle: exchangeGoogleServerAuthCode,
    googleProvider: () => getProvider("google"),
    async invalidate(organizationId, userId) {
      await Promise.all([
        invalidateOAuthState(organizationId, "google", userId),
        connectionEnforcementService.invalidateRequiredConnectionCache(
          organizationId,
          userId,
        ),
      ]);
    },
    admitGrant: runMobileAppAuthGrantAdmission,
  };

type GoogleOutcome =
  | {
      connected: true;
      connectionId: string;
      email: string | null;
      scopes: string[];
      refreshTokenIssued: boolean;
    }
  | { connected: false; code: string };

async function connectGoogle(
  c: AppContext,
  deps: MobileGoogleSignInDependencies,
  input: {
    userId: string;
    organizationId: string;
    serverAuthCode: string;
    googleSubject: string | null;
  },
): Promise<GoogleOutcome> {
  const provider = deps.googleProvider();
  if (!provider || !isProviderConfigured(provider))
    return { connected: false, code: "google_not_configured" };
  if (!input.googleSubject)
    return { connected: false, code: "google_account_unknown" };
  try {
    // An invited member must not attach their mail to an organization they do not own.
    await deps.requireOwner({
      userId: input.userId,
      organizationId: input.organizationId,
      authMethod: "session",
      env: c.env,
    });
  } catch {
    // error-policy:J4 a non-owner signs in without the owner-only Google connection.
    return { connected: false, code: "owner_required" };
  }
  try {
    const result = await deps.exchangeGoogle(provider, {
      organizationId: input.organizationId,
      userId: input.userId,
      serverAuthCode: input.serverAuthCode,
      expectedPlatformUserId: input.googleSubject,
    });
    try {
      await deps.invalidate(input.organizationId, input.userId);
    } catch (error) {
      logger.warn("[mobile-google] Cache invalidation failed", {
        error: String(error),
      });
    }
    return {
      connected: true,
      connectionId: result.connectionId,
      email: result.email ?? null,
      scopes: result.scopes,
      refreshTokenIssued: result.refreshTokenIssued,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = /^Token exchange failed: (\d{3})$/.exec(message)?.[1];
    // error-policy:J4 the sign-in stands; the app retries the connection later.
    return {
      connected: false,
      code:
        message === "GOOGLE_SERVER_AUTH_CODE_ACCOUNT_MISMATCH"
          ? "google_account_mismatch"
          : message === "GOOGLE_GRANTED_SCOPES_REQUIRED"
            ? "google_scopes_missing"
            : status && Number(status) < 500
              ? "google_code_rejected"
              : "google_unavailable",
    };
  }
}

export function createMobileGoogleSignInRoute(
  deps: MobileGoogleSignInDependencies = defaultMobileGoogleSignInDependencies,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_TOKEN_RATE_LIMIT),
  );

  app.get("/", (c) => {
    const provider = deps.googleProvider();
    const serverClientId = getCloudAwareEnv().GOOGLE_CLIENT_ID;
    if (
      !provider ||
      !isProviderConfigured(provider) ||
      typeof serverClientId !== "string" ||
      !GOOGLE_CLIENT_ID.test(serverClientId)
    )
      return c.json(
        { configured: false, code: "google_not_configured" },
        503,
        NO_STORE,
      );
    return c.json(
      {
        configured: true,
        serverClientId,
        scopes: resolveRequestedScopes(provider),
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  });

  app.post("/", async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        // error-policy:J3 Invalid JSON is an explicit caller error.
        throw new MobileAppAuthProtocolError(
          "invalid_request",
          "Invalid mobile Google sign-in request",
        );
      }
      const parsed = mobileGoogleSignInSchema.safeParse(body);
      if (!parsed.success)
        throw new MobileAppAuthProtocolError(
          "invalid_request",
          "Invalid mobile Google sign-in request",
        );
      const input = parsed.data;
      const { registration } = await requireRegisteredMobileApp(
        c,
        input.clientId,
      );
      const binding = {
        clientId: input.clientId,
        environment: input.environment,
        redirectUri: input.redirectUri,
        state: input.state,
        codeChallenge: deriveMobileAppAuthS256Challenge(input.codeVerifier),
        codeChallengeMethod: "S256",
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      };
      validateMobileAppAuthPkceBinding(registration, binding);
      if (!c.env.STEWARD_SESSION_SECRET && !c.env.STEWARD_JWT_SECRET)
        return c.json(
          {
            success: false,
            error: "server_configuration_error",
            errorDescription: "Steward verification is not configured.",
            retryable: false,
          },
          503,
          NO_STORE,
        );

      const verified = await deps.stewardVerify(c, input.steward);
      if (verified.kind === "unavailable")
        return c.json(
          {
            success: false,
            error: "temporarily_unavailable",
            errorDescription: "Sign-in is unavailable. Try again.",
            retryable: true,
          },
          502,
          NO_STORE,
        );
      if (verified.kind === "rejected")
        return c.json(
          {
            success: false,
            error: "google_identity_rejected",
            errorDescription:
              "Google sign-in could not be verified. Start again.",
            retryable: false,
          },
          verified.status === 429 ? 429 : 401,
          NO_STORE,
        );
      if (verified.kind === "mfa")
        // The second factor completes through Steward's MFA routes, then the
        // usual `/app-auth/connect`; the Google code is not used.
        return c.json(
          { success: true, status: "mfa_required", mfa: verified.mfa },
          200,
          NO_STORE,
        );

      try {
        const claims = await deps.verifyToken(c.env, verified.token);
        if (!claims)
          return c.json(
            {
              success: false,
              error: "google_identity_rejected",
              errorDescription: "The Cloud session could not be verified.",
              retryable: false,
            },
            401,
            NO_STORE,
          );
        let user: Awaited<ReturnType<typeof syncUserFromSteward>>;
        try {
          user = await deps.syncUser({
            stewardUserId: claims.userId,
            email: claims.email,
            walletAddress: claims.walletAddress ?? claims.address,
            walletChainType: claims.walletChain,
          });
        } catch (error) {
          logger.error(
            `[mobile-google] Steward user sync failed (stewardUserId=${claims.userId}): ${describeSyncError(error)}`,
          );
          return c.json(
            {
              success: false,
              error: "temporarily_unavailable",
              errorDescription:
                "Your account could not be prepared. Try again.",
              retryable: true,
            },
            500,
            NO_STORE,
          );
        }
        const organizationId = user.organization_id;
        if (!organizationId)
          throw new MobileAppAuthProtocolError(
            "server_configuration_error",
            "The signed-in account has no organization",
          );
        return await deps.admitGrant(c, user.id, async () => {
          await deps.connectUser({
            appId: registration.appId,
            userId: user.id,
            signupSource: "oauth",
            ipAddress: c.req.header("cf-connecting-ip") ?? null,
            userAgent: c.req.header("user-agent") ?? null,
          });
          const authCode = await deps.issueCode({
            registration,
            userId: user.id,
            organizationId,
            binding,
          });
          const credential = await deps.exchangeCode({
            registration,
            binding: {
              clientId: input.clientId,
              environment: input.environment,
              redirectUri: input.redirectUri,
              state: input.state,
            },
            code: authCode.code,
            codeVerifier: input.codeVerifier,
          });
          const google = input.serverAuthCode
            ? await connectGoogle(c, deps, {
                userId: user.id,
                organizationId,
                serverAuthCode: input.serverAuthCode,
                googleSubject: idTokenSubject(input.steward.idToken),
              })
            : undefined;
          return c.json(
            {
              success: true,
              status: "signed_in",
              ...credential,
              code: authCode.code,
              accountCreated: user.accountCreated === true,
              ...(google ? { google } : {}),
            },
            200,
            NO_STORE,
          );
        });
      } finally {
        // Cloud keeps only the mobile key; the temporary Steward session ends here.
        await deps.stewardLogout(c, verified.token, verified.refreshToken);
      }
    } catch (error) {
      // error-policy:J1 HTTP boundary returns the stable mobile protocol error contract.
      return mobileAppAuthErrorResponse(c, error, "token");
    }
  });
  return app;
}

const route: Hono<AppEnv> = createMobileGoogleSignInRoute();
export default route;
