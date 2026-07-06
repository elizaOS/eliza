/**
 * Provenance collection for evidence bundles: which commit, branch, runner,
 * and environment produced a run. Git facts come from `git rev-parse` via
 * execFile and fail loud when the directory is not a repo — a bundle without
 * real provenance is worthless to the certification gate, so nothing here
 * degrades to a placeholder. The env fingerprint is a small allowlist (runtime
 * versions, platform, lane, tier); the full environment is never captured
 * because it contains secrets.
 */

import { execFileSync } from "node:child_process";
import { EvidenceError } from "./errors.ts";
import { RUNNER_KINDS, type RunnerKind, type Tier } from "./schema.ts";

/** Commit + branch facts collected from the repository at `repoRoot`. */
export interface GitProvenance {
  /** Full 40-hex commit sha of HEAD. */
  commit: string;
  /** Current branch name; `HEAD` when detached (honest, not repaired). */
  branch: string;
}

function gitOutput(repoRoot: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // error-policy:J2 context-adding rethrow — git failing means no real
    // provenance exists; the bundle must not be created with fabricated facts.
    throw new EvidenceError(
      `git provenance unavailable: \`git ${args.join(" ")}\` failed in ${repoRoot}`,
      {
        code: "GIT_PROVENANCE_UNAVAILABLE",
        cause: error,
        context: { repoRoot },
      },
    );
  }
}

/** Collect HEAD commit and branch from the git repository at `repoRoot`. */
export function collectGitProvenance(repoRoot: string): GitProvenance {
  const commit = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new EvidenceError(
      `git rev-parse HEAD returned a non-sha value: ${commit}`,
      { code: "GIT_PROVENANCE_UNAVAILABLE", context: { repoRoot, commit } },
    );
  }
  const branch = gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { commit, branch };
}

/**
 * Resolve the runner kind: explicit `ELIZA_EVIDENCE_RUNNER` wins (and must be
 * valid — a typo must not silently downgrade a vast run to `local`), then a
 * truthy `CI` env means `ci`, else `local`.
 */
export function resolveRunnerKind(
  env: Record<string, string | undefined>,
): RunnerKind {
  const explicit = env.ELIZA_EVIDENCE_RUNNER;
  if (explicit !== undefined && explicit !== "") {
    if (!(RUNNER_KINDS as readonly string[]).includes(explicit)) {
      throw new EvidenceError(
        `ELIZA_EVIDENCE_RUNNER must be one of ${RUNNER_KINDS.join("|")}, got: ${explicit}`,
        { code: "RUNNER_KIND_INVALID", context: { explicit } },
      );
    }
    return explicit as RunnerKind;
  }
  const ci = env.CI;
  if (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") {
    return "ci";
  }
  return "local";
}

/** Process facts used by {@link buildEnvFingerprint}; injectable for tests. */
export interface ProcessFacts {
  nodeVersion: string;
  bunVersion?: string;
  platform: string;
  arch: string;
}

function defaultProcessFacts(): ProcessFacts {
  return {
    nodeVersion: process.version,
    ...(process.versions.bun !== undefined
      ? { bunVersion: process.versions.bun }
      : {}),
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Build the allowlisted env fingerprint for `meta.json`. Keys are stable:
 * `node`, `bun` (only under a bun runtime), `platform`, `arch`, `tier`, and
 * `testLane` (only when `TEST_LANE` is set).
 */
export function buildEnvFingerprint(
  tier: Tier,
  env: Record<string, string | undefined> = process.env,
  facts: ProcessFacts = defaultProcessFacts(),
): Record<string, string> {
  const fingerprint: Record<string, string> = {
    node: facts.nodeVersion,
    platform: facts.platform,
    arch: facts.arch,
    tier,
  };
  if (facts.bunVersion !== undefined) {
    fingerprint.bun = facts.bunVersion;
  }
  if (env.TEST_LANE !== undefined && env.TEST_LANE !== "") {
    fingerprint.testLane = env.TEST_LANE;
  }
  return fingerprint;
}
