/**
 * Fail-closed deploy contract for the Worker's login (Steward) upstream.
 *
 * LOGIN_API_URL and the legacy STEWARD_API_URL are environment-scoped routing
 * authority: if staging receives the production value, every proxied auth
 * request crosses environments while continuing to return healthy-looking 200
 * responses. Cloudflare cannot reveal an existing secret value, so an absent
 * GitHub candidate remains a deliberate preserve-only state.
 *
 * Hosting contract:
 * - The Cloudflare login Worker's custom domain is the canonical upstream for
 *   each environment. Its workers.dev origin is the same deployment and is
 *   also accepted.
 * - Before cutover (no LOGIN_API_URL candidate), releases keep the committed
 *   wrangler.toml default and the legacy STEWARD_API_URL candidate may still
 *   name the Railway-era upstream, so merging this contract changes nothing.
 * - Once LOGIN_API_URL is configured, Railway-era upstreams are accepted only
 *   with LOGIN_ALLOW_RAILWAY_TRANSITION=true, an explicit one-release opt-in
 *   that also covers rollback to Railway.
 *
 * The candidate value is never printed. Error output names the binding and the
 * expected public origin only.
 */

import { pathToFileURL } from "node:url";

type DeployEnvironment = "staging" | "production";

/**
 * Public hostnames of the Cloudflare login Workers. Change them here and in
 * the `routes` of packages/auth/cloudflare/wrangler.toml together; the
 * login-release-routing test keeps the two in sync.
 */
export const CLOUDFLARE_LOGIN_HOSTS: Readonly<
  Record<DeployEnvironment, string>
> = Object.freeze({
  staging: "login-staging.eliza.app",
  production: "login.eliza.app",
});

/** The Cloudflare login Workers' workers.dev origins (same deployments). */
const CLOUDFLARE_LOGIN_WORKERS_DEV_URLS: Readonly<
  Record<DeployEnvironment, string>
> = Object.freeze({
  staging: "https://eliza-login-staging.square-rain-7251.workers.dev",
  production: "https://eliza-login-production.square-rain-7251.workers.dev",
});

/** Canonical login upstream per environment: the Cloudflare custom domain. */
export const CANONICAL_LOGIN_UPSTREAM_URLS: Readonly<
  Record<DeployEnvironment, string>
> = Object.freeze({
  staging: `https://${CLOUDFLARE_LOGIN_HOSTS.staging}`,
  production: `https://${CLOUDFLARE_LOGIN_HOSTS.production}`,
});

/** Same-environment Cloudflare origins accepted without any opt-in. */
export const CLOUDFLARE_LOGIN_UPSTREAM_URLS = Object.freeze({
  staging: Object.freeze([
    CANONICAL_LOGIN_UPSTREAM_URLS.staging,
    CLOUDFLARE_LOGIN_WORKERS_DEV_URLS.staging,
  ]),
  production: Object.freeze([
    CANONICAL_LOGIN_UPSTREAM_URLS.production,
    CLOUDFLARE_LOGIN_WORKERS_DEV_URLS.production,
  ]),
});

/**
 * Railway-era upstreams. Remove after the transition release in both
 * environments, together with the workflow's pre-cutover discovery fallback.
 */
export const RAILWAY_TRANSITION_LOGIN_UPSTREAM_URLS = Object.freeze({
  staging: Object.freeze(["https://steward-api-staging.up.railway.app"]),
  production: Object.freeze([
    "https://eliza.steward.fi",
    "https://steward-api-production-115d.up.railway.app",
  ]),
});

/** Every same-environment upstream a read-only probe may target. */
export const APPROVED_LOGIN_UPSTREAM_URLS = Object.freeze({
  staging: Object.freeze([
    ...CLOUDFLARE_LOGIN_UPSTREAM_URLS.staging,
    ...RAILWAY_TRANSITION_LOGIN_UPSTREAM_URLS.staging,
  ]),
  production: Object.freeze([
    ...CLOUDFLARE_LOGIN_UPSTREAM_URLS.production,
    ...RAILWAY_TRANSITION_LOGIN_UPSTREAM_URLS.production,
  ]),
});

/**
 * Pre-cutover canonical values of the legacy STEWARD_API_URL secret. Kept so
 * an existing protected candidate still passes until LOGIN_API_URL is set.
 */
const LEGACY_STEWARD_UPSTREAM_URLS: Readonly<
  Record<DeployEnvironment, string>
