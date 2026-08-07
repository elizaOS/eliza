/**
 * GET /api/oidc/authorize and GET /api/oidc/authorize/resume — the
 * authorization-code endpoint of the Eliza Cloud OpenID Provider.
 *
 * ORDER IS THE SECURITY PROPERTY. The client is resolved and the `redirect_uri`
 * is exact-matched against its registry entry BEFORE anything else, and an
 * unknown client or unregistered URI renders a terminal error page rather than
 * redirecting. Redirecting an error to an unvalidated URI is how a trusted host
 * becomes an open redirector; every later failure may redirect precisely
 * because the destination has already been proven registered.
 *
 * The session is resolved from the Steward COOKIE only (`lib/oidc/session.ts`)
 * — never `getCurrentUser`, which would accept a Bearer and JIT-create an
 * account inside a redirect. Signed-out requests park the already-validated
 * request in Postgres and bounce through the SPA login page, because the login
 * page's `returnTo` accepts only same-origin paths and cannot carry an absolute
 * authorize URL; `/resume` picks the request back up by opaque id.
 *
 * There is no consent screen: the registry holds a small fixed set of
 * first-party confidential clients. Any first-party page able to cause a
 * top-level navigation therefore produces a relying-party login silently.
 */

import { Hono } from "hono";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  getOidcClient,
  intersectScopes,
  isRegisteredRedirectUri,
  type OidcClient,
} from "@/lib/oidc/clients";
import {
  issueOidcAuthorizationCode,
  parkOidcAuthorizationRequest,
  resumeOidcAuthorizationRequest,
} from "@/lib/oidc/codes";
import {
  isOidcEnabled,
  OIDC_CONTINUE_PATH,
  type OidcConfig,
  resolveOidcConfig,
} from "@/lib/oidc/config";
import {
  buildOidcErrorRedirect,
  type OidcErrorCode,
  renderOidcErrorPage,
} from "@/lib/oidc/errors";
import { isOidcSigningConfigured } from "@/lib/oidc/keys";
import { resolveOidcSession } from "@/lib/oidc/session";
import { assertOidcSubjectEligible, loadOidcSubject } from "@/lib/oidc/subject";
import { resolveOidcUsername } from "@/lib/oidc/username";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { emitOidcAudit } from "../audit";

const app = new Hono<AppEnv>();

/**
 * STANDARD (60/min/IP), not STRICT: `/authorize` is a human login step and a
 * shared-NAT office would trip a 10/min ceiling. Redis loss keeps login
 * available but bounded per-isolate, matching the steward-session precedent.
 */
app.use(
  rateLimit({
    ...RateLimitPresets.STANDARD,
    keyGenerator: getIpKey,
    failClosed: true,
    redisUnavailableFallback: { namespace: "oidc-authorize" },
  }),
);

interface AuthorizeRequest {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  scope: string | null;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  prompt: string | null;
}

/** A request whose client and redirect URI are already proven registered. */
interface ValidatedRequest {
  client: OidcClient;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  prompt: string | null;
}

