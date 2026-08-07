/**
 * Cross-environment routing verifier for the Cloudflare surfaces.
 *
 * Regression guard for "staging is pointing at prod CF": the staging API Worker
 * (`eliza-cloud-api-staging`) owns `staging.*` / `app-staging.*` / `api-staging.*`
 * ONLY by claiming those hostnames MORE specifically than the prod Worker's
 * `*.elizacloud.ai/*` wildcard (see `packages/cloud/api/wrangler.toml`
 * `[env.staging].routes`). The same split exists at the Pages layer: the staging
 * SPA deployments bake `API_UPSTREAM=api-staging.elizacloud.ai` while prod bakes
 * `api.elizacloud.ai`. If EITHER claim lapses - a dropped staging Worker route,
 * a Pages custom-domain reattached to the wrong deployment, a preview var that
 * drifted to prod - a staging subdomain silently starts serving production. The
 * failure is invisible from the repo (it is Cloudflare dashboard / route state,
 * not code) and invisible from a single-origin health check (each origin is
 * individually "up"). The only way to catch it is to ask each live custom domain
 * "which environment answered you?" and assert it matches the domain's intent.
 *
 * That answer is the `environment` field on `/api/health`
 * (`packages/cloud/api/src/index.ts` `healthResponse`). This module is the pure
 * decision core (matrix + per-probe classification + aggregate verdict); the I/O
 * lives in `verify-environment-routing-cli.mjs`.
 *
 * FAIL-CLOSED, unlike the deploy freshness guard: this is a monitor, not a
 * deploy gate, so a definitive cross-wire (a staging domain answering
 * "production", or vice-versa) is a hard failure. Transient/rollout states
 * (unreachable origin, a build predating the beacon) are configurable so the
 * check can be strict in steady state without red-flagging during a rollout.
 */

export const ENVIRONMENT_ROUTING_SCHEMA = "elizaos.cloud.env-routing/v1";

export const KNOWN_ENVIRONMENTS = /** @type {const} */ ([
  "staging",
  "production",
]);

/**
 * The source-of-truth mapping of each live custom domain to the environment
 * that MUST answer it. Kept in lockstep with `packages/cloud/api/wrangler.toml`
 * (`[env.staging].routes` + `[env.production].routes`) - the wrangler-sync unit
 * test fails if a staging host is added to the Worker routes without being
 * represented here. Only hostnames that serve `/api/health` belong here
 * (blob-staging.* serves R2 objects, not the API - it is intentionally omitted).
 *
 * @type {ReadonlyArray<{ domain: string, environment: "staging" | "production" }>}
 */
export const ENVIRONMENT_ROUTING = [
  // Production: the prod Worker (`*.elizacloud.ai/*` wildcard + explicit
  // api./x402.) and the prod Pages deployments (app.elizacloud.ai apex + subdomain).
  { domain: "elizacloud.ai", environment: "production" },
  { domain: "app.elizacloud.ai", environment: "production" },
  { domain: "api.elizacloud.ai", environment: "production" },
  // Staging: MUST be reclaimed from the prod wildcard by the staging Worker's
  // more-specific routes and the staging Pages deployments.
  { domain: "staging.elizacloud.ai", environment: "staging" },
  { domain: "app-staging.elizacloud.ai", environment: "staging" },
  { domain: "api-staging.elizacloud.ai", environment: "staging" },
];

/**
 * @typedef {"ok" | "misrouted" | "unexpected_env" | "beacon_missing" | "unreachable"} ProbeStatus
 * @typedef {object} ProbeInput
 * @property {string} domain
 * @property {"staging" | "production"} expected
 * @property {string|null} observed   environment reported by /api/health, or null
 * @property {boolean} reachable      whether /api/health returned a usable 200/JSON
 * @property {string} [detail]        raw diagnostic (http code, error text)
 * @typedef {object} ProbeResult
 * @property {string} domain
 * @property {"staging" | "production"} expected
 * @property {string|null} observed
 * @property {ProbeStatus} status
 * @property {string} message
 */

/**
 * Extract the `environment` field from a fetched `/api/health` body. Returns the
 * trimmed string, or null when absent/blank/unparseable (SPA index.html
 * fallthrough, an old build without the beacon, a non-JSON error page).
 *
 * @param {string|null|undefined} body raw response body text
 * @returns {string|null}
 */
export function parseServedEnvironment(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // error-policy:J3 untrusted-input sanitizing - old/incorrect deployments
    // may answer the health URL with HTML or a non-JSON error body.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const environment = /** @type {{ environment?: unknown }} */ (parsed)
    .environment;
  if (typeof environment !== "string" || !environment.trim()) return null;
  return environment.trim();
}

/**
 * Classify a single probe. Pure: the network result is passed in.
 *
 * @param {ProbeInput} input
 * @returns {ProbeResult}
 */
