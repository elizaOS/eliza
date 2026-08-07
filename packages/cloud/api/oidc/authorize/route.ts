/**
 * GET|POST /api/oidc/authorize and GET /api/oidc/authorize/resume — the
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
 * That id is a URL parameter, and a URL parameter is not a browser. Parking
 * therefore also hands the browser a per-request binding cookie and stores only
 * its digest (`lib/oidc/request-binding.ts`); `/resume` recomputes the digest
 * from the presenting browser and refuses a mismatch, so an id captured from a
 * log, a Referer, or a shared link cannot complete somebody else's pending
 * authorization.
 *
 * Parking is also the one unauthenticated WRITE on this endpoint, so the posted
 * body and every free-text parameter are size-bounded before anything reaches
 * the store, and `code_challenge` is held to the exact shape a SHA-256 digest
 * has rather than being persisted as whatever text arrived.
 *
 * There is no consent screen: the registry holds a small fixed set of
 * first-party confidential clients. Any first-party page able to cause a
 * top-level navigation therefore produces a relying-party login silently.
 * There is no authentication screen of this endpoint's own either, so the
 * `prompt` and `max_age` values that ask for a fresh login, a consent step, or
 * an account chooser are refused with the matching OpenID Connect error rather
 * than answered out of the existing session (`lib/oidc/authentication-request`).
 */

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  getIpKey,
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { resolveOidcAuthenticationPolicy } from "@/lib/oidc/authentication-request";
import {
  getOidcClient,
  intersectScopes,
  isRegisteredRedirectUri,
  type OidcClient,
} from "@/lib/oidc/clients";
import {
  issueOidcAuthorizationCode,
  looksLikeOidcRequestId,
  OIDC_REQUEST_TTL_SECONDS,
  parkOidcAuthorizationRequest,
  resumeOidcAuthorizationRequest,
} from "@/lib/oidc/codes";
import {
  describeOidcConfigFailure,
  isOidcEnabled,
  OIDC_CONTINUE_PATH,
  OIDC_RESUME_PATH,
  type OidcConfig,
  resolveOidcConfig,
} from "@/lib/oidc/config";
import {
  buildOidcErrorRedirect,
  type OidcErrorCode,
  renderOidcErrorPage,
} from "@/lib/oidc/errors";
import { isOidcSigningConfigured } from "@/lib/oidc/keys";
import {
  computeOidcRequestBindingHash,
  createOidcRequestBindingSecret,
  matchesOidcRequestBinding,
  oidcRequestBindingCookieName,
} from "@/lib/oidc/request-binding";
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

/** The one serialization OpenID Connect Core 3.1.2.1 defines for a POST. */
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/**
 * Ceiling on a posted request body. The GET leg is bounded by whatever URL
 * length the edge accepts; the POST leg has no such implicit bound, and an
 * unauthenticated caller reaching a registered client can cause `state`,
 * `nonce`, and the challenge to be PERSISTED for the parked-request TTL. A
 * real authorization request is a few hundred bytes.
 */
const MAX_AUTHORIZE_BODY_BYTES = 8 * 1024;

/**
 * Ceiling on each free-text parameter, applied after the client and redirect
 * URI are proven so an over-long value is a redirected `invalid_request` rather
 * than a terminal page. `client_id` and `redirect_uri` need no bound of their
 * own: both are exact-matched against the registry, so an oversized value is
 * simply unregistered.
 */
const MAX_AUTHORIZE_PARAMETER_LENGTH = 2048;

/**
 * An RFC 7636 S256 challenge is `base64url(sha256(verifier))` with no padding:
 * 32 bytes, therefore exactly 43 characters from the base64url alphabet. Any
 * other shape cannot be a digest, so it can only be a `plain` challenge wearing
 * the S256 label, junk that will fail every redemption after the user has
 * already signed in, or padding this endpoint would persist verbatim.
 */
const S256_CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

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
  maxAge: string | null;
}

/**
 * The parameters bounded by raw length, under their wire names so a refusal
 * names what the sender wrote. `client_id` and `redirect_uri` are absent by
 * design (exact-matched against the registry, so an oversized value is simply
 * unregistered), and so is `code_challenge`, which is held to an exact shape.
 */
function lengthBoundedParameters(
  request: AuthorizeRequest,
): ReadonlyArray<readonly [string, string | null]> {
  return [
    ["scope", request.scope],
    ["state", request.state],
    ["nonce", request.nonce],
    ["prompt", request.prompt],
    ["max_age", request.maxAge],
    ["code_challenge_method", request.codeChallengeMethod],
  ];
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
  /** `prompt=none`: complete without interaction or fail. */
  promptNone: boolean;
}

