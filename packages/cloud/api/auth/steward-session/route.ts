/**
 * POST /api/auth/steward-session — set steward-token cookie from a steward JWT.
 * DELETE /api/auth/steward-session — clear steward cookies (logout).
 */

import {
  type StewardSessionErrorCode,
  type StewardSessionRequest,
  type StewardSessionResponse,
  type StewardTelegramClaimConfirmationRequest,
  sanitizeTelegramAccountClaimContinuation,
} from "@elizaos/shared/steward-session-client";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { getAuditDispatcher } from "@/api-app/services/audit-dispatcher-singleton";
import {
  checkElizaMutatingRequestOrigin,
  hasElizaNonSimpleRequestMarker,
} from "@/lib/auth/browser-origin-policy";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";
import { loadVerifiedStagingSessionUser } from "@/lib/auth/staging-session-binding";
import {
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import { stewardCookieNames } from "@/lib/auth/steward-cookies";
import {
  getIpKey,
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { isBlockedBySsoBridgeLogout } from "@/lib/services/sso-bridge-codes";
import {
  StewardPhoneOwnershipError,
  verifyStewardBearerPhone,
} from "@/lib/services/steward-client";
import {
  describeSyncError,
  StewardPhoneAccountConflictError,
  StewardTelegramAccountClaimError,
  syncUserFromSteward,
} from "@/lib/steward-sync";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

const STEWARD_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * CSRF check. Modern browsers always send Origin on cross-origin POST/DELETE
 * (Fetch spec) and on same-origin POST too since 2020. We REQUIRE Origin or
 * Referer on every mutating request — no header-less fallthrough. Tooling
 * (curl, server-to-server, e2e tests, native app) must send an explicit
 * `Origin: http://localhost:8787` (in dev) or the configured prod host. This
 * closes the legacy-browser / extension CSRF hole flagged by the prior SSO
 * audit.
 */
function checkOrigin(
  c: { req: { header: (name: string) => string | undefined } },
  isProduction: boolean,
): { ok: true } | { ok: false; reason: string } {
  return checkElizaMutatingRequestOrigin(c.req, isProduction);
}

/**
 * Second CSRF layer after the Origin policy: a cross-origin "simple request"
 * (the only kind that carries cookies without a preflight) cannot produce a
 * custom header or a JSON content type. Hono parses `text/plain` bodies as
 * JSON, so without this check an attacker page on a user-content subdomain
 * could plant a session with a preflight-less POST. Requiring the marker
 * forces the preflight that the first-party-only CORS layer fails for them.
 */
function checkNonSimpleMarker(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  return hasElizaNonSimpleRequestMarker(c.req);
}

let stewardAuthMetricCounter = 0;
function logStewardAuth(outcome: string, ttl: number | null) {
  stewardAuthMetricCounter += 1;
  logger.info("[steward-auth]", {
    timestamp: new Date().toISOString(),
    ttl,
    outcome,
    metric: stewardAuthMetricCounter,
  });
}

function errorBody(
  message: string,
  code: StewardSessionErrorCode,
): { error: string; code: StewardSessionErrorCode } {
  return { error: message, code };
}

const app = new Hono<AppEnv>();

// Pre-auth session-mint endpoint: the global Redis bucket is the primary
// throttle. If Redis is unreachable, keep login available but still bounded by
// a strict per-isolate bucket; top-up/payment routes stay hard fail-closed.
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
    redisUnavailableFallback: {
      namespace: "steward-session",
    },
  }),
);

