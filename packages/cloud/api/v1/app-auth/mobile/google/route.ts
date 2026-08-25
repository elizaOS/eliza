/**
 * Exchanges a Google Credential Manager ID token for the existing first-party
 * mobile authorization code. Steward remains the identity authority; Cloud
 * only binds its verified session to the native PKCE grant.
 */
import { Hono } from "hono";
import { appsRepository } from "@/db/repositories/apps";
import {
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import {
  issueMobileAppAuthCode,
  MobileAppAuthProtocolError,
  validateMobileAppAuthPkceBinding,
} from "@/lib/services/mobile-app-auth";
import {
  consumeMobileGoogleAuthNonce,
  type MobileGoogleAuthReadiness,
  resolveMobileGoogleAuthReadiness,
} from "@/lib/services/mobile-google-auth";
import { signStewardMutatingRequest } from "@/lib/steward/sign";
import { syncUserFromSteward } from "@/lib/steward-sync";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT,
  mobileAppAuthRateLimitMiddleware,
  runMobileAppAuthGrantAdmission,
} from "../_rate-limit";
import { requireRegisteredMobileApp } from "../_registration";
import { mobileAppAuthErrorResponse } from "../_response";
import { mobileAppAuthGoogleSchema } from "../_schemas";

type StewardLoginResponse = { ok?: boolean; token?: string; error?: string };

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload)
    throw new MobileAppAuthProtocolError(
      "invalid_request",
      "Google returned an invalid identity token",
    );
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    // error-policy:J3 untrusted JWT syntax becomes explicit invalid input.
    throw new MobileAppAuthProtocolError(
      "invalid_request",
      "Google returned an invalid identity token",
    );
  }
}

async function exchangeGoogleToken(
  readiness: MobileGoogleAuthReadiness,
  googleIdToken: string,
): Promise<string> {
  const { stewardEndpoint, stewardRequestSigningSecret, tenantId } = readiness;
  const body = JSON.stringify({
    tenantId,
    token: googleIdToken,
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "x-steward-tenant": tenantId,
  });
  await signStewardMutatingRequest(
    stewardRequestSigningSecret,
    "POST",
    `${stewardEndpoint.pathname}${stewardEndpoint.search}`,
    headers,
    new TextEncoder().encode(body),
  );
  const response = await fetch(stewardEndpoint, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
  });
  if (
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new Error(
      `Steward native Google dependency returned ${response.status}`,
    );
  }
  if (response.status >= 400) {
    throw new MobileAppAuthProtocolError(
      "invalid_request",
      "Google sign-in could not be completed",
    );
  }
  let result: StewardLoginResponse;
  try {
    result = (await response.json()) as StewardLoginResponse;
  } catch (error) {
    // error-policy:J2 upstream response parsing adds dependency context and rethrows.
    throw new Error("Steward native Google dependency returned invalid JSON", {
      cause: error,
    });
  }
  if (!response.ok || result.ok !== true || typeof result.token !== "string") {
    throw new Error(
      "Steward native Google dependency returned an invalid contract",
    );
  }
  return result.token;
}

const app = new Hono<AppEnv>();
app.use(
  "*",
  mobileAppAuthRateLimitMiddleware(MOBILE_APP_AUTH_TOKEN_RATE_LIMIT),
);

app.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // error-policy:J3 malformed native payload is explicit invalid input.
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid Google sign-in request",
      );
    }
    const parsed = mobileAppAuthGoogleSchema.safeParse(body);
    if (!parsed.success)
      throw new MobileAppAuthProtocolError(
        "invalid_request",
        "Invalid Google sign-in request",
      );
    const { app: appRecord, registration } =
      await requireRegisteredMobileApp(c);
    validateMobileAppAuthPkceBinding(registration, parsed.data);
    const readiness = resolveMobileGoogleAuthReadiness(c.env);
    if (!readiness) {
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Native Google sign-in is not configured",
      );
    }
    if (
      decodeJwtPayload(parsed.data.googleIdToken).nonce !== parsed.data.nonce
    ) {
      throw new MobileAppAuthProtocolError(
        "binding_mismatch",
        "Google sign-in nonce did not match",
      );
    }
    const stewardToken = await exchangeGoogleToken(
      readiness,
      parsed.data.googleIdToken,
    );
    const claims = await verifyStewardTokenCached(c.env, stewardToken);
    if (!claims) {
      throw new Error(
        "Steward native Google dependency returned an unverifiable session",
      );
    }
    if (
      !(await consumeMobileGoogleAuthNonce(
        c.env,
        parsed.data,
        parsed.data.nonce,
      ))
    ) {
      throw new MobileAppAuthProtocolError(
        "binding_mismatch",
        "Google sign-in challenge was missing, expired, or already used",
      );
    }

    const cloudUser = await syncUserFromSteward({
      stewardUserId: claims.userId,
      email: claims.email,
      walletAddress: claims.walletAddress ?? claims.address,
      walletChainType: claims.walletChain,
    });
    if (!cloudUser.organization_id)
      throw new MobileAppAuthProtocolError(
        "server_configuration_error",
        "Eliza Cloud account has no organization",
      );
    const organizationId = cloudUser.organization_id;

    return await runMobileAppAuthGrantAdmission(c, cloudUser.id, async () => {
      await appsRepository.connectUser({
        appId: appRecord.id,
        userId: cloudUser.id,
        signupSource: "google-native",
        ipAddress: c.req.header("x-forwarded-for")?.split(",")[0] ?? null,
        userAgent: c.req.header("user-agent") ?? null,
      });
      const code = await issueMobileAppAuthCode({
        registration,
        userId: cloudUser.id,
        organizationId,
        binding: parsed.data,
      });
      return c.json({
        success: true,
        codeType: "mobile_app_auth_code",
        ...code,
      });
    });
  } catch (error) {
    // error-policy:J1 HTTP boundary returns the stable mobile protocol contract.
    return mobileAppAuthErrorResponse(c, error, "google");
  }
});

export default app;
