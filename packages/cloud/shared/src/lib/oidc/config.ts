/**
 * Deployment configuration for the OpenID Connect provider: the issuer string,
 * the endpoint paths derived from it, and the kill switch.
 *
 * The issuer is read VERBATIM from `OIDC_ISSUER_URL` and never derived from the
 * request `Host`. Two consumers make that load-bearing: Merge Steward hard-fails
 * unless the discovery document's `issuer` byte-equals its configured issuer,
 * and the Worker answers `*.elizacloud.ai/*` — including user-content hosts —
 * so a Host-derived issuer would let every subdomain advertise itself as a
 * valid OpenID Provider. Every endpoint therefore also runs `isIssuerHost`
 * and 404s elsewhere.
 *
 * The issuer must be a bare ORIGIN. Every endpoint below is a root-absolute
 * path concatenated onto it, and the Worker really does serve them from the
 * host root, so an issuer carrying a path would advertise URLs that 404 — and
 * `https://api.example/oidc` + `/.well-known/openid-configuration` is not where
 * an RP looks for the document either. Rejecting it is the only honest answer;
 * `validateOidcIssuer` returns the reason so the operator reads a sentence
 * naming the constraint instead of a bare 503.
 *
 * `http` is accepted for LOOPBACK hosts so the provider can be run locally, on
 * `localhost`, `127.0.0.1`, or `[::1]`. Point it at the origin the BROWSER
 * reaches the Worker on and build the console with the same string as
 * `VITE_OIDC_ISSUER_URL`: the SPA sends the signed-out login bounce to the
 * issuer origin, and the two loopback names are separate cookie jars, so a
 * local deployment that mixes them drops the session on the way to `/authorize`.
 */

export const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";
export const OIDC_JWKS_PATH = "/.well-known/oidc/jwks.json";
export const OIDC_AUTHORIZE_PATH = "/api/oidc/authorize";
export const OIDC_RESUME_PATH = "/api/oidc/authorize/resume";
export const OIDC_TOKEN_PATH = "/api/oidc/token";
export const OIDC_USERINFO_PATH = "/api/oidc/userinfo";

/** SPA route that bounces a freshly-logged-in browser back to `/resume`. */
export const OIDC_CONTINUE_PATH = "/oidc/continue";

export interface OidcConfigEnv {
  OIDC_ENABLED?: unknown;
  OIDC_ISSUER_URL?: unknown;
  ELIZA_CLOUD_URL?: unknown;
  NEXT_PUBLIC_APP_URL?: unknown;
}

export interface OidcConfig {
  /** Issuer string, emitted verbatim. No trailing slash. */
  issuer: string;
  /** Lowercased host of `issuer`; every endpoint refuses other hosts. */
  issuerHost: string;
  /** Origin of the SPA that owns `/login` and `/oidc/continue`. */
  appOrigin: string;
  discoveryUrl: string;
  jwksUrl: string;
  authorizationUrl: string;
  resumeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
}

/**
 * Hosts allowed to serve the issuer over plain `http`. Ports are irrelevant to
 * cookie scope, so a console on `http://localhost:5173` and this provider on
 * `http://localhost:8787` share the Steward session cookie — but `localhost` and
 * `127.0.0.1` do NOT share it with each other, which is why a local deployment
 * has to pick one name and use it on both sides. `0.0.0.0` is deliberately
 * absent: it is a bind address, not an origin a browser should be sent to.
 */
const LOOPBACK_ISSUER_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A rejected issuer carries the sentence an operator needs to fix the deploy. */
export type OidcIssuerCheck = { ok: true; url: URL } | { ok: false; reason: string };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** The provider is OFF unless an operator explicitly turns it on. */
export function isOidcEnabled(env: OidcConfigEnv): boolean {
  return readString(env.OIDC_ENABLED) === "true";
}

