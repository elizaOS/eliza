#!/usr/bin/env node

/**
 * CLI wrapper for the cloud deploy freshness guard (#14083).
 *
 * Usage (in a deploy job, BEFORE the wrangler deploy step):
 *   node packages/cloud/scripts/deploy-freshness-guard-cli.ts \
 *     --run-sha "$GITHUB_SHA" \
 *     --served-url "https://staging.eliza.app" \
 *     [--served-path "/api/health"] \
 *     --canonical-ref refs/heads/staging \
 *     [--force]
 *
 * `--canonical-ref` names the branch whose head attests a served commit. A
 * newer served commit that is not reachable from that head is an unattested
 * upload and never suppresses the deploy (#27229). Omitting the ref leaves the
 * served commit unattested, so the guard deploys rather than skips.
 *
 * Emits `should_deploy=true|false` to $GITHUB_OUTPUT (and reason/detail), so the
 * deploy step can gate on `if: steps.freshness.outputs.should_deploy == 'true'`.
 * Always exits 0 (a signal-fetch failure must not fail the deploy — the guard is
 * fail-open; see decideDeployFreshness).
 *
 * Ancestry is computed with `git merge-base --is-ancestor`. The deploy job's
 * checkout is shallow (`--depth=1`), so this CLI fetches BOTH commits into the
 * repo (best-effort, bounded) before asking git. If either commit can't be
 * fetched, ancestry is reported as `null` and the guard deploys (fail-open).
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "../../scripts/lib/spawn-sync-captured.ts";

import { resolveCanonicalHead } from "./canonical-deploy-source-guard.ts";
import {
  decideDeployFreshness,
  fetchServedCommit,
} from "./deploy-freshness-guard.ts";

function parseArgs(argv) {
  const out = {
    runSha: null,
    servedUrl: null,
    servedPath: null,
    servedCommit: null,
    canonicalRef: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      out.force = true;
    } else if (arg === "--canonical-ref") {
      i += 1;
      out.canonicalRef = argv[i];
    } else if (arg.startsWith("--canonical-ref=")) {
      out.canonicalRef = arg.slice("--canonical-ref=".length);
    } else if (arg === "--run-sha") {
      i += 1;
      out.runSha = argv[i];
    } else if (arg === "--served-url") {
      i += 1;
      out.servedUrl = argv[i];
    } else if (arg === "--served-path") {
      i += 1;
      out.servedPath = argv[i];
    } else if (arg === "--served-commit") {
      i += 1;
      out.servedCommit = argv[i];
    } else if (arg.startsWith("--run-sha=")) {
      out.runSha = arg.slice("--run-sha=".length);
    } else if (arg.startsWith("--served-url=")) {
      out.servedUrl = arg.slice("--served-url=".length);
    } else if (arg.startsWith("--served-path=")) {
      out.servedPath = arg.slice("--served-path=".length);
    } else if (arg.startsWith("--served-commit=")) {
      out.servedCommit = arg.slice("--served-commit=".length);
    }
  }
  return out;
}

function git(args) {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  })
    .toString()
    .trim();
}

function isShallowRepository() {
  try {
    return git(["rev-parse", "--is-shallow-repository"]) === "true";
  } catch {
    return false;
  }
}

function hydrateHistoryForAncestry() {
  if (!isShallowRepository()) return true;
  try {
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "--unshallow",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function checkAncestry(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    return true;
  } catch (error) {
    // error-policy:J3 Git exit 1 is the documented negative result; every
    // other failure remains explicitly indeterminate so the guard fails open.
    return /** @type {{ status?: number }} */ (error)?.status === 1
      ? false
      : null;
  }
}

/**
 * A positive result is conclusive even in a shallow repository. Checking both
 * directions lets the normal same-branch deploy and stale-run cases finish
 * without mistaking a shallow-boundary exit 1 for proof of divergence.
 */
function probeLinearAncestry(runSha, servedCommit) {
  if (checkAncestry(runSha, servedCommit) === true) return true;
  if (checkAncestry(servedCommit, runSha) === true) return false;
  return null;
}

function deepenRelevantHistoryForAncestry(runSha, servedCommit) {
  if (!isShallowRepository()) return null;
  for (const depth of [50, 200, 1000]) {
    try {
      execFileSync(
        "git",
        [
          "fetch",
          "--no-tags",
          `--depth=${depth}`,
          "origin",
          runSha,
          servedCommit,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        },
      );
    } catch {
      // error-policy:J1 The CLI boundary logs a sanitized fetch failure before
      // escalating; Git stderr and commit values are deliberately excluded.
      process.stderr.write(
        `deploy-freshness-guard: targeted ancestry fetch failed at depth ${depth}; probing retained history before escalation\n`,
      );
    }
    // A fetch can update one shallow boundary before failing. Probe the object
    // graph that Git retained before escalating to broader history.
    const result = probeLinearAncestry(runSha, servedCommit);
    if (result !== null) return result;
    if (!isShallowRepository()) {
      return checkAncestry(runSha, servedCommit);
    }
  }
  return null;
}

