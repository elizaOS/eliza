/**
 * Shared secret-route config validator — single source of truth.
 *
 * This validation gates live credential injection: the proxy decrypts a stored
 * secret and injects it as an outbound header on requests that match a route.
 * A too-loose route means a tenant credential can be attached to a call the
 * agent should not be able to make. Every rule here is fail-closed: stricter
 * wins, and nothing is relaxed relative to the two former call-path copies
 * (packages/vault/src/secret-vault.ts and packages/api/src/routes/secrets.ts)
 * that this module replaces.
 *
 * injectAs is header-only. Query and body injection are NOT supported here:
 * upstream responses can reflect query strings and bodies, which risks leaking
 * the injected credential back to the agent.
 */

import { isIP } from "node:net";
import { containsAsciiControl } from "../../shared/src/text-boundaries";

/**
 * Hosts that may ever receive an injected credential via a secret route.
 * These are the code-level defaults; operators can extend the allowlist via
 * the STEWARD_SECRET_ROUTE_ALLOWED_HOSTS env var (comma-separated).
 */
export const DEFAULT_SECRET_ROUTE_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "public-api.birdeye.so",
  "api.coingecko.com",
  "api.helius.xyz",
  "api.github.com",
  "api.x.com",
  "slack.com",
  "gmail.googleapis.com",
  "www.googleapis.com",
] as const;

/**
 * Header names that must never be settable via injectKey — hop-by-hop headers
 * and framing-sensitive headers whose injection could enable smuggling. These
 * are unconditionally blocked; there is no operator escape valve.
 */
const BLOCKED_INJECT_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Session-material headers that are blocked by default but may be enabled by a
 * deliberate operator opt-in (STEWARD_ALLOW_COOKIE_INJECTION=true).
 *
 * Injecting a raw `Cookie` header replays a whole browser session: no scoping,
 * no revocation handle, no `Set-Cookie` rotation path on our side — the blast
 * radius is the entire session. House style is fail-closed, so this is blocked
 * by default. The preferred pattern is a scoped broker read token injected as
 * `Authorization: Bearer <token>` (revocable, auditable, per-grant). Raw
 * session replay remains a legitimate niche (some hosts only speak cookies), so
 * it stays reachable — but only as an explicit operator choice, never implicit.
 */
const COOKIE_INJECT_HEADERS = new Set(["cookie", "set-cookie"]);

const VALID_PROXY_METHODS = new Set([
  "*",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
]);
const MAX_SECRET_INJECT_FORMAT_LENGTH = 255;
const MAX_SECRET_ROUTE_PRIORITY = 1_000_000;

/**
 * RFC 7230 token charset for HTTP header field names. Reconciled from the api
 * copy, which used this allowlist. Strictly stronger than the vault copy's
 * denylist (which only rejected CR/LF/colon), so we keep the allowlist.
 */
const HTTP_HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * Per-host strictness rules. A host listed here opts into extra route
 * narrowness beyond the global defaults. Data-driven so future hosts can opt
 * in without new code paths.
 *
 * - minPathSegments: the route's pathPattern must contain at least this many
 *   non-empty path segments (e.g. /repos/acme/widgets/... has 3). Blocks broad
 *   root-level routes like "/" that would attach the credential to everything
 *   under the host.
 * - requireExplicitMethod: the route must specify a concrete HTTP method (not
 *   "*"), so the credential is scoped to a single verb.
 * - disallowPathWildcards: the pathPattern must not contain any "*" glob
 *   wildcard. The proxy route matcher treats "*" as a prefix/segment wildcard,
 *   so a path like "/repos/*" (which technically has 2 segments) would attach
 *   the credential to every endpoint under /repos/. Requiring concrete segments
 *   keeps a strict-host route pinned to one exact endpoint.
 */
export const STRICT_HOSTS: Record<
  string,
  {
    minPathSegments: number;
    requireExplicitMethod: boolean;
    disallowPathWildcards: boolean;
  }
> = {
  "api.github.com": {
    minPathSegments: 2,
    requireExplicitMethod: true,
    disallowPathWildcards: true,
  },
  // X provider-action endpoints: POST /2/tweets, DELETE /2/tweets/{id},
  // GET /2/users/me. Every governed X path has >=2 segments, so the same
  // strict narrowness as github pins each route to one exact endpoint + verb
  // and forbids "*" wildcards (a /2/* route would attach the OAuth token to
  // every X endpoint).
  "api.x.com": {
    minPathSegments: 2,
    requireExplicitMethod: true,
    disallowPathWildcards: true,
  },
  "slack.com": {
    minPathSegments: 2,
    requireExplicitMethod: true,
    disallowPathWildcards: true,
  },
  "gmail.googleapis.com": {
    minPathSegments: 5,
    requireExplicitMethod: true,
    disallowPathWildcards: true,
  },
  "www.googleapis.com": {
    minPathSegments: 5,
    requireExplicitMethod: true,
    disallowPathWildcards: true,
  },
};

