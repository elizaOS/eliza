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

function unauthorized(c: AppContext, description: string) {
  return c.json(oidcErrorBody("invalid_token", description), 401, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"`,
  });
}

function requireConfig(c: AppContext): OidcConfig | Response {
  if (!isOidcEnabled(c.env)) {
    return c.json({ error: "not_found" }, 404);
  }
  const config = resolveOidcConfig(c.env);
  if (!config || new URL(c.req.url).host.toLowerCase() !== config.issuerHost) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!isOidcSigningConfigured()) {
    logger.error(
      "[oidc] userinfo unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return c.json(
      oidcErrorBody(
        "temporarily_unavailable",
        "The identity provider is not configured.",
      ),
      503,
      { "Cache-Control": "no-store" },
    );
  }
  return config;
}

async function handleUserInfo(c: AppContext): Promise<Response> {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return unauthorized(c, "A bearer access token is required.");

  try {
    const verified = await verifyOidcAccessToken(token, config.issuer);
    if (!verified)
      return unauthorized(c, "The access token is invalid or expired.");
    if (!verified.scopes.includes("openid")) {
      return c.json(
        oidcErrorBody("insufficient_scope", "The openid scope is required."),
        403,
        { "Cache-Control": "no-store" },
      );
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
    return c.json(
      oidcErrorBody(
        "temporarily_unavailable",
        "Userinfo is temporarily unavailable.",
      ),
      503,
      { "Cache-Control": "no-store" },
    );
  }
}

app.get("/", handleUserInfo);
app.post("/", handleUserInfo);

export default app;
