/**
 * Fail-closed deploy contract for the Worker's Steward upstream.
 *
 * STEWARD_API_URL is environment-scoped routing authority: if staging receives
 * the production value, every proxied auth request crosses environments while
 * continuing to return healthy-looking 200 responses. Cloudflare cannot reveal
 * an existing secret value, so an absent GitHub candidate remains a deliberate
 * preserve-only state. Any nonblank candidate, however, must exactly match the
 * canonical upstream for the target environment before it can be queued into
 * the atomic Worker version.
 *
 * The candidate value is never printed. Error output names the binding and the
 * expected public origin only.
 */

import { pathToFileURL } from "node:url";

export const CANONICAL_STEWARD_UPSTREAM_URLS = Object.freeze(
  Object.assign(Object.create(null), {
    staging: "https://steward-api-staging.up.railway.app",
    production: "https://eliza.steward.fi",
  }),
);

export function verifyStewardUpstreamBinding({
  deployEnvironment,
  stewardApiUrl,
}) {
  const canonical = CANONICAL_STEWARD_UPSTREAM_URLS[deployEnvironment];
  if (canonical === undefined) {
    return {
      ok: false,
      error: `DEPLOY_ENVIRONMENT "${deployEnvironment}" has no canonical Steward upstream`,
    };
  }

  const candidate =
    typeof stewardApiUrl === "string" ? stewardApiUrl.trim() : "";
  if (candidate === "") {
    return { ok: true, preservedExistingBinding: true, error: null };
  }

  if (candidate !== canonical) {
    return {
      ok: false,
      error: `STEWARD_API_URL does not match the canonical ${deployEnvironment} Steward upstream ${canonical}; refusing a possible cross-environment auth deployment`,
    };
  }

  return { ok: true, preservedExistingBinding: false, error: null };
}

function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone deploy-script input outside Turbo caching.
  const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? "";
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this protected standalone deploy-script candidate outside Turbo caching.
  const stewardApiUrl = process.env.STEWARD_API_URL ?? "";
  const result = verifyStewardUpstreamBinding({
    deployEnvironment,
    stewardApiUrl,
  });

  if (!result.ok) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }

  if (result.preservedExistingBinding) {
    console.log(
      `STEWARD_API_URL has no configured ${deployEnvironment} candidate; preserving the existing Worker binding without claiming its value was verified.`,
    );
    return;
  }

  console.log(
    `Verified the configured ${deployEnvironment} STEWARD_API_URL candidate against the canonical upstream; the candidate value was not printed.`,
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
