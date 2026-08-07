/**
 * Cloud deploy freshness guard (#14083).
 *
 * Zombie CI runs that were stuck `queued` during a runner freeze eventually
 * execute and deploy their OLD ref OVER a newer build — staging/prod regress to
 * a pre-fix bundle HOURS after newer builds were live (observed #14082: staging
 * regressed to `8deb9cbd07`, a pre-#13410 ref, clobbering newer deploys).
 *
 * This guard runs BEFORE `wrangler pages deploy` / `wrangler deploy` and:
 *   1. Fetches the currently-served build stamp (the deployed
 *      `eliza-renderer-build.json` for Pages, or `/api/health` for the Worker,
 *      whose `commit` field records the ref that built it).
 *   2. Skips the deploy when the run's SHA is an ANCESTOR of the served commit
 *      (`git merge-base --is-ancestor <runSha> <servedCommit>`) — i.e. the
 *      currently-served build is strictly newer than what this run would ship.
 *   3. A `--force` flag (wired from a `workflow_dispatch` input) bypasses the
 *      guard for intentional rollbacks.
 *
 * FAIL-OPEN by design: the guard only SKIPS on a DEFINITIVE stale signal (the
 * run SHA is provably an ancestor of a known-newer served commit). Every
 * ambiguous state — served stamp unreachable/unparseable, no commit recorded,
 * histories unrelated, ancestry undeterminable — DEPLOYS. A freshness guard must
 * never turn a transient signal-fetch failure into an undeployable state (that
 * would block the exact fix that needs to ship). "Deploy" is the safe default;
 * "skip" is the narrow, provable case.
 */

export const DEPLOY_FRESHNESS_SCHEMA = "elizaos.deploy.freshness-guard/v1";

/**
 * @typedef {"deploy" | "skip"} FreshnessDecision
 * @typedef {object} FreshnessResult
 * @property {FreshnessDecision} decision
 * @property {string} reason        machine-stable reason code
 * @property {string} detail        human-readable explanation
 * @property {string|null} runSha
 * @property {string|null} servedCommit
 */

/**
 * Pure decision core. No I/O — every input is passed in so this is fully
 * unit-testable and deterministic.
 *
 * @param {object} args
 * @param {string|null|undefined} args.runSha        the SHA this run would deploy
 * @param {string|null|undefined} args.servedCommit  commit of the currently-served build (null if unknown)
 * @param {boolean} [args.force]                     bypass the guard (intentional rollback)
 * @param {(runSha: string, servedCommit: string) => (boolean|null)} args.isAncestor
 *        returns true if runSha is a strict-or-equal ancestor of servedCommit,
 *        false if it is not, and null if ancestry could NOT be determined
 *        (histories unrelated / commit not fetchable / git error).
 * @returns {FreshnessResult}
 */
export function decideDeployFreshness({
  runSha,
  servedCommit,
  force = false,
  isAncestor,
}) {
  const normalizedRun =
    typeof runSha === "string" && runSha.trim() ? runSha.trim() : null;
  const normalizedServed =
    typeof servedCommit === "string" && servedCommit.trim()
      ? servedCommit.trim()
      : null;

  const base = {
    runSha: normalizedRun,
    servedCommit: normalizedServed,
  };

  if (force) {
    return {
      ...base,
      decision: "deploy",
      reason: "forced",
      detail: "--force set: bypassing freshness guard (intentional rollback).",
    };
  }

  if (!normalizedRun) {
    // Can't reason about freshness with no run SHA — deploy (fail-open).
    return {
      ...base,
      decision: "deploy",
      reason: "no_run_sha",
      detail: "No run SHA provided; cannot compare freshness. Deploying.",
    };
  }

  if (!normalizedServed) {
    // No served stamp / no commit recorded → first deploy, or an old build
    // without a stamp. Deploy (fail-open).
    return {
      ...base,
      decision: "deploy",
      reason: "no_served_commit",
      detail:
        "No served build commit available (missing/unstamped build). Deploying.",
    };
  }

  if (normalizedRun === normalizedServed) {
    // Re-deploying the same commit is legitimate (secret rotation, retry).
    return {
      ...base,
      decision: "deploy",
      reason: "same_commit",
      detail:
        "Run SHA equals the served commit. Deploying (idempotent redeploy).",
    };
  }

  let ancestor;
  try {
    ancestor = isAncestor(normalizedRun, normalizedServed);
  } catch {
    ancestor = null;
  }

  if (ancestor === true) {
    // The run's SHA is an ancestor of the served commit → the served build is
    // strictly NEWER than what this run would ship → this is a stale run.
    return {
      ...base,
      decision: "skip",
      reason: "stale_run",
      detail:
        `Run SHA ${normalizedRun} is an ancestor of the currently-served ` +
        `commit ${normalizedServed}: the served build is newer. Skipping stale deploy.`,
    };
  }

  if (ancestor === false) {
    // The run SHA is NOT an ancestor of the served commit → it is newer or on a
    // divergent tip that should win. Deploy.
    return {
      ...base,
      decision: "deploy",
      reason: "run_is_newer",
      detail:
        `Run SHA ${normalizedRun} is not an ancestor of served commit ` +
        `${normalizedServed}: this run is newer or divergent. Deploying.`,
    };
  }

  // ancestor === null → ancestry undeterminable (unrelated histories, commit
  // not fetchable, git error). Fail-open: deploy.
  return {
    ...base,
    decision: "deploy",
    reason: "ancestry_unknown",
    detail:
      `Could not determine ancestry between run SHA ${normalizedRun} and ` +
      `served commit ${normalizedServed}. Deploying (fail-open).`,
  };
}

/**
 * Extract the served build commit from a fetched `eliza-renderer-build.json`
 * body. Returns the commit string, or null when absent/unparseable/blank.
 *
 * @param {string|null|undefined} body raw response body text
 * @returns {string|null}
 */
export function parseServedCommit(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const commit = /** @type {{ commit?: unknown }} */ (parsed).commit;
  if (typeof commit !== "string" || !commit.trim()) return null;
  return commit.trim();
}

/**
 * Fetch the served deploy stamp and return its recorded commit, or null on any
 * failure (fail-open — an unreachable stamp must not block deploys).
 *
 * @param {string} baseUrl e.g. "https://staging.elizacloud.ai"
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.stampPath]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string|null>}
 */
export async function fetchServedCommit(
  baseUrl,
  {
    fetchImpl = fetch,
    stampPath = "/eliza-renderer-build.json",
    timeoutMs = 15000,
  } = {},
) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  const normalizedStampPath =
    typeof stampPath === "string" && stampPath.trim()
      ? stampPath.trim()
      : "/eliza-renderer-build.json";
  const path = normalizedStampPath.startsWith("/")
    ? normalizedStampPath
    : `/${normalizedStampPath}`;
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchImpl(url, {
      // Never let a CDN/service-worker hand back a cached stamp — we need the
      // live served build identity.
      headers: { "cache-control": "no-cache" },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res?.ok) return null;
    const body = await res.text();
    return parseServedCommit(body);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