/** Whether `hostname` is one this deployment may serve over plain `http`. */
export function isLoopbackIssuerHostname(hostname: string): boolean {
  return LOOPBACK_ISSUER_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Check `OIDC_ISSUER_URL` against every constraint the endpoints assume, and
 * name the violated one on failure. Kept separate from `resolveOidcConfig` so
 * the reason is a value a test and a log line can both read.
 */
export function validateOidcIssuer(raw: string): OidcIssuerCheck {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unparseable issuer yields
    // an explicit invalid result, never a usable-looking default.
    return { ok: false, reason: `OIDC_ISSUER_URL "${raw}" is not an absolute URL` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      reason: `OIDC_ISSUER_URL "${raw}" must use https (http is allowed only on ${[...LOOPBACK_ISSUER_HOSTNAMES].join(", ")})`,
    };
  }
  if (parsed.protocol === "http:" && !isLoopbackIssuerHostname(parsed.hostname)) {
    return {
      ok: false,
      reason: `OIDC_ISSUER_URL "${raw}" uses http on a non-loopback host; use https, or one of ${[...LOOPBACK_ISSUER_HOSTNAMES].join(", ")} for local development`,
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: "OIDC_ISSUER_URL must not carry credentials; it is emitted verbatim in every token",
    };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: `OIDC_ISSUER_URL "${raw}" must not carry a query or fragment` };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return {
      ok: false,
      reason: `OIDC_ISSUER_URL "${raw}" must be an origin with no path; every endpoint is served from the host root (${OIDC_DISCOVERY_PATH}, ${OIDC_AUTHORIZE_PATH}, …)`,
    };
  }
  return { ok: true, url: parsed };
}

/**
 * Why the provider has no usable configuration, for the log line a route writes
 * before answering 404 or 503. Returns an empty string when nothing is wrong.
 */
export function describeOidcConfigFailure(env: OidcConfigEnv): string {
  if (!isOidcEnabled(env)) return 'OIDC_ENABLED is not "true"';
  const raw = readString(env.OIDC_ISSUER_URL);
  if (!raw) return "OIDC_ISSUER_URL is not set";
  const checked = validateOidcIssuer(raw);
  return checked.ok ? "" : checked.reason;
}

/**
 * Resolve the issuer and its derived endpoint URLs, or `null` when the
 * provider is disabled or `OIDC_ISSUER_URL` is missing/unusable. Callers turn
 * `null` into a 404 (discovery/JWKS) or a structured 503 — never a partial
 * document, because an RP caches whatever it is handed — and log
 * `describeOidcConfigFailure` so the operator learns which rule was broken.
 */
export function resolveOidcConfig(env: OidcConfigEnv): OidcConfig | null {
  if (!isOidcEnabled(env)) return null;

  const raw = readString(env.OIDC_ISSUER_URL);
  if (!raw) return null;

  const checked = validateOidcIssuer(raw);
  if (!checked.ok) return null;
  const parsed = checked.url;

  const issuer = stripTrailingSlash(raw);
  const appOrigin =
    readString(env.ELIZA_CLOUD_URL) ?? readString(env.NEXT_PUBLIC_APP_URL) ?? parsed.origin;

  return {
    issuer,
    issuerHost: parsed.host.toLowerCase(),
    appOrigin: stripTrailingSlash(appOrigin),
    discoveryUrl: `${issuer}${OIDC_DISCOVERY_PATH}`,
    jwksUrl: `${issuer}${OIDC_JWKS_PATH}`,
    authorizationUrl: `${issuer}${OIDC_AUTHORIZE_PATH}`,
    resumeUrl: `${issuer}${OIDC_RESUME_PATH}`,
    tokenUrl: `${issuer}${OIDC_TOKEN_PATH}`,
    userinfoUrl: `${issuer}${OIDC_USERINFO_PATH}`,
  };
}

/**
 * Whether the request arrived on the one host the issuer names. The Worker is
 * routed for a wildcard subdomain pattern, so this is the only thing keeping
 * the provider from answering on hosts that serve user-controlled content.
 */
export function isIssuerHost(requestUrl: string, config: OidcConfig): boolean {
  try {
    return new URL(requestUrl).host.toLowerCase() === config.issuerHost;
  } catch {
    // error-policy:J3 an unparseable request URL reads as "wrong host".
    return false;
  }
}
