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

/**
 * Resolve the issuer and its derived endpoint URLs, or `null` when the
 * provider is disabled or `OIDC_ISSUER_URL` is missing/unusable. Callers turn
 * `null` into a 404 (discovery/JWKS) or a structured 503 — never a partial
 * document, because an RP caches whatever it is handed.
 */
export function resolveOidcConfig(env: OidcConfigEnv): OidcConfig | null {
  if (!isOidcEnabled(env)) return null;

  const raw = readString(env.OIDC_ISSUER_URL);
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // error-policy:J3 a malformed issuer is a deploy misconfiguration; treat
    // it as "not configured" so no endpoint serves a document an RP would pin.
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null;
  if (parsed.search || parsed.hash) return null;

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
