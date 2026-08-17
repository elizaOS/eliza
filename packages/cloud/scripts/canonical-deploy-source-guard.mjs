#!/usr/bin/env node
/**
 * Fails closed when a canonical Cloud release no longer owns its branch head.
 *
 * Admission can precede a protected-environment wait or a long serialized
 * release queue. This guard therefore resolves the authoritative remote ref at
 * each provider mutation boundary instead of trusting the earlier admission.
 * Explicit forced dispatches remain the only supported stale-SHA rollback path.
 *
 * With --neutral-when-superseded, a staging push may exit 0 only when the run
 * SHA is an ancestor of the new head AND GitHub reports a non-cancelled newer
 * Cloud CF Deploy push run for that exact head. Ancestry alone is insufficient:
 * path-filtered commits and manual production dispatches may have no successor.
 * Divergence, missing successor proof, and unverifiable state all fail hard.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  execFileSync,
  spawnSync,
} from "../../scripts/lib/spawn-sync-captured.mjs";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_REFS = new Set(["refs/heads/develop", "refs/heads/main"]);
const ACTIVE_WORKFLOW_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

function normalizeSha(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return COMMIT_SHA_PATTERN.test(normalized) ? normalized : null;
}

/**
 * Parses the exact one-line response expected from `git ls-remote`.
 * @param {string} output
 * @param {string} canonicalRef
 * @returns {string|null}
 */
export function parseCanonicalRemoteHead(output, canonicalRef) {
  if (typeof output !== "string" || !CANONICAL_REFS.has(canonicalRef)) {
    return null;
  }
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  if (records.length !== 1) return null;
  const [sha, ref, ...extra] = records[0];
  if (extra.length > 0 || ref !== canonicalRef) return null;
  return normalizeSha(sha);
}

/**
 * Makes the strict source-ownership decision without performing I/O.
 *
 * `runShaIsAncestorOfHead` is the result of an external ancestry probe for the
 * mismatch case: `true` classifies the mismatch as a benign fast-forward
 * supersession (`superseded_source`, neutral-eligible), `false` as divergence
 * (`divergent_source`, always fatal). When the probe was not performed the
 * mismatch stays a fatal `superseded_source` — fail closed.
 * @param {object} input
 * @param {string|null|undefined} input.runSha
 * @param {string|null|undefined} input.canonicalRef
 * @param {string|null|undefined} input.canonicalHead
 * @param {boolean} [input.force]
 * @param {boolean|null} [input.runShaIsAncestorOfHead]
 * @param {boolean} [input.successorRunOwnsHead]
 */
export function decideCanonicalDeploySource({
  runSha,
  canonicalRef,
  canonicalHead,
  force = false,
  runShaIsAncestorOfHead = null,
  successorRunOwnsHead = false,
}) {
  const normalizedRun = normalizeSha(runSha);
  const normalizedHead = normalizeSha(canonicalHead);
  const normalizedRef =
    typeof canonicalRef === "string" ? canonicalRef.trim() : "";

  if (!normalizedRun) {
    return { allowed: false, reason: "invalid_run_sha" };
  }
  if (!CANONICAL_REFS.has(normalizedRef)) {
    return { allowed: false, reason: "invalid_canonical_ref" };
  }
  if (force) {
    return {
      allowed: true,
      reason: "forced",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
      canonicalHead: normalizedHead,
    };
  }
  if (!normalizedHead) {
    return {
      allowed: false,
      reason: "canonical_head_unresolved",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
    };
  }
  if (normalizedRun !== normalizedHead) {
    if (runShaIsAncestorOfHead === false) {
      return {
        allowed: false,
        neutral: false,
        reason: "divergent_source",
        runSha: normalizedRun,
        canonicalRef: normalizedRef,
        canonicalHead: normalizedHead,
      };
    }
    return {
      allowed: false,
      neutral: runShaIsAncestorOfHead === true && successorRunOwnsHead === true,
      reason: "superseded_source",
      runSha: normalizedRun,
      canonicalRef: normalizedRef,
      canonicalHead: normalizedHead,
    };
  }
  return {
    allowed: true,
    reason: "current_source",
    runSha: normalizedRun,
    canonicalRef: normalizedRef,
    canonicalHead: normalizedHead,
  };
}

/**
 * Accepts only an active develop push run of Cloud CF Deploy for the exact
 * canonical head. A completed success may still be a no-op (release skipped or
 * superseded), so completed runs are not sufficient ownership proof.
 * @param {unknown} payload
 * @param {{canonicalHead: string, currentRunId: string}} expected
 */
export function hasEligibleSuccessorReleaseRun(
  payload,
  { canonicalHead, currentRunId },
) {
  if (
    payload == null ||
    typeof payload !== "object" ||
    !("workflow_runs" in payload) ||
    !Array.isArray(payload.workflow_runs)
  ) {
    return false;
  }
  return payload.workflow_runs.some((run) => {
    if (run == null || typeof run !== "object") return false;
    const exactIdentity =
      String(run.id) !== currentRunId &&
      normalizeSha(run.head_sha) === canonicalHead &&
      run.head_branch === "develop" &&
      run.event === "push";
    if (!exactIdentity) return false;
    return (
      ACTIVE_WORKFLOW_RUN_STATUSES.has(run.status) && run.conclusion == null
    );
  });
}

