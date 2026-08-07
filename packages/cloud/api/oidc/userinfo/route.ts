/**
 * GET|POST /api/oidc/userinfo — current claims for the subject of a bearer
 * access token.
 *
 * The token is verified LOCALLY against the OIDC key ring (no network, no
 * token store), and the `at+jwt` type header is required so an ID token — which
 * the relying party holds and frequently logs — cannot be replayed here.
 *
 * Claims are rebuilt from live rows rather than echoed from the token. That is
 * the whole point of the endpoint: access tokens are stateless and cannot be
 * revoked before they expire, so `/userinfo` is where a deactivated account or
 * a changed role becomes visible within seconds.
 *
 * Every refusal is an RFC 6750 challenge, never a bare status: the client's
 * next move — retry, re-authorize with a wider scope, or give up — is decided
 * from `WWW-Authenticate` alone.
 */

import { Hono } from "hono";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { buildOidcClaims } from "@/lib/oidc/claims";
import { getOidcClient } from "@/lib/oidc/clients";
import {
  describeOidcConfigFailure,
  isOidcEnabled,
  type OidcConfig,
  resolveOidcConfig,
} from "@/lib/oidc/config";
import { oidcErrorBody } from "@/lib/oidc/errors";
import { isOidcSigningConfigured } from "@/lib/oidc/keys";
import { assertOidcSubjectEligible, loadOidcSubject } from "@/lib/oidc/subject";
import { verifyOidcAccessToken } from "@/lib/oidc/tokens";
import { resolveOidcUsername } from "@/lib/oidc/username";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use(
  rateLimit({
    ...RateLimitPresets.RELAXED,
    keyGenerator: getIpKey,
    failClosed: true,
    redisUnavailableFallback: { namespace: "oidc-userinfo" },
  }),
);

/** RFC 7235 §2.1: the auth-scheme token is matched case-insensitively. */
const BEARER_SCHEME = /^bearer[ \t]+/i;

/**
 * The presented bearer token, or null when the header names another scheme.
 *
 * The scheme comparison is case-insensitive because RFC 7235 defines it that
 * way and clients rely on it — `bearer <token>` is what several HTTP libraries
 * and hand-written shell callers send, and rejecting it produces a 401 that
 * looks like an expired token and sends the caller off to re-authenticate a
 * credential that was never wrong.
 */
function readBearerToken(c: AppContext): string | null {
  const header = c.req.header("authorization");
  const scheme = header ? BEARER_SCHEME.exec(header) : null;
  if (!header || !scheme) return null;
  const token = header.slice(scheme[0].length).trim();
  return token.length > 0 ? token : null;
}

/** RFC 7230 §3.2.6 quoted-string escaping for a challenge parameter. */
function quoteChallengeValue(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

/**
 * RFC 6750 §3: EVERY 401 and 403 from a bearer-protected resource carries a
 * challenge. It is the only machine-readable part of the refusal — a client
 * that cannot see `invalid_token` versus `insufficient_scope` cannot tell "get
 * a new token" from "that token will never be enough", and retries forever.
 */
function bearerChallenge(
  error: "invalid_token" | "insufficient_scope",
  description: string,
  scope?: string,
): string {
  const parameters = [
    `error="${error}"`,
    `error_description="${quoteChallengeValue(description)}"`,
  ];
  if (scope) parameters.push(`scope="${quoteChallengeValue(scope)}"`);
  return `Bearer ${parameters.join(", ")}`;
}

function unauthorized(c: AppContext, description: string) {
  return c.json(oidcErrorBody("invalid_token", description), 401, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": bearerChallenge("invalid_token", description),
  });
}

/** RFC 6750 §3.1: the scope the token would have needed is named in the challenge. */
function insufficientScope(c: AppContext, description: string, scope: string) {
  return c.json(oidcErrorBody("insufficient_scope", description), 403, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": bearerChallenge(
      "insufficient_scope",
      description,
      scope,
    ),
  });
}

/**
 * The provider cannot answer right now. RFC 6750 §3.1 gives a bearer-protected
 * resource three error codes and none of them means "retry later", so the
 * availability signal is carried by 503 plus `Retry-After` and the body has no
 * `error` member: a client must not read this as `invalid_token` and throw away
 * a session that is still perfectly valid.
 */
function serviceUnavailable(c: AppContext, description: string) {
  return c.json({ error_description: description }, 503, {
    "Cache-Control": "no-store",
    "Retry-After": "5",
  });
}

function requireConfig(c: AppContext): OidcConfig | Response {
  if (!isOidcEnabled(c.env)) {
    return c.json({ error: "not_found" }, 404);
  }
  const config = resolveOidcConfig(c.env);
  if (!config) {
    logger.error("[oidc] userinfo unavailable", {
      reason: describeOidcConfigFailure(c.env),
    });
    return c.json({ error: "not_found" }, 404);
  }
  if (new URL(c.req.url).host.toLowerCase() !== config.issuerHost) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!isOidcSigningConfigured()) {
    logger.error(
      "[oidc] userinfo unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return serviceUnavailable(c, "The identity provider is not configured.");
  }
  return config;
}

async function handleUserInfo(c: AppContext): Promise<Response> {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  const token = readBearerToken(c);
  if (!token) return unauthorized(c, "A bearer access token is required.");

  try {
    const verified = await verifyOidcAccessToken(token, config.issuer);
    if (!verified)
      return unauthorized(c, "The access token is invalid or expired.");
    if (!verified.scopes.includes("openid")) {
      return insufficientScope(c, "The openid scope is required.", "openid");
    }

    const client = getOidcClient(verified.clientId);
    if (!client)
      return unauthorized(c, "The access token is invalid or expired.");

    const subject = await loadOidcSubject(verified.subject);
    if (!subject) return unauthorized(c, "The account is unavailable.");
    if (assertOidcSubjectEligible(subject, client)) {
      return unauthorized(c, "The account is unavailable.");
    }

    const username = await resolveOidcUsername({
      id: subject.user.id,
      nickname: subject.user.nickname,
      name: subject.user.name,
      email: subject.user.email,
    });

    const claims = buildOidcClaims({
      user: subject.user,
      organization: subject.user.organization,
      profile: subject.profile,
      username,
      adminStatus: subject.adminStatus,
      deploymentTenantId:
        typeof c.env.STEWARD_TENANT_ID === "string"
          ? c.env.STEWARD_TENANT_ID
          : null,
      scopes: verified.scopes,
      client,
    });

    return c.json(claims, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    // error-policy:J1 route boundary — a store or registry failure is an
    // availability problem, not an invalid token; saying otherwise would make
    // a relying party discard a live session.
    logger.error("[oidc] userinfo failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return serviceUnavailable(c, "Userinfo is temporarily unavailable.");
  }
}

app.get("/", handleUserInfo);
app.post("/", handleUserInfo);

export default app;
