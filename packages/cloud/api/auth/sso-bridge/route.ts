/**
 * Cross-host SSO bridge between the public/auth origin (eliza.app) and the
 * managed Eliza app origin (cloud.eliza.app):
 *
 *   POST /api/auth/sso-bridge/mint      (Bearer-authenticated) → { code }
 *   POST /api/auth/sso-bridge/exchange  (public, code+verifier) → { token }
 *
 * WHY A HANDSHAKE AND NOT A SHARED JS-READABLE COOKIE: the SPA session is a
 * per-origin localStorage JWT, and this platform serves user-controlled
 * content on sibling canonical hosts — user apps on `<id>.apps.eliza.app`,
 * dedicated-agent web UIs on `<sandboxId>.cloud.eliza.app`, and uploaded blobs
 * on `blob.eliza.app`. A non-HttpOnly parent-domain cookie would hand every one
 * of those origins the token, and cookies cannot scope to "apex + one
 * subdomain only". So the managed app redirects through the eliza.app auth
 * origin, which mints a 60-second single-use opaque code that the app
 * origin exchanges for a token over POST — no token ever appears in a URL.
 *
 * The code store is POSTGRES, not the cache: the deployed Worker cache is
 * Cloudflare KV (non-atomic, eventually consistent), which cannot enforce
 * single-use or make a logout marker promptly visible. The claim is a
 * one-statement `DELETE … RETURNING`, so a replayed or raced code loses
 * everywhere the Worker actually runs (see lib/services/sso-bridge-codes.ts).
 *
 * The code alone is NOT sufficient to exchange: mint binds it to a
 * PKCE-style `codeChallenge` (sha256 of a verifier held in the app origin's
 * sessionStorage and sent only in the exchange POST body). Both handshake
 * URLs carry only the code/challenge, so an attacker who can read HTTP logs
 * or browser history on either origin still cannot redeem the code. The
 * exchange never returns the stored auth-origin token — it re-mints a fresh
 * token from the claims verified at mint, capped to the original expiry, so
 * no session JWT is ever at rest in the store.
 *
 * Mint authenticates by BEARER ONLY, never the steward cookie: JS on any
 * sibling host can PLANT a parent-domain cookie (it cannot read the
 * HttpOnly ones, but the Cookie header carries no attribute provenance), so a
 * cookie-authenticated mint would let a related-domain attacker fixate their
 * session into the handshake. The Bearer token comes from the auth-origin
 * SPA's own localStorage, which no sibling origin can write.
 *
 * Origin gating is a strict per-role exact-host allowlist (mint = eliza.app
 * hosts, exchange = app hosts), enforced on the `Origin` header ONLY — a
 * `Referer` fallback would just widen the forgeable-input surface. Explicit
 * logout stamps a per-user Postgres marker (`/api/auth/logout`) and BOTH legs
 * refuse tokens issued before it, so logging out stays logged out across the
 * pair; a marker-store failure fails CLOSED (503 → normal per-origin login).
 */

import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { Hono } from "hono";
import {
  mintStewardTokenFromClaims,
  STEWARD_ACCESS_TOKEN_TTL_SECONDS,
  type StewardVerifyEnv,
  verifyStewardTokenCached,
} from "@/lib/auth/steward-client";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  consumeSsoBridgeCode,
  isBlockedBySsoBridgeLogout,
  issueSsoBridgeCode,
  looksLikeSsoBridgeChallenge,
  looksLikeSsoBridgeCode,
} from "@/lib/services/sso-bridge-codes";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/** Public/auth hosts that may MINT codes. Exact hosts only — no suffix match. */
const MINT_ORIGIN_HOSTS = new Set<string>([
  new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname,
  `www.${new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname}`,
  new URL(ELIZA_DOMAIN_CONTRACTS.staging.marketingOrigin).hostname,
]);

