/**
 * POST /api/oidc/token — authorization-code redemption.
 *
 * Ordering, and why it differs from the SSO bridge's exchange leg: the CLIENT
 * is authenticated FIRST, and only then is the code claimed. The bridge claims
 * first because its code is the sole credential and burning it on a bad
 * verifier is a feature; here a code is only half the credential, so claiming
 * before client auth would let an unauthenticated caller destroy arbitrary
 * pending authorizations.
 *
 * After the atomic claim, every binding failure — wrong client, wrong
 * redirect_uri, bad PKCE verifier, deactivated user — returns the SAME
 * `invalid_grant`, so a stolen or replayed code cannot probe which check it
 * failed. A parameter that is simply ABSENT is answered before the claim with
 * `invalid_request`: it says nothing about any stored code, and RFC 6749 5.2
 * gives the two codes opposite meanings to the relying party.
 *
 * There is deliberately NO Origin/Referer check here. The steward-session and
 * nonce-exchange routes require one, but this is a back-channel server-to-server
 * POST that carries neither; copying that gate would break SSO outright.
 *
 * No refresh token is issued (`grant_types_supported: ["authorization_code"]`),
 * which removes a persistent-credential store and, with it, the code-reuse
 * token-family revocation obligation.
 */

import { Hono } from "hono";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { buildOidcClaims } from "@/lib/oidc/claims";
import {
  getOidcClient,
  type OidcClient,
  verifyOidcClientSecret,
} from "@/lib/oidc/clients";
import { consumeOidcAuthorizationCode } from "@/lib/oidc/codes";
import {
  describeOidcConfigFailure,
  isOidcEnabled,
  type OidcConfig,
  resolveOidcConfig,
} from "@/lib/oidc/config";
import { sha256Base64Url } from "@/lib/oidc/crypto";
import { oidcTokenErrorBody } from "@/lib/oidc/errors";
import { isOidcSigningConfigured } from "@/lib/oidc/keys";
import { assertOidcSubjectEligible, loadOidcSubject } from "@/lib/oidc/subject";
import { mintOidcAccessToken, mintOidcIdToken } from "@/lib/oidc/tokens";
import { resolveOidcUsername } from "@/lib/oidc/username";
import { isBlockedBySsoBridgeLogout } from "@/lib/services/sso-bridge-codes";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { emitOidcAudit } from "../audit";

const app = new Hono<AppEnv>();

const NO_STORE = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

/**
 * Per-client-per-IP where the client is REGISTERED, per-IP otherwise.
 *
 * Two constraints pull against each other. A busy relying party is a single
 * egress address, so the STRICT (10/min/IP) preset the browser-facing auth
 * routes use would throttle a normal login burst — hence the client in the key.
 * But the client id here is unauthenticated, so keying on it ALONE would let an
 * attacker mint a fresh bucket per request simply by varying the header. Only
 * registered ids widen the key; everything else collapses onto the IP bucket.
 * Keeping the IP in the key too means one relying party cannot exhaust
 * another's budget. The global 600/min IP backstop applies underneath.
 */
function tokenRateLimitKey(c: AppContext): string {
  const ipKey = getIpKey(c);
  try {
    for (const candidate of readBasicCredentials(c)) {
      if (getOidcClient(candidate.clientId)) {
        return `oidc:${candidate.clientId}:${ipKey}`;
      }
    }
    return ipKey;
  } catch {
    // error-policy:J3 an unreadable registry cannot widen the key; fall back to
    // the narrower IP bucket rather than skipping the limiter.
    return ipKey;
  }
}

app.use(
  rateLimit({
    ...RateLimitPresets.RELAXED,
    keyGenerator: tokenRateLimitKey,
    failClosed: true,
    redisUnavailableFallback: { namespace: "oidc-token" },
  }),
);

interface BasicCredentials {
  clientId: string;
  clientSecret: string;
}

/** RFC 7235 §2.1: the auth-scheme token is matched case-insensitively. */
const BASIC_SCHEME = /^basic[ \t]+/i;

/**
 * The `%`-decoded reading of one credential half, or null when the text is not
 * valid percent-encoding and therefore cannot have been produced by an encoder.
 */