function htmlError(
  c: AppContext,
  status: 400 | 404 | 503,
  title: string,
  detail: string,
) {
  return c.html(renderOidcErrorPage(title, detail), status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
}

function redirectError(
  c: AppContext,
  validated: Pick<ValidatedRequest, "redirectUri" | "state">,
  error: OidcErrorCode,
  description: string,
) {
  const target = buildOidcErrorRedirect(
    validated.redirectUri,
    error,
    description,
    validated.state,
  );
  return c.redirect(target, 302);
}

function readQuery(c: AppContext): AuthorizeRequest {
  const q = c.req.query();
  const value = (name: string): string | null => {
    const raw = q[name];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  };
  return {
    clientId: value("client_id"),
    redirectUri: value("redirect_uri"),
    responseType: value("response_type"),
    scope: value("scope"),
    state: value("state"),
    nonce: value("nonce"),
    codeChallenge: value("code_challenge"),
    codeChallengeMethod: value("code_challenge_method"),
    prompt: value("prompt"),
  };
}

/**
 * Resolve the deployment config and refuse any host but the issuer's. The
 * Worker answers a wildcard subdomain route, so this is what keeps the
 * authorization endpoint off hosts that serve user-controlled content.
 */
function requireConfig(c: AppContext): OidcConfig | Response {
  if (!isOidcEnabled(c.env)) {
    return htmlError(c, 404, "Not found", "This endpoint is not available.");
  }
  const config = resolveOidcConfig(c.env);
  if (!config) {
    logger.error(
      "[oidc] authorize unavailable: OIDC_ISSUER_URL is missing or unusable",
    );
    return htmlError(
      c,
      503,
      "Sign-in unavailable",
      "The identity provider is not configured. Please try again later.",
    );
  }
  if (new URL(c.req.url).host.toLowerCase() !== config.issuerHost) {
    return htmlError(
      c,
      404,
      "Not found",
      "This endpoint is not available on this host.",
    );
  }
  if (!isOidcSigningConfigured()) {
    logger.error(
      "[oidc] authorize unavailable: OIDC_SIGNING_JWKS is not configured",
    );
    return htmlError(
      c,
      503,
      "Sign-in unavailable",
      "The identity provider is not configured. Please try again later.",
    );
  }
  return config;
}

/**
 * Validate an incoming request far enough to know WHERE errors may be sent.
 * Returns a Response for the two failures that must never redirect.
 */
function validateRequest(
  c: AppContext,
  request: AuthorizeRequest,
): ValidatedRequest | Response {
  let client: OidcClient | null;
  try {
    client = getOidcClient(request.clientId);
  } catch (error) {
    // error-policy:J1 boundary translation — an unparseable registry secret is
    // a deploy fault, not a client fault, and must not look like a bad request.
    logger.error("[oidc] client registry unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return htmlError(
      c,
      503,
      "Sign-in unavailable",
      "The identity provider is not configured. Please try again later.",
    );
  }

  if (!client) {
    return htmlError(
      c,
      400,
      "Unknown application",
      "This application is not registered with Eliza Cloud.",
    );
  }
  if (!isRegisteredRedirectUri(client, request.redirectUri)) {
    // Never redirect here: the destination has not been proven to belong to
    // the client, so echoing an error to it would be an open redirect.
    return htmlError(
      c,
      400,
      "Invalid redirect URI",
      "The redirect URI does not match one registered for this application.",
    );
  }

  const redirectUri = request.redirectUri as string;
  const base = { redirectUri, state: request.state };

  if (request.responseType !== "code") {
    return redirectError(
      c,
      base,
      "unsupported_response_type",
      "Only the authorization code flow is supported.",
    );
  }

  const requestedScopes = (request.scope ?? "").split(/\s+/).filter(Boolean);
  const granted = intersectScopes(client, requestedScopes);
  if (!granted.includes("openid")) {
    return redirectError(
      c,
      base,
      "invalid_scope",
      "The openid scope is required and must be permitted for this application.",
    );
  }

  if (request.codeChallenge) {
    // The RFC 7636 default when a challenge is present without a method is
    // `plain`, which offers no protection; require S256 explicitly.
    if (request.codeChallengeMethod !== "S256") {
      return redirectError(
        c,
        base,
        "invalid_request",
        "Only the S256 code_challenge_method is supported.",
      );
    }
  } else if (client.require_pkce) {
    return redirectError(
      c,
      base,
      "invalid_request",
      "This application must use PKCE.",
    );
  }

  if (!request.state && !request.codeChallenge) {
    // The relying party must bind its callback to its own request by one
    // mechanism or the other; accepting neither leaves it open to CSRF.
    return redirectError(
      c,
      base,
      "invalid_request",
      "Either state or PKCE is required.",
    );
  }

  return {
    client,
    redirectUri,
    scope: granted.join(" "),
    state: request.state,
    nonce: request.nonce,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallenge ? "S256" : null,
    prompt: request.prompt,
  };
}

/** Complete a validated request against the browser's current session. */
async function completeAuthorization(
  c: AppContext,
  config: OidcConfig,
  validated: ValidatedRequest,
  options: { allowLoginBounce: boolean },
): Promise<Response> {
  const outcome = await resolveOidcSession(c);

  if (outcome.status !== "authenticated") {
    if (validated.prompt === "none") {
      return redirectError(
        c,
        validated,
        "login_required",
        "No Eliza Cloud session is present.",
      );
    }
    if (!options.allowLoginBounce) {
      // Reached from /resume: the browser has already been through login and
      // still has no session. Bouncing again would loop.
      return htmlError(
        c,
        400,
        "Sign-in did not complete",
        "Please return to the application and start sign-in again.",
      );
    }
    return await bounceThroughLogin(c, config, validated);
  }

  const subject = await loadOidcSubject(outcome.session.userId);
  if (!subject) {
    return redirectError(
      c,
      validated,
      "access_denied",
      "The account is unavailable.",
    );
  }

  const ineligible = assertOidcSubjectEligible(subject, validated.client);
  if (ineligible) {
    logger.warn("[oidc] authorization refused", {
      client_id: validated.client.client_id,
      reason: ineligible,
    });
    await emitOidcAudit(c, {
      action: "oidc.authorize.denied",
      result: "failure",
      userId: subject.user.id,
      orgId: subject.user.organization_id ?? undefined,
      metadata: { client_id: validated.client.client_id, reason: ineligible },
    });
    return redirectError(c, validated, "access_denied", ineligible);
  }

  // Freeze the username here rather than at redemption, for its side effect:
  // an allocation failure then surfaces on the browser-facing leg, where a
  // human can be shown an error, instead of on the back-channel token call.
  await resolveOidcUsername({
    id: subject.user.id,
    nickname: subject.user.nickname,
    name: subject.user.name,
    email: subject.user.email,
  });

  const issued = await issueOidcAuthorizationCode({
    clientId: validated.client.client_id,
    userId: subject.user.id,
    stewardUserId: outcome.session.stewardUserId,
    redirectUri: validated.redirectUri,
    scope: validated.scope,
    nonce: validated.nonce,
    codeChallenge: validated.codeChallenge,
    codeChallengeMethod: validated.codeChallengeMethod,
    authTime: outcome.session.authTime,
    tokenIssuedAt: outcome.session.issuedAt,
  });

  logger.info("[oidc] authorization code issued", {
    client_id: validated.client.client_id,
  });
  await emitOidcAudit(c, {
    action: "oidc.authorize",
    result: "success",
    userId: subject.user.id,
    orgId: subject.user.organization_id ?? undefined,
    metadata: {
      client_id: validated.client.client_id,
      scope: validated.scope,
    },
  });

  const target = new URL(validated.redirectUri);
  target.searchParams.set("code", issued.code);
  if (validated.state !== null)
    target.searchParams.set("state", validated.state);
  return c.redirect(target.toString(), 302);
}

/**
 * Park the validated request and send the browser to the SPA login page. The
 * login page sanitizes `returnTo` to a same-origin PATH, so the round trip
 * carries only an opaque request id; `/oidc/continue` bounces it back here.
 */
async function bounceThroughLogin(
  c: AppContext,
  config: OidcConfig,
  validated: ValidatedRequest,
): Promise<Response> {
  const parked = await parkOidcAuthorizationRequest({
    clientId: validated.client.client_id,
    redirectUri: validated.redirectUri,
    scope: validated.scope,
    state: validated.state,
    nonce: validated.nonce,
    codeChallenge: validated.codeChallenge,
    codeChallengeMethod: validated.codeChallengeMethod,
  });

  const returnTo = `${OIDC_CONTINUE_PATH}?rid=${encodeURIComponent(parked.requestId)}`;
  const loginUrl = new URL("/login", `${config.appOrigin}/`);
  loginUrl.searchParams.set("returnTo", returnTo);
  return c.redirect(loginUrl.toString(), 302);
}

app.get("/", async (c) => {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  const validated = validateRequest(c, readQuery(c));
  if (validated instanceof Response) return validated;

  try {
    return await completeAuthorization(c, config, validated, {
      allowLoginBounce: true,
    });
  } catch (error) {
    // error-policy:J1 route boundary — a store or key failure becomes a
    // structured error for the relying party rather than a leaked stack.
    logger.error("[oidc] authorize failed", {
      client_id: validated.client.client_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return redirectError(
      c,
      validated,
      "server_error",
      "Sign-in is temporarily unavailable.",
    );
  }
});

/**
 * Resume a parked request after login. The request is claimed atomically
 * (single use), then re-checked against the CURRENT registry — a client
 * removed or a redirect URI unregistered during the login round trip must not
 * still be honored.
 */
app.get("/resume", async (c) => {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  const requestId = c.req.query("rid");
  if (!requestId) {
    return htmlError(
      c,
      400,
      "Sign-in request missing",
      "Please start sign-in again.",
    );
  }

  try {
    const parked = await resumeOidcAuthorizationRequest(requestId);
    if (!parked) {
      return htmlError(
        c,
        400,
        "Sign-in request expired",
        "Please return to the application and start sign-in again.",
      );
    }

    const client = getOidcClient(parked.clientId);
    if (!client || !isRegisteredRedirectUri(client, parked.redirectUri)) {
      return htmlError(
        c,
        400,
        "Application no longer registered",
        "This application can no longer sign users in through Eliza Cloud.",
      );
    }

    return await completeAuthorization(
      c,
      config,
      {
        client,
        redirectUri: parked.redirectUri,
        scope: parked.scope,
        state: parked.state,
        nonce: parked.nonce,
        codeChallenge: parked.codeChallenge,
        codeChallengeMethod: parked.codeChallengeMethod,
        prompt: null,
      },
      { allowLoginBounce: false },
    );
  } catch (error) {
    // error-policy:J1 route boundary — the parked request is already consumed,
    // so there is nothing to retry; show a terminal page instead of looping.
    logger.error("[oidc] authorize resume failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return htmlError(
      c,
      503,
      "Sign-in unavailable",
      "Please return to the application and try again.",
    );
  }
});

export default app;