/** App hosts that may EXCHANGE codes. Exact hosts only — no suffix match. */
const EXCHANGE_ORIGIN_HOSTS = new Set<string>([
  new URL(ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin).hostname,
  new URL(ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin).hostname,
]);

/** Only honored when the worker is NOT production (local dev / tests). */
const LOCAL_DEV_ORIGIN_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

function originHost(rawOrigin: string | undefined): string | null {
  if (!rawOrigin) return null;
  try {
    return new URL(rawOrigin).hostname.toLowerCase();
  } catch {
    // error-policy:J3 an unparseable Origin header reads as "no origin" and
    // the request is rejected below (fail-closed).
    return null;
  }
}

/**
 * Strict per-role Origin check. Unlike the general steward-session CSRF check
 * there is deliberately no sibling-domain suffix acceptance, no same-host
 * fallback, and no Referer fallback (browsers always send Origin on POST;
 * non-browser callers forge both, so a fallback only widens the accepted
 * input surface): the bridge's callers are exactly the two SPA host sets,
 * and every user-content subdomain must stay out even though the credentialed
 * CORS layer already refuses them.
 */
function checkBridgeOrigin(
  c: { req: { header: (name: string) => string | undefined } },
  allowedHosts: ReadonlySet<string>,
  isProduction: boolean,
): boolean {
  const origin = originHost(c.req.header("origin"));
  if (!origin) return false;
  if (allowedHosts.has(origin)) return true;
  if (!isProduction && LOCAL_DEV_ORIGIN_HOSTS.has(origin)) return true;
  return false;
}

function stewardSecretConfigured(env: StewardVerifyEnv): boolean {
  return Boolean(env.STEWARD_SESSION_SECRET || env.STEWARD_JWT_SECRET);
}

function errorBody(
  message: string,
  code: string,
): { error: string; code: string } {
  return { error: message, code };
}

const app = new Hono<AppEnv>();

// Handshake legs are single-shot per login; STRICT (10/min/IP) is generous.
// Redis loss keeps login available but bounded per-isolate, mirroring the
// steward-session mint route.
app.use(
  rateLimit({
    ...RateLimitPresets.STRICT,
    keyGenerator: getIpKey,
    failClosed: true,
    redisUnavailableFallback: {
      namespace: "sso-bridge",
    },
  }),
);