function commitExists(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort fetch a commit into the local repo so ancestry can be computed off
 * a shallow deploy checkout. Returns true if the commit is resolvable afterward.
 * @param {string} sha
 */
function ensureCommit(sha) {
  if (commitExists(sha)) return true;
  for (const depth of [50, 200, 1000]) {
    try {
      execFileSync(
        "git",
        ["fetch", "--no-tags", `--depth=${depth}`, "origin", sha],
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        },
      );
    } catch {
      // ignore — resolvability re-checked below
    }
    if (commitExists(sha)) return true;
  }
  try {
    execFileSync("git", ["fetch", "--no-tags", "--unshallow", "origin"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  } catch {
    try {
      execFileSync("git", ["fetch", "--no-tags", "origin"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000,
      });
    } catch {
      // ignore — resolvability re-checked below
    }
  }
  return commitExists(sha);
}

/**
 * merge-base --is-ancestor with fetch fallback. Returns true/false when the
 * relationship is determinable, null when it is not (missing commit / git error
 * / unrelated histories).
 * @param {string} runSha
 * @param {string} servedCommit
 * @returns {boolean|null}
 */
function isAncestor(runSha, servedCommit) {
  if (!ensureCommit(runSha) || !ensureCommit(servedCommit)) return null;
  const existing = probeLinearAncestry(runSha, servedCommit);
  if (existing !== null) return existing;
  const deepened = deepenRelevantHistoryForAncestry(runSha, servedCommit);
  if (deepened !== null) return deepened;
  if (!hydrateHistoryForAncestry()) return null;
  return checkAncestry(runSha, servedCommit);
}

/**
 * True when the served commit is reachable from the canonical branch head,
 * false when it provably is not, and null when the head or ancestry cannot be
 * resolved. Only `true` lets the guard treat a newer served build as released.
 * @param {string} servedCommit
 * @param {string} canonicalRef
 * @param {(ref: string) => string} [resolveHead]
 * @returns {boolean|null}
 */
function isServedCommitOnCanonicalRef(
  servedCommit,
  canonicalRef,
  resolveHead = resolveCanonicalHead,
) {
  let head = "";
  try {
    head = resolveHead(canonicalRef);
  } catch {
    // error-policy:J3 an unresolved canonical head is indeterminate; the
    // decision reports served_attestation_unknown and deploys.
    return null;
  }
  if (head === servedCommit) return true;
  return isAncestor(servedCommit, head);
}

function emitOutput(result) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions provides this path for step outputs.
  const outFile = process.env.GITHUB_OUTPUT;
  const shouldDeploy = result.decision === "deploy";
  const lines = [
    `should_deploy=${shouldDeploy}`,
    `decision=${result.decision}`,
    `reason=${result.reason}`,
  ];
  if (outFile) {
    fs.appendFileSync(outFile, `${lines.join("\n")}\n`);
  }
  const emoji = shouldDeploy ? "✅" : "⛔";
  if (result.reason === "served_commit_unattested") {
    // Surfaces the authority failure on the run page as well as in the log;
    // the protected release still deploys over the unattested build.
    console.log(
      "::warning::deploy-freshness-guard: served build is newer than this release but absent from the canonical branch (unattested upload); redeploying the protected release",
    );
  }
  console.log(
    `${emoji} deploy-freshness-guard: ${result.decision} (${result.reason})`,
  );
  console.log(`   ${result.detail}`);
  if (result.runSha) console.log(`   runSha=${result.runSha}`);
  if (result.servedCommit)
    console.log(`   servedCommit=${result.servedCommit}`);
}

async function main() {
  const {
    runSha,
    servedUrl,
    servedPath,
    servedCommit: servedCommitArg,
    canonicalRef,
    force,
  } = parseArgs(process.argv.slice(2));

  const servedCommit =
    servedCommitArg ??
    (servedUrl
      ? await fetchServedCommit(servedUrl, { stampPath: servedPath })
      : null);

  const result = decideDeployFreshness({
    runSha,
    servedCommit,
    force,
    isAncestor,
    isServedCommitOnCanonical: canonicalRef
      ? (commit) => isServedCommitOnCanonicalRef(commit, canonicalRef)
      : undefined,
  });

  emitOutput(result);
  // Always exit 0: the guard signals via should_deploy, never by failing the job.
  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    // Even an unexpected crash must fail-open: log and deploy.
    console.error(
      "deploy-freshness-guard-cli: unexpected error, failing open (deploy)",
    );
    console.error(err);
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions provides this path for step outputs.
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile) {
      fs.appendFileSync(
        outFile,
        "should_deploy=true\ndecision=deploy\nreason=guard_error\n",
      );
    }
    process.exit(0);
  });
}

export { isAncestor, isServedCommitOnCanonicalRef, parseArgs };