> = Object.freeze({
  staging: "https://steward-api-staging.up.railway.app",
  production: "https://eliza.steward.fi",
});

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function parseRailwayTransitionOptIn(value: unknown): boolean {
  return typeof value === "string" && TRUTHY.has(value.trim().toLowerCase());
}

export function verifyStewardUpstreamBinding({
  deployEnvironment,
  stewardApiUrl,
  loginApiUrl = "",
  allowRailwayTransition = false,
}: {
  deployEnvironment: string;
  stewardApiUrl?: unknown;
  loginApiUrl?: unknown;
  allowRailwayTransition?: boolean;
}) {
  if (deployEnvironment !== "staging" && deployEnvironment !== "production") {
    return {
      ok: false,
      error: `DEPLOY_ENVIRONMENT "${deployEnvironment}" has no canonical login upstream`,
    };
  }
  const canonical = CANONICAL_LOGIN_UPSTREAM_URLS[deployEnvironment];
  const cutover = loginApiUrl !== "";
  const cloudflare: readonly string[] =
    CLOUDFLARE_LOGIN_UPSTREAM_URLS[deployEnvironment];
  const railway: readonly string[] =
    RAILWAY_TRANSITION_LOGIN_UPSTREAM_URLS[deployEnvironment];

  if (cutover) {
    if (typeof loginApiUrl !== "string" || !cloudflare.includes(loginApiUrl)) {
      if (typeof loginApiUrl !== "string" || !railway.includes(loginApiUrl)) {
        return {
          ok: false,
          error: `LOGIN_API_URL does not match an approved ${deployEnvironment} login upstream (canonical ${canonical}); refusing a possible cross-environment auth deployment`,
        };
      }
      if (!allowRailwayTransition) {
        return {
          ok: false,
          error: `LOGIN_API_URL names a Railway-era ${deployEnvironment} login upstream; the canonical upstream is ${canonical}. Set ELIZA_LOGIN_ALLOW_RAILWAY_TRANSITION=true for one transition release to accept it`,
        };
      }
    }
  }

  const candidate =
    typeof stewardApiUrl === "string" ? stewardApiUrl.trim() : "";
  if (candidate === "") {
    return {
      ok: true,
      preservedExistingBinding: !cutover,
      error: null,
    };
  }

  if (cloudflare.includes(candidate)) {
    return { ok: true, preservedExistingBinding: false, error: null };
  }
  if (candidate === LEGACY_STEWARD_UPSTREAM_URLS[deployEnvironment]) {
    // Pre-cutover releases keep accepting the existing protected secret.
    if (!cutover || allowRailwayTransition) {
      return { ok: true, preservedExistingBinding: false, error: null };
    }
    return {
      ok: false,
      error: `STEWARD_API_URL names a Railway-era ${deployEnvironment} upstream while LOGIN_API_URL is configured; update it to ${canonical} or delete it, or set ELIZA_LOGIN_ALLOW_RAILWAY_TRANSITION=true for one transition release`,
    };
  }
  return {
    ok: false,
    error: `STEWARD_API_URL does not match the canonical ${deployEnvironment} login upstream ${canonical}; refusing a possible cross-environment auth deployment`,
  };
}

function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone deploy-script input outside Turbo caching.
  const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? "";
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this protected standalone deploy-script candidate outside Turbo caching.
  const stewardApiUrl = process.env.STEWARD_API_URL ?? "";
  const loginApiUrl = process.env.LOGIN_API_URL ?? "";
  const allowRailwayTransition = parseRailwayTransitionOptIn(
    process.env.LOGIN_ALLOW_RAILWAY_TRANSITION,
  );
  const result = verifyStewardUpstreamBinding({
    deployEnvironment,
    stewardApiUrl,
    loginApiUrl,
    allowRailwayTransition,
  });

  if (!result.ok) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }

  if (allowRailwayTransition) {
    console.log(
      `::warning::ELIZA_LOGIN_ALLOW_RAILWAY_TRANSITION is enabled for ${deployEnvironment}; Railway-era login upstreams are accepted for this transition release only. Unset it after the release.`,
    );
  }

  if (result.preservedExistingBinding) {
    console.log(
      `Login routing has no configured ${deployEnvironment} candidate; preserving the existing bindings without claiming their values were verified.`,
    );
    return;
  }

  console.log(
    `Verified the configured ${deployEnvironment} login routing candidates against their approved upstreams; candidate values were not printed.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // error-policy:J1 CLI boundary: translate a failed routing contract into a nonzero deploy result.
  try {
    main();
  } catch (error) {
    console.error(
      `::error::Steward upstream binding verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