export async function proveSuccessorReleaseRun(
  canonicalHead,
  environment = process.env,
  fetchImpl = fetch,
) {
  const repository = environment.GITHUB_REPOSITORY?.trim();
  const currentRunId = environment.GITHUB_RUN_ID?.trim();
  const token = environment.GITHUB_TOKEN?.trim();
  const apiUrl = environment.GITHUB_API_URL?.trim() || "https://api.github.com";
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is required for successor-run proof");
  }
  if (!currentRunId || !/^\d+$/.test(currentRunId)) {
    throw new Error("GITHUB_RUN_ID is required for successor-run proof");
  }
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for successor-run proof");
  }
  const url = new URL(
    `repos/${repository}/actions/workflows/cloud-cf-deploy.yml/runs`,
    apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`,
  );
  url.searchParams.set("branch", "develop");
  url.searchParams.set("event", "push");
  url.searchParams.set("head_sha", canonicalHead);
  url.searchParams.set("exclude_pull_requests", "true");
  url.searchParams.set("per_page", "100");
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Successor-run lookup failed with GitHub HTTP ${response.status}`,
    );
  }
  const payload = await response.json();
  return hasEligibleSuccessorReleaseRun(payload, {
    canonicalHead,
    currentRunId,
  });
}

function parseArgs(argv) {
  const parsed = {
    runSha: null,
    canonicalRef: null,
    force: false,
    neutralWhenSuperseded: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--neutral-when-superseded") {
      parsed.neutralWhenSuperseded = true;
    } else if (argument === "--run-sha") {
      parsed.runSha = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--canonical-ref") {
      parsed.canonicalRef = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--run-sha=")) {
      parsed.runSha = argument.slice("--run-sha=".length);
    } else if (argument.startsWith("--canonical-ref=")) {
      parsed.canonicalRef = argument.slice("--canonical-ref=".length);
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  return parsed;
}

function resolveCanonicalHead(canonicalRef) {
  const output = execFileSync(
    "git",
    ["ls-remote", "--exit-code", "origin", canonicalRef],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    },
  ).toString();
  const head = parseCanonicalRemoteHead(output, canonicalRef);
  if (!head) {
    throw new Error(`Remote returned no exact commit for ${canonicalRef}`);
  }
  return head;
}

/**
 * Probes whether the run SHA is a strict git ancestor of the canonical head.
 * Fetches the head commit's history treelessly so the probe stays cheap in a
 * shallow CI checkout; any probe failure propagates so the caller fails closed.
 * @param {string} runSha
 * @param {string} canonicalHead
 * @returns {boolean}
 */
function runShaIsAncestorOfCanonicalHead(runSha, canonicalHead) {
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--filter=tree:0",
      "origin",
      canonicalHead,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
  );
  const probe = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", runSha, canonicalHead],
    { encoding: "utf8", timeout: 60000 },
  );
  if (probe.status === 0) return true;
  if (probe.status === 1) return false;
  throw new Error(
    `Ancestry probe for ${runSha} under ${canonicalHead} failed: ${probe.stderr || probe.error?.message || `exit ${probe.status}`}`,
  );
}

function reportDecision(decision, { neutralized = false } = {}) {
  const prefix = decision.allowed
    ? "Canonical source accepted"
    : neutralized
      ? "::notice::Canonical source superseded"
      : "::error::Canonical source rejected";
  console.log(`${prefix}: ${decision.reason}`);
  if (decision.runSha) console.log(`runSha=${decision.runSha}`);
  if (decision.canonicalRef)
    console.log(`canonicalRef=${decision.canonicalRef}`);
  if (decision.canonicalHead)
    console.log(`canonicalHead=${decision.canonicalHead}`);
}

function emitNeutralSupersession(decision, environment = process.env) {
  console.log(
    `::notice::Skipping mutation: ${decision.canonicalRef} advanced to ${decision.canonicalHead} and run SHA ${decision.runSha} is an ancestor of it. A newer run owns this release.`,
  );
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, "superseded=true\n");
  }
  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      `Superseded canonical source: ${decision.canonicalRef} advanced to ${decision.canonicalHead}; run SHA ${decision.runSha} is an ancestor, so the mutation was skipped neutrally.\n`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preliminary = decideCanonicalDeploySource({
    ...args,
    canonicalHead: null,
  });
  if (
    preliminary.reason === "invalid_run_sha" ||
    preliminary.reason === "invalid_canonical_ref"
  ) {
    reportDecision(preliminary);
    process.exitCode = 1;
    return;
  }
  if (args.force) {
    reportDecision(preliminary);
    return;
  }

  const canonicalHead = resolveCanonicalHead(args.canonicalRef);
  let decision = decideCanonicalDeploySource({ ...args, canonicalHead });
  if (
    !decision.allowed &&
    decision.reason === "superseded_source" &&
    args.neutralWhenSuperseded
  ) {
    const runShaIsAncestorOfHead = runShaIsAncestorOfCanonicalHead(
      decision.runSha,
      canonicalHead,
    );
    const successorRunOwnsHead =
      runShaIsAncestorOfHead &&
      args.canonicalRef === "refs/heads/develop" &&
      (await proveSuccessorReleaseRun(canonicalHead));
    decision = decideCanonicalDeploySource({
      ...args,
      canonicalHead,
      runShaIsAncestorOfHead,
      successorRunOwnsHead,
    });
  }
  const neutralized =
    decision.neutral === true && args.neutralWhenSuperseded === true;
  reportDecision(decision, { neutralized });
  if (decision.allowed) return;
  if (neutralized) {
    emitNeutralSupersession(decision);
    return;
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // error-policy:J1 the CLI boundary translates remote resolution failures
    // into a visible, fail-closed workflow result before provider mutation.
    console.error(
      `::error::Canonical source could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

export { parseArgs, resolveCanonicalHead };
