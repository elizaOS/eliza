/**
 * Exchanges an existing allowlisted staging API-key identity for a short-lived
 * browser Steward session through a 60-second single-use PKCE code. The route
 * is absent unless all staging gates are explicit, never returns the API key,
 * and performs no user, organization, identity, or tenant provisioning.
 */

import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import {
  isStagingSessionExchangeEnabled,
  isStagingSessionSigningConfigured,
  loadExistingStagingSessionSubjectForMint,
  STAGING_SESSION_MAX_TTL_SECONDS,
  StagingSessionConfigurationError,
  StagingSessionEligibilityError,
  validateStagingSessionBinding,
} from "@/lib/auth/staging-session-binding";
import {
  mintStewardTokenFromClaims,
  type StewardTokenClaims,
  type StewardVerifyEnv,
} from "@/lib/auth/steward-client";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  consumeStagingSessionCode,
  issueStagingSessionCode,
  looksLikeStagingSessionChallenge,
  looksLikeStagingSessionCode,
} from "@/lib/services/staging-session-exchange-codes";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STAGING_API_ORIGIN = ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin;
const STAGING_API_HOST = new URL(STAGING_API_ORIGIN).hostname;
const STAGING_APP_ORIGIN = ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;

function errorBody(
  message: string,
  code: string,
): { error: string; code: string } {
  return { error: message, code };
}

function noStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  };
}

function exactStagingRequestSurface(c: {
  env: AppEnv["Bindings"];
  req: { url: string; header(name: string): string | undefined };
}): boolean {
  if (!isStagingSessionExchangeEnabled(c.env)) return false;
  const url = new URL(c.req.url);
  return (
    url.origin === STAGING_API_ORIGIN &&
    url.host === STAGING_API_HOST &&
    c.req.header("host") === STAGING_API_HOST
  );
}

function exactStagingAppOrigin(c: {
  req: { header(name: string): string | undefined };
}): boolean {
  return c.req.header("origin") === STAGING_APP_ORIGIN;
}

function stewardSignerConfigured(env: StewardVerifyEnv): boolean {
  return isStagingSessionSigningConfigured(env);
}

function readSingleApiKeyCredential(c: {
  req: { header(name: string): string | undefined };
}): string | null {
  const headerKey = c.req.header("x-api-key")?.trim() ?? "";
  const authorization = c.req.header("authorization")?.trim() ?? "";
  const bearerKey = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (bearerKey && !bearerKey.startsWith("eliza_")) return null;
  if ((!headerKey && !bearerKey) || (headerKey && bearerKey)) return null;
  return headerKey || bearerKey;
}

const app = new Hono<AppEnv>();

// This credential-mint surface has no availability fallback: if the shared
// limiter is unavailable, every request receives 503 before identity work.
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
  }),
);

app.post("/mint", async (c) => {
  if (!exactStagingRequestSurface(c)) {
    return c.json(errorBody("Not found", "not_found"), 404, noStoreHeaders());
  }
  if (!exactStagingAppOrigin(c)) {
    return c.json(
      errorBody("Forbidden", "forbidden_origin"),
      403,
      noStoreHeaders(),
    );
  }
  if (!stewardSignerConfigured(c.env)) {
    return c.json(
      errorBody("Staging session signer unavailable", "server_secret_missing"),
      503,
      noStoreHeaders(),
    );
  }
  const presentedApiKey = readSingleApiKeyCredential(c);
  if (!presentedApiKey) {
    return c.json(
      errorBody("API key required", "api_key_required"),
      401,
      noStoreHeaders(),
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    codeChallenge?: unknown;
  };
  const codeChallenge =
    typeof body.codeChallenge === "string" ? body.codeChallenge : undefined;
  if (!looksLikeStagingSessionChallenge(codeChallenge)) {
    return c.json(
      errorBody("Code challenge required", "missing_challenge"),
      400,
      noStoreHeaders(),
    );
  }

  try {
    const authedUser = await requireUserOrApiKeyWithOrg(c);
    const apiKeyId = c.get("apiKeyId");
    if (c.get("authMethod") !== "api_key" || !apiKeyId) {
      return c.json(
        errorBody("API key required", "api_key_required"),
        401,
        noStoreHeaders(),
      );
    }

    const subject = await loadExistingStagingSessionSubjectForMint({
      env: c.env,
      apiKeyId,
      presentedApiKey,
      expectedCloudUserId: authedUser.id,
      expectedOrganizationId: authedUser.organization_id,
    });
    const claims: StewardTokenClaims = {
      userId: subject.stewardUserId,
      ...(subject.email ? { email: subject.email } : {}),
      ...(subject.walletAddress
        ? {
            address: subject.walletAddress,
            walletAddress: subject.walletAddress,
          }
        : {}),
      ...(subject.walletChain ? { walletChain: subject.walletChain } : {}),
      tenantId: subject.tenantId,
      bridged: true,
      stagingSessionBinding: subject.binding,
      issuedAt: subject.issuedAt,
      expiration: subject.expiration,
    };
    const issued = await issueStagingSessionCode({ claims, codeChallenge });
    return c.json(
      { ok: true, code: issued.code, expiresIn: issued.expiresIn },
      200,
      noStoreHeaders(),
    );
  } catch (error) {
    if (error instanceof StagingSessionEligibilityError) {
      return c.json(
        errorBody(
          "Staging session subject is not eligible",
          "subject_not_eligible",
        ),
        403,
        noStoreHeaders(),
      );
    }
    if (error instanceof StagingSessionConfigurationError) {
      logger.error("[staging-session-exchange] configuration unavailable");
      return c.json(
        errorBody(
          "Staging session exchange unavailable",
          "exchange_unavailable",
        ),
        503,
        noStoreHeaders(),
      );
    }
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return c.json(
        error.status === 401
          ? errorBody("API key required or invalid", "invalid_api_key")
          : errorBody(
              "Staging session subject is not eligible",
              "subject_not_eligible",
            ),
        error.status,
        noStoreHeaders(),
      );
    }
    // error-policy:J1 auth/storage failures are translated at the route
    // boundary without logging credentials, codes, tokens, or subject ids.
    logger.error("[staging-session-exchange] mint dependency unavailable");
    return c.json(
      errorBody("Staging session exchange unavailable", "exchange_unavailable"),
      503,
      noStoreHeaders(),
    );
  }
});