app.post("/mint", async (c) => {
  try {
    const isProduction = c.env.NODE_ENV === "production";
    if (!checkBridgeOrigin(c, MINT_ORIGIN_HOSTS, isProduction)) {
      return c.json(errorBody("Forbidden", "forbidden_origin"), 403);
    }

    if (!stewardSecretConfigured(c.env)) {
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    const authHeader = c.req.header("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
    if (!token) {
      return c.json(errorBody("Authentication required", "missing_token"), 401);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      codeChallenge?: unknown;
    };
    const codeChallenge =
      typeof body.codeChallenge === "string" ? body.codeChallenge : null;
    if (!looksLikeSsoBridgeChallenge(codeChallenge)) {
      // No unbound codes, ever: without a verifier commitment the code alone
      // would be a bearer credential in two origins' request logs.
      return c.json(
        errorBody("Code challenge required", "missing_challenge"),
        400,
      );
    }

    const claims = await verifyStewardTokenCached(c.env, token);
    if (!claims) {
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }
    // QA sessions have their own versioned code namespace. Letting one enter
    // the legacy `esso_` bridge would leave a pending code that an older
    // deployment could consume with the ordinary Steward signer after a
    // rollback, stripping the continuous source-binding checks.
    if (claims.stagingSessionBinding) {
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    if (await isBlockedBySsoBridgeLogout(claims.userId, claims.issuedAt)) {
      // The user explicitly logged out after this token was issued: minting
      // would silently undo that logout on the app host.
      return c.json(errorBody("Session was signed out", "session_ended"), 401);
    }

    const issued = await issueSsoBridgeCode({ claims, codeChallenge });
    return c.json({ ok: true, code: issued.code, expiresIn: issued.expiresIn });
  } catch (error) {
    // error-policy:J1 route boundary — storage/verification failures become a
    // structured 503 the client turns into its fall-back-to-login redirect.
    // This is also the logout-marker fail-CLOSED path: an unreadable marker
    // store throws and lands here, so an outage can never mint.
    logger.error("[sso-bridge] mint failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(errorBody("SSO bridge unavailable", "sso_unavailable"), 503);
  }
});

app.post("/exchange", async (c) => {
  try {
    const isProduction = c.env.NODE_ENV === "production";
    if (!checkBridgeOrigin(c, EXCHANGE_ORIGIN_HOSTS, isProduction)) {
      return c.json(errorBody("Forbidden", "forbidden_origin"), 403);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      code?: unknown;
      codeVerifier?: unknown;
    };
    const code = typeof body.code === "string" ? body.code : null;
    if (!looksLikeSsoBridgeCode(code)) {
      return c.json(errorBody("Code required", "missing_code"), 400);
    }
    const codeVerifier =
      typeof body.codeVerifier === "string" ? body.codeVerifier : null;

    // Consume BEFORE any further checks — the atomic claim burns the code even
    // when the verifier is wrong or absent, which doubles as the client's
    // burn-an-abandoned-code path ({code} with no verifier).
    const record = await consumeSsoBridgeCode(code, codeVerifier);
    if (!record) {
      // Unknown, expired, already consumed, or verifier mismatch — identical
      // outcomes, so a replayed or stolen code cannot probe which it was.
      return c.json(errorBody("Invalid or expired code", "invalid_code"), 401);
    }

    // The session could have been logged out inside the 60-second code window —
    // never hand out a token the platform would now reject. Marker ordering
    // uses the ORIGINAL token's iat captured at mint.
    if (
      await isBlockedBySsoBridgeLogout(
        record.stewardUserId,
        record.tokenIssuedAt,
      )
    ) {
      return c.json(errorBody("Session was signed out", "session_ended"), 401);
    }

    // Re-mint from the claims verified at mint, capped to the ORIGINAL exp so
    // the bridge can never extend a session's lifetime. The stored dashboard
    // token was never persisted, so there is nothing to replay out of the DB.
    // The `bridged` stamp marks the token as bridge-issued: the session-sync
    // endpoint consults the logout marker (fail closed) ONLY for stamped
    // tokens, so ordinary logins never acquire the marker store as a hard
    // availability dependency.
    // The verifier caps the signed issued lifetime at the access-token TTL,
    // while an original token minted on a slightly-ahead issuer clock is
    // accepted with remaining = TTL + skew. Clamp the re-mint to the TTL so
    // the bridge never hands out a token its own platform rejects; the clamp
    // can only shorten the session, never extend it past the original exp.
    const remainingSeconds = Math.min(
      STEWARD_ACCESS_TOKEN_TTL_SECONDS,
      record.tokenExpiresAt - Math.floor(Date.now() / 1000),
    );
    if (remainingSeconds <= 0) {
      return c.json(errorBody("Session no longer valid", "invalid_token"), 401);
    }
    const minted = await mintStewardTokenFromClaims(
      c.env,
      { ...record.claims, bridged: true },
      remainingSeconds,
    );
    if (!minted) {
      return c.json(
        errorBody(
          "Steward verification not configured on server",
          "server_secret_missing",
        ),
        503,
      );
    }

    return c.json({ ok: true, token: minted.token });
  } catch (error) {
    // error-policy:J1 route boundary — storage/verification failures become a
    // structured 503 the client turns into its fall-back-to-login redirect.
    // Also the logout-marker fail-CLOSED path (see /mint).
    logger.error("[sso-bridge] exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(errorBody("SSO bridge unavailable", "sso_unavailable"), 503);
  }
});

export default app;