app.post("/", async (c) => {
  try {
    const isProduction = c.env.NODE_ENV === "production";
    const originCheck = checkOrigin(c, isProduction);
    if (!originCheck.ok) {
      logStewardAuth("forbidden-origin", null);
      logger.warn("[steward-auth] rejected cross-origin POST", {
        detail: originCheck.reason,
      });
      return c.json(
        { error: "Forbidden", code: "forbidden_origin" as const },
        403,
      );
    }
    if (!checkNonSimpleMarker(c)) {
      logStewardAuth("csrf-marker-missing", null);
      return c.json(
        { error: "Forbidden", code: "csrf_marker_required" as const },
        403,
      );
    }

    const body = (await c.req
      .json()
      .catch(() => ({}) as Partial<StewardSessionRequest>)) as Partial<
      StewardSessionRequest & StewardTelegramClaimConfirmationRequest
    >;
    const token = body.token;
    const refreshToken = body.refreshToken;
    const verifiedPhoneHint = body.verifiedPhone;
    const telegramContinuation = sanitizeTelegramAccountClaimContinuation(
      body.telegramContinuation,
    );

    if (!token || typeof token !== "string") {
      logStewardAuth("missing-token", null);
      return c.json(errorBody("Token required", "missing_token"), 400);
    }

    if (
      verifiedPhoneHint !== undefined &&
      (typeof verifiedPhoneHint !== "string" ||
        verifiedPhoneHint.trim().length === 0)
    ) {
      logStewardAuth("verified-phone-invalid", null);
      return c.json(
        errorBody("Verified phone must be a string", "verified_phone_invalid"),
        400,
      );
    }
    if (body.telegramContinuation !== undefined && !telegramContinuation) {
      logStewardAuth("telegram-claim-invalid", null);
      return c.json(
        errorBody("Invalid Telegram account claim", "telegram_claim_conflict"),
        409,
      );
    }
    if (telegramContinuation && body.telegramClaimConfirmation !== "explicit") {
      logStewardAuth("telegram-claim-confirmation-missing", null);
      return c.json(
        errorBody(
          "Telegram account confirmation required",
          "telegram_claim_conflict",
        ),
        409,
      );
    }
    if (
      body.telegramClaimConfirmation !== undefined &&
      (!telegramContinuation || body.telegramClaimConfirmation !== "explicit")
    ) {
      logStewardAuth("telegram-claim-confirmation-invalid", null);
      return c.json(
        errorBody(
          "Invalid Telegram account confirmation",
          "telegram_claim_conflict",
        ),
        409,
      );
    }

    if (!stewardSecretConfigured(c.env)) {
      // Worker can't verify any token — the deployment is missing
      // STEWARD_SESSION_SECRET / STEWARD_JWT_SECRET. Surface this distinctly
      // so the client doesn't treat it as a revocation and wipe localStorage.
      logStewardAuth("server-secret-missing", null);
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    const claims = await verifyStewardTokenCached(c.env, token);
    if (!claims) {
      logStewardAuth("invalid-token", null);
      await getAuditDispatcher()
        .emit({
          actor: { type: "user", id: "anonymous" },
          action: "auth.login.failed",
          result: "failure",
          resource: null,
          ip: getRequestIp(c),
          user_agent: c.req.header("user-agent") ?? undefined,
          request_id: c.get("requestId"),
          metadata: { provider: "steward", reason: "invalid_token" },
        })
        // error-policy:J7 audit write must not block the 401; a dropped auth audit is logged.
        .catch((err) =>
          logger.error("[StewardSession] audit emit for failed login failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    const verifiedTelegramId =
      claims.authMethod === "telegram" ? claims.telegramId : undefined;
    if (claims.telegramId && !verifiedTelegramId) {
      logStewardAuth("telegram-claims-invalid", null);
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    // A signed Telegram login and a browser-supplied DM continuation are two
    // independent authorities. Never let a caller combine them to select one
    // Telegram identity while authenticating as another.
    if (verifiedTelegramId && telegramContinuation) {
      logStewardAuth("telegram-authority-ambiguous", null);
      return c.json(
        errorBody(
          "Telegram login cannot consume an account continuation",
          "telegram_claim_conflict",
        ),
        409,
      );
    }

    // Cross-host logout barrier — BRIDGE-ISSUED tokens only. After an explicit
    // logout, the app origin's surviving bridge-minted token must not re-plant
    // the domain-wide cookies via its background session sync (that would
    // silently undo the logout the user just performed). A stamped token
    // issued at-or-before the user's last explicit logout is refused with a
    // DISTINCT code the client honors as a real revocation (it clears its
    // stored session instead of retrying). Ordinary tokens never reach the
    // marker store: this path must keep minting through an infrastructure
    // outage (see the Redis-outage suite), and a token that never crossed the
    // bridge has the same security posture it had before the bridge existed.
    if (claims.bridged) {
      let blockedByLogout: boolean;
      try {
        blockedByLogout = await isBlockedBySsoBridgeLogout(
          claims.userId,
          claims.issuedAt,
        );
      } catch (error) {
        // error-policy:J1 marker-store outage fails CLOSED for bridge-issued
        // tokens, translated to the same 503 the bridge legs return — no
        // cookies get planted while the logout barrier is unreadable.
        logStewardAuth("sso-marker-unavailable", null);
        logger.error("[steward-auth] SSO logout-marker store unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          errorBody("SSO bridge unavailable", "sso_unavailable"),
          503,
        );
      }
      if (blockedByLogout) {
        logStewardAuth("session-ended", null);
        return c.json(
          errorBody("Session was signed out", "session_ended"),
          401,
        );
      }
    }

    let verifiedPhone: string | undefined;
    if (verifiedPhoneHint) {
      try {
        const ownership = await verifyStewardBearerPhone({
          env: c.env,
          bearerToken: token,
          tenantId: claims.tenantId,
          phoneNumber: verifiedPhoneHint,
        });
        if (ownership.status !== "verified") {
          logStewardAuth("verified-phone-mismatch", null);
          return c.json(
            errorBody(
              "Phone is not linked to this Steward session",
              "verified_phone_mismatch",
            ),
            403,
          );
        }
        verifiedPhone = ownership.phoneNumber;
      } catch (error) {
        if (
          error instanceof StewardPhoneOwnershipError &&
          error.code === "invalid_phone"
        ) {
          logStewardAuth("verified-phone-invalid", null);
          return c.json(
            errorBody("Invalid phone number", "verified_phone_invalid"),
            400,
          );
        }
        logStewardAuth("verified-phone-upstream-unavailable", null);
        logger.error("[steward-auth] Steward phone verification failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          errorBody(
            "Could not verify phone ownership",
            "steward_upstream_unavailable",
          ),
          503,
        );
      }
    }

    let cloudUser: Awaited<ReturnType<typeof syncUserFromSteward>>;
    if (claims.stagingSessionBinding) {
      if (telegramContinuation) {
        logStewardAuth("telegram-claim-staging-session", null);
        return c.json(
          errorBody(
            "A QA session cannot claim a Telegram account",
            "telegram_claim_conflict",
          ),
          409,
        );
      }
      const boundCloudUser = await loadVerifiedStagingSessionUser({
        binding: claims.stagingSessionBinding,
        stewardUserId: claims.userId,
      });
      if (!boundCloudUser) {
        logStewardAuth("invalid-bound-subject", null);
        return c.json(errorBody("Invalid token", "invalid_token"), 401);
      }
      cloudUser = boundCloudUser;
    } else {
      try {
        cloudUser = await syncUserFromSteward({
          stewardUserId: claims.userId,
          email: claims.email,
          walletAddress: claims.walletAddress ?? claims.address,
          walletChainType: claims.walletChain,
          verifiedTelegramId: claims.telegramId,
          verifiedPhone,
          verifiedTelegramId,
          telegramContinuation: telegramContinuation ?? undefined,
          sharedRuntimeConversationNamespace:
            c.env.SHARED_RUNTIME_CONVERSATIONS,
        });
      } catch (error) {
        if (error instanceof StewardPhoneAccountConflictError) {
          logStewardAuth("verified-phone-conflict", null);
          return c.json(
            errorBody(
              "This phone account cannot be linked automatically",
              "verified_phone_conflict",
            ),
            409,
          );
        }
        if (error instanceof StewardTelegramAccountClaimError) {
          logStewardAuth("telegram-claim-conflict", null);
          return c.json(
            errorBody(
              "This Telegram chat cannot be linked automatically",
              "telegram_claim_conflict",
            ),
            409,
          );
        }
        logStewardAuth("sync-failed", null);
        // Workers Logs indexes only the message STRING — an Error passed in the
        // context object is dropped entirely. Inline everything (same fix as the
        // steward-nonce-exchange twin catch).
        logger.error(
          `[steward-auth] Failed to sync Steward user before setting cookie (stewardUserId=${claims.userId}): ${describeSyncError(error)}`,
        );
        return c.json(
          errorBody("Could not sync Steward user", "steward_user_sync_failed"),
          500,
        );
      }
    }

    const ttl = claims.expiration
      ? Math.max(0, claims.expiration - Math.floor(Date.now() / 1000))
      : null;

    const secure = c.env.NODE_ENV === "production";
    const domain = cookieDomainForHost(c.req.header("host"));

    const cookieNames = stewardCookieNames(c.env.ENVIRONMENT);

    setCookie(c, cookieNames.token, token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      ...(typeof ttl === "number" ? { maxAge: ttl } : {}),
    });

    if (claims.stagingSessionBinding) {
      // QA sessions have a signed absolute expiry and are deliberately not
      // renewable. Remove any older refresh cookie so it cannot silently
      // replace the QA session with an ordinary long-lived Steward session.
      deleteCookie(c, cookieNames.refreshToken, {
        path: "/",
        ...(domain ? { domain } : {}),
      });
    } else if (typeof refreshToken === "string" && refreshToken.length > 0) {
      setCookie(c, cookieNames.refreshToken, refreshToken, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        ...(domain ? { domain } : {}),
        maxAge: STEWARD_REFRESH_COOKIE_MAX_AGE,
      });
    }

    setCookie(c, cookieNames.authed, "1", {
      httpOnly: false,
      secure,
      sameSite: "Lax",
      path: "/",
      ...(domain ? { domain } : {}),
      maxAge:
        claims.stagingSessionBinding && typeof ttl === "number"
          ? ttl
          : STEWARD_REFRESH_COOKIE_MAX_AGE,
    });

    logStewardAuth("ok", ttl);
    await getAuditDispatcher()
      .emit({
        actor: { type: "user", id: cloudUser.id },
        action: "auth.login",
        result: "success",
        resource: null,
        org_id: cloudUser.organization_id ?? undefined,
        ip: getRequestIp(c),
        user_agent: c.req.header("user-agent") ?? undefined,
        request_id: c.get("requestId"),
        metadata: { provider: "steward", method: "session_exchange" },
      })
      // error-policy:J7 audit write must not block the login response; a dropped auth audit is logged.
      .catch((err) =>
        logger.error(
          "[StewardSession] audit emit for successful login failed",
          {
            userId: cloudUser.id,
            error: err instanceof Error ? err.message : String(err),
          },
        ),
      );
    const response: StewardSessionResponse = {
      ok: true,
      userId: cloudUser.id,
      stewardUserId: claims.userId,
      initialCreditsGranted: cloudUser.initialCreditsGranted,
      initialFreeCreditsUsd: cloudUser.initialFreeCreditsUsd,
      welcomeBonusWithheld: cloudUser.welcomeBonusWithheld === true,
      welcomeBonusWithheldReason: cloudUser.welcomeBonusWithheldReason,
      welcomeBonusWithheldMessage: cloudUser.welcomeBonusWithheldMessage,
    };
    return c.json(response);
  } catch {
    logStewardAuth("error", null);
    return c.json(errorBody("Internal error", "internal_error"), 500);
  }
});

app.delete("/", (c) => {
  const isProduction = c.env.NODE_ENV === "production";
  const originCheck = checkOrigin(c, isProduction);
  if (!originCheck.ok) {
    logStewardAuth("forbidden-origin-delete", null);
    return c.json({ error: "Forbidden" }, 403);
  }
  if (!checkNonSimpleMarker(c)) {
    logStewardAuth("csrf-marker-missing-delete", null);
    return c.json({ error: "Forbidden", code: "csrf_marker_required" }, 403);
  }
  const domain = cookieDomainForHost(c.req.header("host"));
  const opts = domain ? { path: "/", domain } : { path: "/" };
  // Production's cookieNames resolve to the same unsuffixed names as
  // LEGACY_STEWARD_COOKIES, so a single set of deleteCookie calls covers both
  // eras. The separate legacy clear block was redundant (#14130).
  const names = stewardCookieNames(c.env.ENVIRONMENT);
  deleteCookie(c, names.token, opts);
  deleteCookie(c, names.refreshToken, opts);
  deleteCookie(c, names.authed, opts);
  logStewardAuth("deleted", null);
  return c.json({ ok: true });
});

export default app;