app.post("/exchange", async (c) => {
  if (!exactStagingRequestSurface(c)) {
    return c.json(errorBody("Not found", "not_found"), 404, noStoreHeaders());
  }
  if (!exactStagingAppOrigin(c)) {
    return c.json(
      errorBody("Forbidden", "forbidden_origin"),
      403,
      noStoreHeaders(),
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: unknown;
    codeVerifier?: unknown;
  };
  const code = typeof body.code === "string" ? body.code : null;
  if (!looksLikeStagingSessionCode(code)) {
    return c.json(
      errorBody("Code required", "missing_code"),
      400,
      noStoreHeaders(),
    );
  }
  const codeVerifier =
    typeof body.codeVerifier === "string" ? body.codeVerifier : null;

  try {
    // Atomic DELETE ... RETURNING happens before verifier and eligibility
    // checks, so a wrong verifier, revoked source, or malformed binding burns
    // the code and every replay loses.
    const record = await consumeStagingSessionCode(code, codeVerifier);
    if (!record?.claims.stagingSessionBinding) {
      return c.json(
        errorBody("Invalid or expired code", "invalid_code"),
        401,
        noStoreHeaders(),
      );
    }
    // A syntactically valid code is already atomically burned before any
    // dependency/configuration refusal below, including signer loss. That
    // prevents a failed exchange attempt from leaving bearer material live.
    if (!stewardSignerConfigured(c.env)) {
      return c.json(
        errorBody(
          "Staging session signer unavailable",
          "server_secret_missing",
        ),
        503,
        noStoreHeaders(),
      );
    }

    const bindingValid = await validateStagingSessionBinding({
      env: c.env,
      binding: record.claims.stagingSessionBinding,
      stewardUserId: record.claims.userId,
      tenantId: record.claims.tenantId,
      issuedAt: record.tokenIssuedAt,
      expiration: record.tokenExpiresAt,
    });
    if (!bindingValid) {
      return c.json(
        errorBody("Invalid or expired code", "invalid_code"),
        401,
        noStoreHeaders(),
      );
    }

    const remainingSeconds = Math.min(
      STAGING_SESSION_MAX_TTL_SECONDS,
      record.tokenExpiresAt - Math.floor(Date.now() / 1000),
    );
    if (remainingSeconds <= 0) {
      return c.json(
        errorBody("Invalid or expired code", "invalid_code"),
        401,
        noStoreHeaders(),
      );
    }
    const minted = await mintStewardTokenFromClaims(
      c.env,
      { ...record.claims, bridged: true },
      remainingSeconds,
    );
    if (!minted) {
      return c.json(
        errorBody(
          "Staging session signer unavailable",
          "server_secret_missing",
        ),
        503,
        noStoreHeaders(),
      );
    }

    return c.json(
      {
        ok: true,
        token: minted.token,
        expiresAt: minted.expiresAt,
        expiresIn: minted.expiresIn,
      },
      200,
      noStoreHeaders(),
    );
  } catch {
    // error-policy:J1 code-store, identity, signer, and revocation-store
    // failures all fail closed without logging credential-derived material.
    logger.error("[staging-session-exchange] exchange dependency unavailable");
    return c.json(
      errorBody("Staging session exchange unavailable", "exchange_unavailable"),
      503,
      noStoreHeaders(),
    );
  }
});

export default app;
