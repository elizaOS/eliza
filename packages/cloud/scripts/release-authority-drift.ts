#!/usr/bin/env node
/**
 * Read-only exact-SHA release-authority check for one Cloud environment (#27229).
 *
 * A healthy `/api/health` is availability, not release authority. This check
 * reads the public build stamps of the API Worker (`/api/health` `commit`) and
 * of every canonical Pages frontend (`/eliza-renderer-build.json` `commit`) and
 * FAILS CLOSED unless:
 *   - every surface reports a full 40-character commit and the Worker reports
 *     the expected environment;
 *   - the Worker and every Pages surface serve the SAME commit (no split tree);
 *   - that commit is reachable from the environment's canonical branch, so it
 *     can only have come from the protected release path, never from an
 *     unattested upload of another branch;
 *   - when `--expected-sha` is given, the served commit equals it exactly.
 *
 * Usage:
 *   node packages/cloud/scripts/release-authority-drift.ts \
 *     --environment staging \
 *     [--expected-sha <40-hex>] \
 *     [--output <report.json>]
 *
 * The report holds only public commit SHAs, public hostnames, closed reason
 * codes, and booleans. It never contains response bodies or credentials.
 * Exit code: 0 when authority holds, 1 on any failure.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCanonicalHead } from "./canonical-deploy-source-guard.ts";
import { fetchServedCommit } from "./deploy-freshness-guard.ts";
import { isAncestor } from "./deploy-freshness-guard-cli.ts";
import { parseServedEnvironment } from "./verify-environment-routing.ts";

export const RELEASE_AUTHORITY_SCHEMA = "elizaos.cloud.release-authority/v1";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

/**
 * Canonical public surfaces per environment. The canonical branch is the only
 * ref that the protected Cloud release workflow may deploy to that environment.
 */
export const RELEASE_AUTHORITY_TARGETS = Object.freeze({
  staging: Object.freeze({
    canonicalRef: "refs/heads/staging",
    worker: "https://api-staging.eliza.app",
    pages: Object.freeze([
      "https://staging.eliza.app",
      "https://cloud-staging.eliza.app",
      "https://staging.eliza-app.pages.dev",
    ]),
  }),
  production: Object.freeze({
    canonicalRef: "refs/heads/main",
    worker: "https://api.eliza.app",
    pages: Object.freeze(["https://eliza.app", "https://cloud.eliza.app"]),
  }),
});

export class ReleaseAuthorityError extends Error {
  constructor(reasons) {
    super(`Release authority failed: ${reasons.join(", ")}`);
    this.name = "ReleaseAuthorityError";
    this.code = "RELEASE_AUTHORITY_FAILED";
    this.reasons = reasons;
  }
}

function normalizeSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Pure decision core. `onCanonical` is true/false/null for whether the single
 * served commit is reachable from the canonical branch head; it is ignored
 * when the surfaces do not agree on one commit.
 *
 * @param {object} input
 * @param {"staging"|"production"} input.environment
 * @param {{ url: string, commit: string|null, environment: string|null }} input.worker
 * @param {Array<{ url: string, commit: string|null }>} input.pages
 * @param {string|null} [input.expectedSha]
 * @param {boolean|null} [input.onCanonical]
 */
export function decideReleaseAuthority({
  environment,
  worker,
  pages,
  expectedSha = null,
  onCanonical = null,
}) {
  const reasons = [];
  const workerCommit = normalizeSha(worker?.commit);
  if (!workerCommit) reasons.push("worker_commit_missing");
  if (worker?.environment !== environment) {
    reasons.push("worker_environment_mismatch");
  }
  const pagesSurfaces = (Array.isArray(pages) ? pages : []).map((surface) => ({
    url: surface.url,
    commit: normalizeSha(surface.commit),
  }));
  if (pagesSurfaces.length === 0) reasons.push("pages_surfaces_missing");
  if (pagesSurfaces.some((surface) => !surface.commit)) {
    reasons.push("pages_commit_missing");
  }
  const servedCommits = new Set(
    [workerCommit, ...pagesSurfaces.map((surface) => surface.commit)].filter(
      Boolean,
    ),
  );
  const servedCommit = servedCommits.size === 1 ? [...servedCommits][0] : null;
  if (servedCommits.size > 1) reasons.push("pages_worker_split");

  const normalizedExpected =
    expectedSha === null || expectedSha === undefined
      ? null
      : normalizeSha(expectedSha);
  if (expectedSha && !normalizedExpected) reasons.push("expected_sha_invalid");
  if (
    normalizedExpected &&
    servedCommit &&
    servedCommit !== normalizedExpected
  ) {
    reasons.push("served_commit_not_expected");
  }
  if (servedCommit) {
    if (onCanonical === false) reasons.push("served_commit_off_canonical");
    if (onCanonical === null || onCanonical === undefined) {
      reasons.push("canonical_membership_unknown");
    }
  }

  return {
    schema: RELEASE_AUTHORITY_SCHEMA,
    environment,
    ok: reasons.length === 0,
    reasons,
    servedCommit,
    expectedSha: normalizedExpected,
    onCanonical: servedCommit ? (onCanonical ?? null) : null,
    worker: {
      url: worker?.url ?? null,
      commit: workerCommit,
      environmentMatches: worker?.environment === environment,
    },
    pages: pagesSurfaces,
  };
}