function formUrlDecode(value: string): string | null {
  try {
    // `application/x-www-form-urlencoded` writes a space as `+`.
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an invalid escape means
    // "this half was not form-encoded", which the caller handles by using the
    // literal text instead of inventing a decoded one.
    return null;
  }
}

/**
 * RFC 6749 §2.3.1 `client_secret_basic`, read as EVERY credential pair the
 * header could legitimately mean, most literal first.
 *
 * §2.3.1 says both halves are form-url-encoded before base64, and Go's
 * `oauth2` (Forgejo, goth) does exactly that — but curl, most shell scripts,
 * and several libraries base64 the raw text. The two readings differ only for a
 * secret containing `%`, and decoding unconditionally silently corrupts one of
 * them: `pa%2Fss` becomes `pa/ss`, which no longer matches its stored hash, and
 * a valid secret is rejected with `invalid_client` forever. Both readings are
 * returned instead, and each is checked against the registry — the same
 * constant-time digest comparison, so trying two costs nothing and leaks
 * nothing.
 *
 * The base64 payload is decoded as UTF-8 because RFC 7617 defines that charset
 * and the challenge this endpoint sends advertises it.
 */
function readBasicCredentials(c: AppContext): BasicCredentials[] {
  const header = c.req.header("authorization");
  const scheme = header ? BASIC_SCHEME.exec(header) : null;
  if (!header || !scheme) return [];

  let decoded: string;
  try {
    const binary = atob(header.slice(scheme[0].length).trim());
    decoded = new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a malformed Basic header is
    // "no credentials presented", which the caller turns into invalid_client.
    return [];
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return [];
  const literal: BasicCredentials = {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };

  const clientId = formUrlDecode(literal.clientId);
  const clientSecret = formUrlDecode(literal.clientSecret);
  if (
    clientId === null ||
    clientSecret === null ||
    (clientId === literal.clientId && clientSecret === literal.clientSecret)
  ) {
    return [literal];
  }
  return [literal, { clientId, clientSecret }];
}

function formValue(body: Record<string, unknown>, name: string): string | null {
  const raw = body[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function invalidClient(c: AppContext) {
  return c.json(
    oidcTokenErrorBody("invalid_client", "Client authentication failed."),
    401,
    { ...NO_STORE, "WWW-Authenticate": 'Basic realm="oidc", charset="UTF-8"' },
  );
}

function invalidGrant(c: AppContext) {
  // One opaque outcome for every binding failure: an attacker holding a stolen
  // code must not learn which check rejected it.
  return c.json(
    oidcTokenErrorBody(
      "invalid_grant",
      "The authorization code is invalid or expired.",
    ),
    400,
    NO_STORE,
  );
}

/**
 * A failed client authentication, audited. The wire response stays the single
 * opaque `invalid_client`; the audit event carries WHICH check refused, because
 * a run of these against one client id is a secret being brute-forced and the
 * uniform response deliberately hides that from everyone but this trail.
 * Metadata is names only — never the presented secret, never a code.
 */
async function refuseClient(c: AppContext, reason: string): Promise<Response> {
  await emitOidcAudit(c, {
    action: "oidc.token",
    result: "failure",
    metadata: { error: "invalid_client", reason },
  });
  return invalidClient(c);
}

/**
 * A failed grant redemption, audited. Same shape as `refuseClient`: the relying
 * party sees one opaque `invalid_grant` for every binding failure, and the
 * audit trail keeps the real reason — a replayed code and a redirect_uri
 * mismatch are different incidents. The `code` itself is never recorded.
 */
async function refuseGrant(
  c: AppContext,
  reason: string,
  context: { clientId: string; userId?: string; orgId?: string },
): Promise<Response> {
  await emitOidcAudit(c, {
    action: "oidc.token",
    result: "failure",
    userId: context.userId,
    orgId: context.orgId,
    metadata: {
      error: "invalid_grant",
      reason,
      client_id: context.clientId,
    },
  });
  return invalidGrant(c);
}

/** RFC 6749 §5.2: a parameter the grant cannot be processed without is absent. */
function invalidRequest(c: AppContext, description: string) {
  return c.json(
    oidcTokenErrorBody("invalid_request", description),
    400,
    NO_STORE,
  );
}

/**
 * The provider cannot answer right now — a wiped signing secret, an unreachable
 * store, a registry that will not load.
 *
 * This is NOT an RFC 6749 §5.2 error response. That section defines the 400/401
 * protocol failures and closes their code set, and no code in it means "retry
 * later": returning `temporarily_unavailable` or any other authorization-endpoint
 * code here hands a relying party a token error it has no case for, and the
 * usual handling is to treat an unrecognized code as permanent and discard a
 * login that would have worked seconds later. The availability signal belongs to
 * HTTP, so it is carried by 503 plus `Retry-After`, and the body deliberately
 * has no `error` member for a relying party to match against.
 */
function serviceUnavailable(c: AppContext, description: string) {
  return c.json({ error_description: description }, 503, {
    ...NO_STORE,
    "Retry-After": "5",
  });
}

function requireConfig(c: AppContext): OidcConfig | Response {
  if (!isOidcEnabled(c.env)) {
    return c.json({ error: "not_found" }, 404);
  }
  const config = resolveOidcConfig(c.env);
  if (!config) {
    // The relying party only ever sees the 404, so the reason has to land in
    // the log or a bad issuer looks like a route that was never deployed.
    logger.error("[oidc] token unavailable", {
      reason: describeOidcConfigFailure(c.env),
    });
    return c.json({ error: "not_found" }, 404);
  }
  if (new URL(c.req.url).host.toLowerCase() !== config.issuerHost) {
    return c.json({ error: "not_found" }, 404);
  }
  if (!isOidcSigningConfigured()) {
    logger.error(
      "[oidc] token unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return serviceUnavailable(c, "The identity provider is not configured.");
  }
  return config;
}

/**
 * Resolve and authenticate the client from either supported auth method, over
 * every reading of the presented credential (see `readBasicCredentials`).
 */
async function authenticateClient(
  c: AppContext,
  body: Record<string, unknown>,
): Promise<OidcClient | null> {
  const presented = readBasicCredentials(c);
  if (presented.length === 0) {
    const clientId = formValue(body, "client_id");
    const clientSecret = formValue(body, "client_secret");
    if (!clientId || !clientSecret) return null;
    presented.push({ clientId, clientSecret });
  }

  for (const candidate of presented) {
    const client = getOidcClient(candidate.clientId);
    if (!client) continue;
    if (await verifyOidcClientSecret(client, candidate.clientSecret)) {
      return client;
    }
  }
  return null;
}

app.post("/", async (c) => {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  let body: Record<string, unknown>;
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unparseable body is an
    // invalid request, not a server fault.
    return invalidRequest(
      c,
      "Expected an application/x-www-form-urlencoded body.",
    );
  }

  try {
    // Both supported client-auth methods are accepted because Go's oauth2
    // client (under Forgejo/goth) auto-detects: it probes Basic first and
    // retries with form parameters, so supporting only one fails intermittently.
    const client = await authenticateClient(c, body);
    if (!client) return await refuseClient(c, "client_authentication_failed");

    // RFC 6749 §5.2 separates a request that is MALFORMED from a grant that is
    // bad, and the difference is actionable: `invalid_request` tells a relying
    // party its own token call is wrong, while `invalid_grant` tells it the
    // code it holds is dead and sends it back through /authorize. Answering a
    // missing parameter with `invalid_grant` sends it round that loop forever.
    const grantType = formValue(body, "grant_type");
    if (!grantType) return invalidRequest(c, "grant_type is required.");
    if (grantType !== "authorization_code") {
      return c.json(
        oidcTokenErrorBody(
          "unsupported_grant_type",
          "Only authorization_code is supported.",
        ),
        400,
        NO_STORE,
      );
    }

    const code = formValue(body, "code");
    if (!code) return invalidRequest(c, "code is required.");
    // Always sent at /authorize and always recorded on the grant, so RFC 6749
    // §4.1.3 makes it required here. Checked before the burn: absence is a
    // client-side defect that reveals nothing about any stored code, while a
    // MISMATCH is a binding failure and stays inside the opaque invalid_grant.
    const redirectUri = formValue(body, "redirect_uri");
    if (!redirectUri) return invalidRequest(c, "redirect_uri is required.");

    // Atomic burn. Exactly one of any concurrent set of presenters gets the
    // row; replays and race losers get null.
    const grant = await consumeOidcAuthorizationCode(code);
    // Every refusal below the burn is audited with the client and (once known)
    // the user, so a replayed code or a probing client leaves a trail even
    // though the wire answer stays uniform.
    const refusal = { clientId: client.client_id };
    if (!grant) return await refuseGrant(c, "code_unknown_or_expired", refusal);

    if (grant.clientId !== client.client_id) {
      return await refuseGrant(c, "client_mismatch", refusal);
    }
    const bound = {
      clientId: client.client_id,
      userId: grant.userId,
    };
    if (grant.redirectUri !== redirectUri) {
      return await refuseGrant(c, "redirect_uri_mismatch", bound);
    }

    if (grant.codeChallenge) {
      // `code_verifier` stays inside invalid_grant even when it is absent:
      // whether one is required is a property of the burned code, so a
      // distinct error here would tell a stolen-code holder that the code it
      // just destroyed was PKCE-bound.
      const verifier = formValue(body, "code_verifier");
      if (!verifier) {
        return await refuseGrant(c, "pkce_verifier_missing", bound);
      }
      if ((await sha256Base64Url(verifier)) !== grant.codeChallenge) {
        return await refuseGrant(c, "pkce_verifier_mismatch", bound);
      }
    }

    // The user could have signed out inside the code's 60-second window; a
    // marker-store failure throws to the boundary below (503), never "not
    // logged out".
    if (
      await isBlockedBySsoBridgeLogout(grant.stewardUserId, grant.tokenIssuedAt)
    ) {
      return await refuseGrant(c, "signed_out_after_authorize", bound);
    }

    // Claims are rebuilt from LIVE rows rather than a snapshot taken at
    // authorize, so a mid-window deactivation fails the exchange.
    const subject = await loadOidcSubject(grant.userId);
    if (!subject) return await refuseGrant(c, "subject_missing", bound);
    const ineligible = assertOidcSubjectEligible(subject, client);
    if (ineligible) {
      return await refuseGrant(c, ineligible, {
        ...bound,
        orgId: subject.user.organization_id ?? undefined,
      });
    }

    const username = await resolveOidcUsername({
      id: subject.user.id,
      nickname: subject.user.nickname,
      name: subject.user.name,
      email: subject.user.email,
    });
    const scopes = grant.scope.split(" ").filter(Boolean);
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
      scopes,
      client,
    });

    const now = new Date();
    const [idToken, accessToken] = await Promise.all([
      mintOidcIdToken({
        issuer: config.issuer,
        clientId: client.client_id,
        subject: subject.user.id,
        nonce: grant.nonce,
        ttlSeconds: client.id_token_ttl_seconds,
        claims,
        now,
      }),
      mintOidcAccessToken({
        issuer: config.issuer,
        clientId: client.client_id,
        subject: subject.user.id,
        audiences: client.resource_audiences,
        scope: grant.scope,
        ttlSeconds: client.access_token_ttl_seconds,
        claims,
        now,
      }),
    ]);

    logger.info("[oidc] token issued", { client_id: client.client_id });
    await emitOidcAudit(c, {
      action: "oidc.token",
      result: "success",
      userId: subject.user.id,
      orgId: subject.user.organization_id ?? undefined,
      metadata: { client_id: client.client_id, scope: grant.scope },
    });

    return c.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: client.access_token_ttl_seconds,
        id_token: idToken,
        scope: grant.scope,
      },
      200,
      NO_STORE,
    );
  } catch (error) {
    // error-policy:J1 route boundary — a store, registry, or key failure
    // becomes a structured 503 the relying party can retry, never a 400 that
    // would make it discard a still-valid login attempt as the user's fault.
    logger.error("[oidc] token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return serviceUnavailable(c, "Token exchange is temporarily unavailable.");
  }
});

export default app;