export function classifyProbe({
  domain,
  expected,
  observed,
  reachable,
  detail,
}) {
  const normalizedObserved =
    typeof observed === "string" && observed.trim() ? observed.trim() : null;
  const base = { domain, expected, observed: normalizedObserved };
  const suffix = detail ? ` (${detail})` : "";

  if (!reachable) {
    return {
      ...base,
      status: "unreachable",
      message: `${domain}: /api/health unreachable or non-JSON${suffix}.`,
    };
  }

  if (!normalizedObserved) {
    return {
      ...base,
      status: "beacon_missing",
      message: `${domain}: /api/health answered but reported no environment (build predates the beacon)${suffix}.`,
    };
  }

  if (normalizedObserved === expected) {
    return {
      ...base,
      status: "ok",
      message: `${domain}: served by ${expected}`,
    };
  }

  // Answered with a DIFFERENT, KNOWN environment: a genuine cross-wire. This
  // domain is being served by the wrong environment. THE regression.
  if (KNOWN_ENVIRONMENTS.includes(/** @type {never} */ (normalizedObserved))) {
    return {
      ...base,
      status: "misrouted",
      message: `${domain}: MISROUTED - expected ${expected} but ${normalizedObserved} answered. A ${expected} domain is being served by the ${normalizedObserved} environment.`,
    };
  }

  // Answered with an unrecognized environment string: a misconfigured
  // ENVIRONMENT var, not a known cross-wire. Surfaced, not fatal by default.
  return {
    ...base,
    status: "unexpected_env",
    message: `${domain}: unexpected environment "${normalizedObserved}" (expected ${expected}).`,
  };
}

/**
 * Aggregate per-probe results into a pass/fail verdict.
 *
 * `misrouted` is ALWAYS a failure - it is the exact regression this guard
 * exists to catch. `unexpected_env` is always a failure too (the env var is set
 * to something the system does not recognize). `beacon_missing` and
 * `unreachable` are failures only when their respective flags demand it, so the
 * monitor can be strict in steady state yet tolerant during a beacon rollout or
 * a transient origin blip.
 *
 * @param {object} args
 * @param {ProbeResult[]} args.probes
 * @param {boolean} [args.requireBeacon]     beacon_missing -> failure
 * @param {boolean} [args.requireReachable]  unreachable -> failure (default true)
 * @returns {{ ok: boolean, probes: ProbeResult[], failures: ProbeResult[], warnings: ProbeResult[], summary: string }}
 */
export function decideRoutingVerdict({
  probes,
  requireBeacon = false,
  requireReachable = true,
}) {
  const list = Array.isArray(probes) ? probes : [];
  /** @type {(p: ProbeResult) => boolean} */
  const isFailure = (p) =>
    p.status === "misrouted" ||
    p.status === "unexpected_env" ||
    (p.status === "beacon_missing" && requireBeacon) ||
    (p.status === "unreachable" && requireReachable);

  const failures = list.filter(isFailure);
  const warnings = list.filter((p) => p.status !== "ok" && !isFailure(p));
  const ok = failures.length === 0;

  const counts = list.reduce(
    /** @param {Record<string, number>} acc */ (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const countStr = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const summary = ok
    ? `All ${list.length} domains routed correctly (${countStr}).`
    : `${failures.length}/${list.length} domain(s) FAILED routing verification (${countStr}).`;

  return { ok, probes: list, failures, warnings, summary };
}

/**
 * Fetch `/api/health` for one base URL and return the observed environment plus
 * reachability. Retries transient failures (the domains are always-up prod /
 * staging origins, so a persistent failure is meaningful; a single blip is not).
 *
 * @param {string} domain hostname, e.g. "app-staging.elizacloud.ai"
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.healthPath]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.attempts]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ observed: string|null, reachable: boolean, detail: string }>}
 */
export async function fetchServedEnvironment(
  domain,
  {
    fetchImpl = fetch,
    healthPath = "/api/health",
    timeoutMs = 20000,
    attempts = 4,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  if (typeof domain !== "string" || !domain.trim()) {
    return { observed: null, reachable: false, detail: "blank domain" };
  }
  const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  const url = `https://${domain.trim().replace(/\/+$/, "")}${path}`;
  let lastDetail = "no attempts";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const res = await fetchImpl(url, {
        // Never accept a CDN/edge-cached copy; we need who is answering NOW.
        headers: { "cache-control": "no-cache" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res?.ok) {
        lastDetail = `HTTP ${res?.status ?? "?"}`;
      } else {
        const body = await res.text();
        const observed = parseServedEnvironment(body);
        // A reachable 200 with valid JSON is a usable answer even if the beacon
        // field is absent. That distinction (beacon_missing vs unreachable) is
        // the classifier's job, so return reachable:true here.
        return { observed, reachable: true, detail: `HTTP ${res.status}` };
      }
    } catch (err) {
      // error-policy:J1 boundary translation - the network boundary reports a
      // structured unreachable probe so the aggregate verifier can decide
      // whether that is fatal for this run.
      lastDetail =
        err instanceof Error ? err.message : `fetch failed: ${String(err)}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(attempt * 3000);
  }

  return { observed: null, reachable: false, detail: lastDetail };
}