function htmlError(
  c: AppContext,
  status: 400 | 404 | 413 | 503,
  title: string,
  detail: string,
) {
  return c.html(renderOidcErrorPage(title, detail), status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
}

/**
 * Every authorization response is a redirect carrying session-derived data —
 * an authorization code, or the error and `state` of one user's attempt — so
 * none of them may be retained by a shared cache or a browser's back-forward
 * store (RFC 6749 5.1, OpenID Connect Core 3.1.2.5).
 */
function redirectNoStore(c: AppContext, target: string): Response {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.redirect(target, 302);
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
  return redirectNoStore(c, target);
}

function readParameters(
  read: (name: string) => string | null,
): AuthorizeRequest {
  return {
    clientId: read("client_id"),
    redirectUri: read("redirect_uri"),
    responseType: read("response_type"),
    scope: read("scope"),
    state: read("state"),
    nonce: read("nonce"),
    codeChallenge: read("code_challenge"),
    codeChallengeMethod: read("code_challenge_method"),
    prompt: read("prompt"),
    maxAge: read("max_age"),
  };
}

/**
 * Read the request parameters from wherever this method carries them: OpenID
 * Connect Core 3.1.2.1 requires BOTH methods at the authorization endpoint, GET
 * with query-string serialization and POST with form serialization. A relying
 * party picks POST when the request is large enough to risk a URL length limit,
 * or to keep parameters out of proxy and browser-history logs.
 *
 * The posted body is size-capped before it is parsed. Nothing has authenticated
 * at this point and a signed-out request is PERSISTED, so an unbounded body is
 * an unauthenticated write of arbitrary size into `oidc_authorization_requests`.
 */
async function readAuthorizeRequest(
  c: AppContext,
): Promise<AuthorizeRequest | Response> {
  if (c.req.method !== "POST") {
    const query = c.req.query();
    return readParameters((name) => {
      const raw = query[name];
      return typeof raw === "string" && raw.length > 0 ? raw : null;
    });
  }

  const mediaType = (c.req.header("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    return htmlError(
      c,
      400,
      "Invalid sign-in request",
      `A posted authorization request must be ${FORM_MEDIA_TYPE}.`,
    );
  }

  const oversized = (): Response =>
    htmlError(
      c,
      413,
      "Sign-in request too large",
      "The authorization request exceeds the size this endpoint accepts.",
    );
  // An absent or malformed header reads as NaN and simply falls through to the
  // decoded-text check below; it is a hint, not the authority.
  const declaredLength = Number(c.req.header("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_AUTHORIZE_BODY_BYTES
  ) {
    return oversized();
  }

  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unreadable body cannot
    // name a client, so there is no proven redirect URI to send an error to.
    return htmlError(
      c,
      400,
      "Invalid sign-in request",
      "The authorization request could not be read.",
    );
  }
  // A chunked sender declares no length, so the decoded text is re-checked.
  // Form serialization is percent-encoded ASCII, making characters and bytes
  // the same count for any body this endpoint is meant to accept.
  if (raw.length > MAX_AUTHORIZE_BODY_BYTES) return oversized();

  const body = new URLSearchParams(raw);
  return readParameters((name) => {
    const value = body.get(name);
    return value !== null && value.length > 0 ? value : null;
  });
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
    logger.error("[oidc] authorize unavailable", {
      reason: describeOidcConfigFailure(c.env),
    });
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

  // Now that the destination is proven registered, an over-long parameter can
  // be reported to the relying party instead of terminating in place. `state`
  // and `nonce` are echoed and PERSISTED verbatim across the login round trip,
  // so this is what stops an unauthenticated caller parking arbitrarily large
  // rows. The description names no value: it goes into a redirect the relying
  // party renders.
  for (const [name, value] of lengthBoundedParameters(request)) {
    if (value !== null && value.length > MAX_AUTHORIZE_PARAMETER_LENGTH) {
      return redirectError(
        c,
        base,
        "invalid_request",
        `The ${name} parameter exceeds ${MAX_AUTHORIZE_PARAMETER_LENGTH} characters.`,
      );
    }
  }

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
    // The method alone does not make the value a digest. Redemption compares
    // this string against `base64url(sha256(verifier))`, so a challenge of any
    // other shape can only fail there — after the user has signed in and the
    // code has been burned. Refusing it here is the only point at which the
    // relying party still has a usable error.
    if (!S256_CODE_CHALLENGE_RE.test(request.codeChallenge)) {
      return redirectError(
        c,
        base,
        "invalid_request",
        "code_challenge must be the unpadded base64url encoding of a SHA-256 digest.",
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

  // `prompt` and `max_age` say HOW the user must be authenticated. This
  // provider cannot authenticate anyone itself, so anything it cannot satisfy
  // is refused here rather than answered with a reused session.
  const authentication = resolveOidcAuthenticationPolicy({
    prompt: request.prompt,
    maxAge: request.maxAge,
  });
  if (authentication.status === "rejected") {
    return redirectError(
      c,
      base,
      authentication.error,
      authentication.description,
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
    promptNone: authentication.policy.promptNone,
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
    if (validated.promptNone) {
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
  return redirectNoStore(c, target.toString());
}

/**
 * The browser half of a parked request's binding: an opaque secret in a cookie
 * this endpoint's own path can read back, plus the user agent that started the
 * flow. `Lax` is required rather than merely tolerated — `/resume` is reached by
 * a top-level navigation from the console origin, and `Strict` would withhold
 * the cookie there and fail every real sign-in.
 */
function issueRequestBindingCookie(
  c: AppContext,
  requestId: string,
  secret: string,
): void {
  setCookie(c, oidcRequestBindingCookieName(requestId), secret, {
    httpOnly: true,
    secure: c.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: OIDC_RESUME_PATH,
    maxAge: OIDC_REQUEST_TTL_SECONDS,
  });
}

function readRequestBinding(
  c: AppContext,
  requestId: string,
): { secret: string; userAgent: string | null } | null {
  const secret = getCookie(c, oidcRequestBindingCookieName(requestId));
  if (!secret) return null;
  return { secret, userAgent: c.req.header("user-agent") ?? null };
}

/**
 * Park the validated request and send the browser to the SPA login page. The
 * login page sanitizes `returnTo` to a same-origin PATH, so the round trip
 * carries only an opaque request id; `/oidc/continue` bounces it back here.
 *
 * The id alone is not enough to resume: the request is stored with the digest
 * of this browser's binding, and the browser keeps the only copy of the secret.
 */
async function bounceThroughLogin(
  c: AppContext,
  config: OidcConfig,
  validated: ValidatedRequest,
): Promise<Response> {
  const secret = createOidcRequestBindingSecret();
  const parked = await parkOidcAuthorizationRequest({
    clientId: validated.client.client_id,
    redirectUri: validated.redirectUri,
    scope: validated.scope,
    state: validated.state,
    nonce: validated.nonce,
    codeChallenge: validated.codeChallenge,
    codeChallengeMethod: validated.codeChallengeMethod,
    bindingHash: await computeOidcRequestBindingHash({
      secret,
      userAgent: c.req.header("user-agent") ?? null,
    }),
  });
  issueRequestBindingCookie(c, parked.requestId, secret);

  const returnTo = `${OIDC_CONTINUE_PATH}?rid=${encodeURIComponent(parked.requestId)}`;
  const loginUrl = new URL("/login", `${config.appOrigin}/`);
  loginUrl.searchParams.set("returnTo", returnTo);
  return redirectNoStore(c, loginUrl.toString());
}

async function handleAuthorize(c: AppContext): Promise<Response> {
  const config = requireConfig(c);
  if (config instanceof Response) return config;

  const request = await readAuthorizeRequest(c);
  if (request instanceof Response) return request;

  const validated = validateRequest(c, request);
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
}

app.get("/", handleAuthorize);
/**
 * The POST leg is not optional (OpenID Connect Core 3.1.2.1) and is the safer
 * of the two: `SameSite=Lax` withholds the session cookie from a cross-site
 * POST, so a request forged by another site resolves as signed out and bounces
 * to login instead of silently minting a relying-party session.
 */
app.post("/", handleAuthorize);

/**
 * Resume a parked request after login. The request is claimed atomically
 * (single use), the presenting browser is proven to be the one that parked it,
 * and the client is then re-checked against the CURRENT registry — a client
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
    // An id that is not in the opaque form names no cookie and claims no row,
    // so both halves below simply see nothing to resume.
    const named = looksLikeOidcRequestId(requestId);
    const presented = named ? readRequestBinding(c, requestId) : null;
    const parked = await resumeOidcAuthorizationRequest(requestId);
    if (named) {
      // The cookie is single-use like the request it binds, so it goes whatever
      // the outcome rather than lingering for the rest of its TTL.
      deleteCookie(c, oidcRequestBindingCookieName(requestId), {
        path: OIDC_RESUME_PATH,
      });
    }
    if (!parked) {
      return htmlError(
        c,
        400,
        "Sign-in request expired",
        "Please return to the application and start sign-in again.",
      );
    }

    if (!(await matchesOidcRequestBinding(parked.bindingHash, presented))) {
      // A different browser presented this id: it leaked, or the flow was
      // started somewhere else. The row is already destroyed, so the id cannot
      // be probed again, and the wording is the same as an expired request so
      // the holder learns nothing about which it was.
      logger.warn("[oidc] authorize resume refused: request binding mismatch", {
        client_id: parked.clientId,
      });
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
        // `prompt=none` never reaches a parked request: it is refused on the
        // first leg, where the absent session is what it asked about. Nothing
        // else survives the round trip because nothing else is satisfiable.
        promptNone: false,
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