async function fetchWorkerStamp(url, fetchImpl) {
  const target = `${url.replace(/\/+$/, "")}/api/health`;
  try {
    const response = await fetchImpl(target, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { commit: null, environment: null };
    const body = await response.text();
    let commit = null;
    try {
      const parsed = JSON.parse(body);
      commit = typeof parsed?.commit === "string" ? parsed.commit : null;
    } catch {
      // error-policy:J3 an unparseable health body is reported as a missing
      // commit, which fails the authority decision closed.
      commit = null;
    }
    return { commit, environment: parseServedEnvironment(body) };
  } catch {
    // error-policy:J3 an unreachable Worker is reported as a missing commit,
    // which fails the authority decision closed.
    return { commit: null, environment: null };
  }
}

/**
 * Reads every public stamp for `environment` and decides release authority.
 * @param {object} options
 * @param {"staging"|"production"} options.environment
 * @param {string|null} [options.expectedSha]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(servedCommit: string, canonicalRef: string) => boolean|null} [options.isOnCanonical]
 * @param {typeof RELEASE_AUTHORITY_TARGETS.staging} [options.target]
 */
export async function checkReleaseAuthority({
  environment,
  expectedSha = null,
  fetchImpl = fetch,
  isOnCanonical = isServedCommitReachable,
  target = RELEASE_AUTHORITY_TARGETS[environment],
}) {
  if (!target) {
    throw new ReleaseAuthorityError(["environment_unsupported"]);
  }
  const worker = {
    url: target.worker,
    ...(await fetchWorkerStamp(target.worker, fetchImpl)),
  };
  const pages = [];
  for (const url of target.pages) {
    pages.push({ url, commit: await fetchServedCommit(url, { fetchImpl }) });
  }
  const preliminary = decideReleaseAuthority({
    environment,
    worker,
    pages,
    expectedSha,
    onCanonical: true,
  });
  let onCanonical = null;
  if (preliminary.servedCommit) {
    try {
      onCanonical = isOnCanonical(
        preliminary.servedCommit,
        target.canonicalRef,
      );
    } catch {
      // error-policy:J3 an indeterminate ancestry probe is reported as
      // canonical_membership_unknown and fails the decision closed.
      onCanonical = null;
    }
  }
  return {
    ...decideReleaseAuthority({
      environment,
      worker,
      pages,
      expectedSha,
      onCanonical,
    }),
    canonicalRef: target.canonicalRef,
  };
}

function isServedCommitReachable(servedCommit, canonicalRef) {
  const head = resolveCanonicalHead(canonicalRef);
  if (head === servedCommit) return true;
  return isAncestor(servedCommit, head);
}

function parseArgs(argv) {
  const parsed = { environment: null, expectedSha: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--environment", "--expected-sha", "--output"].includes(flag)) {
      throw new Error(`Unsupported argument: ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    if (flag === "--environment") parsed.environment = value;
    if (flag === "--expected-sha") parsed.expectedSha = value;
    if (flag === "--output") parsed.output = value;
  }
  if (!Object.hasOwn(RELEASE_AUTHORITY_TARGETS, parsed.environment ?? "")) {
    throw new Error("--environment must be staging or production");
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await checkReleaseAuthority({
    environment: args.environment,
    expectedSha: args.expectedSha,
  });
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(
      summary,
      [
        `### ${args.environment} release authority: ${report.ok ? "PASS" : "FAIL"}`,
        "",
        `- served commit: \`${report.servedCommit ?? "split-or-missing"}\``,
        `- canonical ref: \`${report.canonicalRef}\` (reachable: ${report.onCanonical ?? "unknown"})`,
        `- reasons: ${report.reasons.length ? report.reasons.join(", ") : "none"}`,
        "",
      ].join("\n"),
    );
  }
  if (!report.ok) {
    throw new ReleaseAuthorityError(report.reasons);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // error-policy:J1 the CLI boundary emits only closed reason codes.
    const reasons =
      error instanceof ReleaseAuthorityError
        ? error.reasons.join(", ")
        : error instanceof Error
          ? error.message
          : "unknown";
    console.error(`::error::Release authority check failed: ${reasons}`);
    process.exitCode = 1;
  });
}