export type CredentialInjectionStrategy = "header" | "sigv4";
export type CredentialInjectionConfig = { service?: string; region?: string };

export type SecretRouteConfigInput = {
  agentId?: string;
  hostPattern?: string;
  pathPattern?: string;
  method?: string;
  injectAs?: string;
  injectKey?: string;
  injectFormat?: string;
  injectionStrategy?: CredentialInjectionStrategy | string;
  injectionConfig?: CredentialInjectionConfig | Record<string, unknown>;
  priority?: number;
  requiresApproval?: boolean;
  approvalConfig?: Record<string, unknown>;
};

function allowBroadSecretRoutes(): boolean {
  return process.env.STEWARD_ALLOW_BROAD_SECRET_ROUTES === "true";
}

/**
 * Whether the operator has opted into raw session-cookie injection. Read at
 * call time (same pattern as allowBroadSecretRoutes) so tests / operators can
 * toggle it. Fail-closed: anything other than the exact string "true" leaves
 * cookie injection blocked.
 */
function allowCookieInjection(): boolean {
  return process.env.STEWARD_ALLOW_COOKIE_INJECTION === "true";
}

/**
 * The effective secret-route host allowlist: code defaults ∪ env additions.
 * Read at call time so tests / operators can toggle the env var.
 */
export function configuredSecretRouteHosts(): string[] {
  return [
    ...DEFAULT_SECRET_ROUTE_HOSTS,
    ...(process.env.STEWARD_SECRET_ROUTE_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ];
}

function hostAllowedByEntry(hostPattern: string, allowedHost: string): boolean {
  if (hostPattern === allowedHost) return true;
  if (hostPattern.startsWith("*.")) {
    const suffix = hostPattern.slice(2);
    const suffixLabels = suffix.split(".").filter(Boolean);
    if (suffixLabels.length < 2) return false;
    if (!allowedHost.startsWith("*.")) return false;
    const allowedSuffix = allowedHost.slice(2);
    return suffix === allowedSuffix || suffix.endsWith(`.${allowedSuffix}`);
  }
  if (allowedHost.startsWith("*.")) {
    const allowedSuffix = allowedHost.slice(1);
    return (
      hostPattern.endsWith(allowedSuffix) &&
      hostPattern.length > allowedSuffix.length
    );
  }
  return false;
}

/** Count non-empty path segments: "/repos/acme/widgets" -> 3. */
function countPathSegments(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * Resolve the strict-host rule for a given hostPattern, if any. Exact-host
 * routes match directly; a "*.example.com" wildcard matches a strict host only
 * if the strict host is a subdomain of the wildcard suffix (so wildcards can
 * never be used to dodge a strict host's narrowness rules).
 */
function strictHostRuleFor(
  hostPattern: string,
): { host: string; rule: (typeof STRICT_HOSTS)[string] } | null {
  for (const [host, rule] of Object.entries(STRICT_HOSTS)) {
    if (hostPattern === host) return { host, rule };
    if (hostPattern.startsWith("*.")) {
      const suffix = hostPattern.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length)
        return { host, rule };
    }
  }
  return null;
}

export type ValidateSecretRouteOptions = {
  /**
   * Whether to enforce per-host STRICT_HOSTS narrowness (explicit method +
   * minimum path depth). Defaults to true.
   *
   * Set to false ONLY when validating a PARTIAL update patch in isolation:
   * a partial patch (e.g. `{ hostPattern: "api.github.com" }`) does not carry
   * the full route, so the strict-host rule cannot be judged fairly against it
   * and would reject otherwise-valid partial edits. The caller MUST still run a
   * second validation pass with strict-host enforcement ON against the merged
   * (existing ∪ patch) config — that merged pass is where fail-closed strictness
   * is actually enforced for updates. Create always passes a complete config,
   * so it uses the default (strict on).
   */
  enforceStrictHosts?: boolean;
};

/**
 * Validate a secret-route config (create or partial update).
 *
 * Returns a human-readable error string on the first failed rule, or null if
 * the config is acceptable. Behavior-preserving relative to the reconciled
 * union of the two former copies; the only added strictness is the per-host
 * STRICT_HOSTS narrowness guard (see enforceStrictHosts).
 */
export function validateSecretRouteConfig(
  input: SecretRouteConfigInput,
  options?: ValidateSecretRouteOptions,
): string | null {
  const enforceStrictHosts = options?.enforceStrictHosts ?? true;
  const isPartialPatch = options?.enforceStrictHosts === false;
  const strategy = input.injectionStrategy ?? "header";
  if (strategy !== "header" && strategy !== "sigv4") {
    return "injectionStrategy must be one of: header, sigv4";
  }
  if (isPartialPatch && input.injectionStrategy === undefined) {
    // Cross-field strategy/config validation happens against the merged route
    // in SecretVault.updateRoute. A partial config-only patch has no strategy.
  } else if (strategy === "header") {
    if (
      input.injectionConfig &&
      Object.keys(input.injectionConfig).length > 0
    ) {
      return "header injectionStrategy requires an empty injectionConfig";
    }
  } else {
    const config = input.injectionConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return "sigv4 injectionStrategy requires injectionConfig";
    }
    const keys = Object.keys(config);
    if (keys.some((key) => key !== "service" && key !== "region")) {
      return "sigv4 injectionConfig contains an unknown field";
    }
    if (config.service !== "ec2")
      return "sigv4 injectionConfig.service must be ec2";
    if (
      typeof config.region !== "string" ||
      !/^[a-z]{2}(?:-[a-z0-9]+){1,3}-[1-9][0-9]?$/.test(config.region)
    ) {
      return "sigv4 injectionConfig.region is invalid";
    }
    const expectedHost = `ec2.${config.region}.amazonaws.com`;
    if (
      input.hostPattern !== undefined &&
      input.hostPattern.trim().toLowerCase() !== expectedHost
    ) {
      return `sigv4 route hostPattern must be ${expectedHost}`;
    }
    if (input.pathPattern !== undefined && input.pathPattern.trim() !== "/") {
      return "sigv4 EC2 route pathPattern must be /";
    }
    if (
      input.method !== undefined &&
      input.method.trim().toUpperCase() !== "POST"
    ) {
      return "sigv4 EC2 route method must be POST";
    }
  }
  if (input.agentId !== undefined && !input.agentId.trim())
    return "agentId is invalid";

  if (input.hostPattern !== undefined) {
    const hostPattern = input.hostPattern.trim().toLowerCase();
    if (!hostPattern || hostPattern === "*" || hostPattern === "*.*") {
      return "hostPattern must be an explicit allowed host";
    }
    const hostForIpCheck = hostPattern.startsWith("*.")
      ? hostPattern.slice(2)
      : hostPattern;
    if (
      isIP(hostForIpCheck) ||
      hostForIpCheck === "localhost" ||
      hostForIpCheck.endsWith(".localhost") ||
      hostForIpCheck.endsWith(".local") ||
      hostForIpCheck.endsWith(".internal")
    ) {
      return "hostPattern must not target localhost, private, or internal hosts";
    }
    const isBoundAwsSigV4Host =
      strategy === "sigv4" &&
      typeof input.injectionConfig?.region === "string" &&
      hostPattern === `ec2.${input.injectionConfig.region}.amazonaws.com`;
    if (
      !isBoundAwsSigV4Host &&
      !configuredSecretRouteHosts().some((allowed) =>
        hostAllowedByEntry(hostPattern, allowed),
      )
    ) {
      return "hostPattern is not in the secret route allowlist";
    }
  }

  if (input.pathPattern !== undefined) {
    const pathPattern = input.pathPattern.trim();
    const lowered = pathPattern.toLowerCase();
    if (!pathPattern.startsWith("/")) return "pathPattern must start with /";
    if (
      !allowBroadSecretRoutes() &&
      (pathPattern === "/*" || pathPattern === "*")
    ) {
      return "broad pathPattern requires STEWARD_ALLOW_BROAD_SECRET_ROUTES=true";
    }
    if (containsAsciiControl(pathPattern) || pathPattern.includes("\\"))
      return "pathPattern is invalid";
    // Route paths are matched independently from the request query, and URL
    // fragments are never transmitted. Keeping both delimiters out of stored
    // route specs prevents policy-visible selectors from diverging from the
    // exact URL the proxy dispatches.
    if (pathPattern.includes("?") || pathPattern.includes("#")) {
      return "pathPattern must not contain query or fragment delimiters";
    }
    if (
      lowered.includes("%2e") ||
      lowered.includes("%2f") ||
      lowered.includes("%5c") ||
      pathPattern
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      return "pathPattern must not contain dot segments or encoded path separators";
    }
  }

  if (input.method !== undefined) {
    const method = input.method.trim().toUpperCase();
    if (!VALID_PROXY_METHODS.has(method)) return "method is not allowed";
    if (!allowBroadSecretRoutes() && method === "*") {
      return "broad method requires STEWARD_ALLOW_BROAD_SECRET_ROUTES=true";
    }
  }

  // injectAs is header-only. Reconciled from the api copy (the vault copy still
  // permitted "query" behind an env flag). Header-only is stricter and matches
  // the proxy's actual injection surface, so we keep it — query/body injection
  // is not accepted by any code path.
  if (input.injectAs !== undefined) {
    const validInjectAs = ["header"];
    if (!validInjectAs.includes(input.injectAs)) {
      return `'injectAs' must be one of: ${validInjectAs.join(", ")}`;
    }
  }

  if (input.injectKey !== undefined) {
    const key = input.injectKey.trim().toLowerCase();
    // Allowlist charset (api copy) is stricter than the vault copy's CR/LF/colon
    // denylist; keep the allowlist.
    if (!key || !HTTP_HEADER_NAME.test(key)) return "injectKey is invalid";
    if (BLOCKED_INJECT_HEADERS.has(key))
      return `injectKey '${input.injectKey}' is not allowed`;
    // Session-cookie headers are blocked by default (fail-closed) and only
    // reachable via a deliberate operator opt-in. See COOKIE_INJECT_HEADERS.
    if (COOKIE_INJECT_HEADERS.has(key) && !allowCookieInjection()) {
      return `injectKey '${input.injectKey}' requires STEWARD_ALLOW_COOKIE_INJECTION=true`;
    }
  }

  if (input.injectFormat !== undefined) {
    if (typeof input.injectFormat !== "string")
      return "injectFormat must be a string";
    if (input.injectFormat.length > MAX_SECRET_INJECT_FORMAT_LENGTH) {
      return `injectFormat cannot exceed ${MAX_SECRET_INJECT_FORMAT_LENGTH} characters`;
    }
    if (/[\r\n]/.test(input.injectFormat))
      return "injectFormat must not contain line breaks";
    const placeholderCount =
      input.injectFormat.match(/\{value\}/g)?.length ?? 0;
    if (placeholderCount !== 1) {
      return "injectFormat must contain exactly one {value} placeholder";
    }
  }

  if (
    input.priority !== undefined &&
    (!Number.isSafeInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > MAX_SECRET_ROUTE_PRIORITY)
  ) {
    return `priority must be an integer between 0 and ${MAX_SECRET_ROUTE_PRIORITY}`;
  }

  // ─── Per-host strictness (STRICT_HOSTS) ───────────────────────────────────
  // Enforced when the route targets a strict host and enforceStrictHosts is on.
  // Fail-closed: a strict host requires an explicit method and a sufficiently
  // deep path — the relevant field must be present AND satisfy the rule. Skipped
  // for partial-update patches (enforceStrictHosts=false); the update call sites
  // re-run this with enforcement ON against the merged config.
  if (enforceStrictHosts && input.hostPattern !== undefined) {
    const hostPattern = input.hostPattern.trim().toLowerCase();
    const strict = strictHostRuleFor(hostPattern);
    if (strict) {
      const { host, rule } = strict;
      if (rule.requireExplicitMethod) {
        const method = input.method?.trim().toUpperCase();
        if (!method || method === "*") {
          return `routes for ${host} must specify an explicit HTTP method`;
        }
      }
      if (rule.minPathSegments > 0) {
        const path = input.pathPattern?.trim();
        if (!path || countPathSegments(path) < rule.minPathSegments) {
          return `routes for ${host} must target a path with at least ${rule.minPathSegments} segments`;
        }
      }
      if (rule.disallowPathWildcards) {
        const path = input.pathPattern?.trim() ?? "";
        // Any "*" is a glob wildcard to the proxy matcher; a strict host must be
        // pinned to a concrete endpoint (e.g. /repos/acme/widgets, not /repos/*).
        if (path.includes("*")) {
          return `routes for ${host} must target an exact path (no "*" wildcards)`;
        }
      }
    }
  }

  return null;
}
