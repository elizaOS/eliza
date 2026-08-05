/**
 * Cross-host SSO bridge between the dashboard origin (elizacloud.ai) and the
 * Eliza app-mode origin (app.elizacloud.ai):
 *
 *   POST /api/auth/sso-bridge/mint      (Bearer-authenticated) → { code }
 *   POST /api/auth/sso-bridge/exchange  (public, code-authed)  → { token }
 *
 * WHY A HANDSHAKE AND NOT A SHARED JS-READABLE COOKIE: the SPA session is a
 * per-origin localStorage JWT, and this platform serves user-controlled
 * content on sibling `*.elizacloud.ai` hosts — user apps on
 * `<id>.apps.elizacloud.ai` (services/app-url.ts), dedicated-agent web UIs on
 * `<sandboxId>.elizacloud.ai` (eliza-agent-web-ui.ts), uploaded blobs on
 * `blob.elizacloud.ai` (blob-host.ts). A non-HttpOnly `Domain=elizacloud.ai`
 * cookie would hand every one of those origins the token, and cookies cannot
 * scope to "apex + one subdomain only". So the app origin redirects through
 * the dashboard, which mints a 60-second single-use opaque code (stored
 * hashed, consumed atomically) that the app origin exchanges for the token
 * over POST — the token never appears in a URL.
 *
 * Mint authenticates by BEARER ONLY, never the steward cookie: JS on any
 * `*.elizacloud.ai` host can PLANT a parent-domain cookie (it cannot read the
 * HttpOnly ones, but the Cookie header carries no attribute provenance), so a
 * cookie-authenticated mint would let a related-domain attacker fixate their
 * session into the handshake. The Bearer token comes from the dashboard
 * SPA's own localStorage, which no sibling origin can write.
 *
 * Origin gating is a strict per-role exact-host allowlist (mint = dashboard
 * hosts, exchange = app hosts); the CSRF-binding `state` nonce is enforced
 * client-side on the initiating origin (sessionStorage — see
 * `packages/ui/src/cloud/sso-bridge/sso-bridge.ts`). Explicit logout stamps a
 * per-user marker (`/api/auth/logout`) and BOTH legs refuse tokens issued
 * before it, so logging out stays logged out across the pair.
 */

import { Hono } from "hono";
import {
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
  looksLikeSsoBridgeCode,
} from "@/lib/services/sso-bridge-codes";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/** Dashboard hosts that may MINT codes. Exact hosts only — no suffix match. */
const MINT_ORIGIN_HOSTS = new Set<string>([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "staging.elizacloud.ai",
]);

/** App hosts that may EXCHANGE codes. Exact hosts only — no suffix match. */
const EXCHANGE_ORIGIN_HOSTS = new Set<string>([
  "app.elizacloud.ai",
  "app-staging.elizacloud.ai",
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
 * there is deliberately NO `.elizacloud.ai` suffix acceptance and no
 * same-host fallback: the bridge's callers are exactly the two SPA host sets,
 * and every user-content subdomain must stay out even though the credentialed
 * CORS layer already refuses them.
 */
function checkBridgeOrigin(
  c: { req: { header: (name: string) => string | undefined } },
  allowedHosts: ReadonlySet<string>,
  isProduction: boolean,
): boolean {
  const origin =
    originHost(c.req.header("origin")) ?? originHost(c.req.header("referer"));
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

    const claims = await verifyStewardTokenCached(c.env, token);
    if (!claims) {
      return c.json(errorBody("Invalid token", "invalid_token"), 401);
    }

    if (await isBlockedBySsoBridgeLogout(claims.userId, claims.issuedAt)) {
      // The user explicitly logged out after this token was issued: minting
      // would silently undo that logout on the app host.
      return c.json(errorBody("Session was signed out", "session_ended"), 401);
    }

    const issued = await issueSsoBridgeCode({
      token,
      stewardUserId: claims.userId,
    });
    return c.json({ ok: true, code: issued.code, expiresIn: issued.expiresIn });
  } catch (error) {
    // error-policy:J1 route boundary — storage/verification failures become a
    // structured 503 the client turns into its fall-back-to-login redirect.
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

    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code : null;
    if (!looksLikeSsoBridgeCode(code)) {
      return c.json(errorBody("Code required", "missing_code"), 400);
    }

    const record = await consumeSsoBridgeCode(code);
    if (!record) {
      // Unknown, expired, or already consumed — atomically identical
      // outcomes, so a replayed code cannot probe which it was.
      return c.json(errorBody("Invalid or expired code", "invalid_code"), 401);
    }

    // The session could have been revoked or logged out inside the 60-second
    // code window — never hand out a token the platform would now reject.
    const claims = await verifyStewardTokenCached(c.env, record.token);
    if (!claims) {
      return c.json(errorBody("Session no longer valid", "invalid_token"), 401);
    }
    if (await isBlockedBySsoBridgeLogout(claims.userId, claims.issuedAt)) {
      return c.json(errorBody("Session was signed out", "session_ended"), 401);
    }

    return c.json({ ok: true, token: record.token });
  } catch (error) {
    // error-policy:J1 route boundary — storage/verification failures become a
    // structured 503 the client turns into its fall-back-to-login redirect.
    logger.error("[sso-bridge] exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(errorBody("SSO bridge unavailable", "sso_unavailable"), 503);
  }
});

export default app;
