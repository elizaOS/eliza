/**
 * Proves fork pull requests create only the canonical hosted CI workflow while
 * retaining develop compatibility, actionlint, and secret-scan coverage.
 *
 * Also locks the gitleaks "Scan changed commits" range semantics (#19687): the
 * pull-request path must scan `merge-base..head` (only PR-introduced commits),
 * the push path must keep its two-dot `before..sha` range, and an unresolvable
 * merge base must fail closed instead of silently narrowing the scan. The
 * diverged-graph suite executes the workflow's real range-selection shell over
 * a scratch git repository so the `git diff`/`git log` semantic mix-up cannot
 * recur.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowRoot = join(repoRoot, ".github", "workflows");

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      name?: string;
      if?: string;
      uses?: string;
      "runs-on"?: string;
      steps?: Array<{ name?: string; run?: string }>;
    }
  >;
};

function workflow(name: string, source?: string): Workflow {
  return Bun.YAML.parse(
    source ?? readFileSync(join(workflowRoot, name), "utf8"),
  ) as Workflow;
}

// The literal `run:` body of the gitleaks range-selection step. The contract
// tests exercise this exact shell so behavior is asserted against the shipped
// workflow, not a copy.
function scanChangedCommitsRun(ci: Workflow): string {
  const step = ci.jobs?.secrets?.steps?.find(
    (s) => s.name === "Scan changed commits",
  );
  if (!step?.run) {
    throw new Error("gitleaks 'Scan changed commits' step is missing a run body");
  }
  return step.run;
}

// Runs the real range-selection shell, but stops before the `gitleaks detect`
// invocation (gitleaks is not installed in this lane) and prints the computed
// range so the test can feed it back to `git`.
function runScanScript(
  scanScript: string,
  cwd: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const gitleaksAt = scanScript.indexOf("gitleaks detect");
  if (gitleaksAt < 0) {
    throw new Error("scan step no longer invokes gitleaks detect");
  }
  const probe = `${scanScript.slice(0, gitleaksAt)}printf 'RANGE<<<%s>>>' "$range"\n`;
  const result = spawnSync("bash", ["-c", probe], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runRangeSelection(
  scanScript: string,
  cwd: string,
  env: Record<string, string>,
): string {
  const result = runScanScript(scanScript, cwd, env);
  if (result.status !== 0) {
    throw new Error(
      `range selection failed (status ${result.status}): ${result.stderr}`,
    );
  }
  const match = result.stdout.match(/RANGE<<<(.*)>>>/s);
  if (!match) {
    throw new Error(`range not emitted; stdout=${result.stdout}`);
  }
  return match[1];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-range-"));
  git(dir, ["init", "-q", "-b", "base"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Range Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commit(cwd: string, message: string): string {
  git(cwd, ["commit", "-q", "--allow-empty", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function assertForkPrDispatchContract(
  ciSource: string,
  developSource: string,
  gitleaksSource: string,
): void {
  const ci = workflow("ci.yml", ciSource);
  const develop = workflow("develop-pr.yml", developSource);
  const gitleaks = workflow("gitleaks.yml", gitleaksSource);

  expect(ci.on?.pull_request).toBeDefined();
  expect(ci.permissions).toEqual({ contents: "read" });
  expect(ci.jobs?.develop_pr).toMatchObject({
    if: "github.event_name == 'pull_request' && github.base_ref == 'develop'",
    uses: "./.github/workflows/develop-pr.yml",
  });

  expect(develop.on?.pull_request).toBeUndefined();
  expect(develop.on?.workflow_call).toBeDefined();
  expect(develop.permissions).toEqual({ contents: "read" });
  expect(
    Object.values(develop.jobs ?? {}).every(
      (job) =>
        typeof job["runs-on"] === "string" &&
        job["runs-on"].startsWith("ubuntu-"),
    ),
  ).toBe(true);
  expect(developSource).not.toContain("secrets.");
  expect(developSource).not.toContain("self-hosted");
  expect(developSource).toContain("install-workflow-linters.sh");
  expect(developSource).toContain("actionlint");

  expect(gitleaks.on?.pull_request).toBeUndefined();
  expect(gitleaks.on?.push).toBeDefined();

  const secretScan = ci.jobs?.secrets;
  expect(secretScan?.name).toBe("gitleaks");
  expect(secretScan?.["runs-on"]).toBe("ubuntu-24.04");
  const scanScript = scanChangedCommitsRun(ci);
  expect(JSON.stringify(secretScan)).toContain("gitleaks detect");
  // The pull-request path must scan exactly the PR-introduced commits, so it
  // resolves the real merge base and passes a two-dot `merge-base..head` range
  // to `git log`. A three-dot `BASE...HEAD` range is the symmetric difference
  // and re-flags base-only commits the branch merely inherited (#19687).
  expect(scanScript).toContain('range="${MERGE_BASE}..${HEAD_SHA}"');
  expect(scanScript).toContain('git merge-base "$BASE_SHA" "$HEAD_SHA"');
  expect(scanScript).not.toContain(
    "$" + "{BASE_SHA}..." + "$" + "{HEAD_SHA}",
  );
  // The push path keeps its own two-dot `before..sha` range unchanged.
  expect(scanScript).toContain('range="${BASE_SHA}..${HEAD_SHA}"');
  // An unresolvable merge base must fail closed with a non-zero exit rather
  // than fall back to scanning only the head commit.
  expect(scanScript).not.toContain("|| true");
  expect(scanScript).toMatch(/exit 1/);
  const required = JSON.stringify(ci.jobs?.required);
  expect(required).toContain("develop_pr");
  expect(required).toContain("needs.develop_pr.result");
  expect(required).toContain("secrets");
}

describe("fork pull-request workflow dispatch (#18443)", () => {
  const ciSource = readFileSync(join(workflowRoot, "ci.yml"), "utf8");
  const developSource = readFileSync(
    join(workflowRoot, "develop-pr.yml"),
    "utf8",
  );
  const gitleaksSource = readFileSync(
    join(workflowRoot, "gitleaks.yml"),
    "utf8",
  );

  test("keeps PR validation inside the canonical hosted workflow", () => {
    expect(() =>
      assertForkPrDispatchContract(ciSource, developSource, gitleaksSource),
    ).not.toThrow();
  });

  test("scans merge-base..head for a diverged pull request", () => {
    const scanScript = scanChangedCommitsRun(workflow("ci.yml", ciSource));
    const repo = makeTempRepo();
    try {
      // A shared root is the true branch point (merge base). The base branch
      // then advances by one base-only commit while the PR adds one head-only
      // commit, so `BASE...HEAD` (symmetric difference) contains both while
      // `merge-base..HEAD` contains only the PR commit.
      const root = commit(repo, "root");
      const baseOnly = commit(repo, "base-only");
      git(repo, ["checkout", "-q", "-b", "pr", root]);
      const headOnly = commit(repo, "head-only");

      const symmetric = git(repo, ["rev-list", `${baseOnly}...${headOnly}`])
        .split("\n")
        .filter(Boolean);
      expect(symmetric).toContain(baseOnly);
      expect(symmetric).toContain(headOnly);

      const range = runRangeSelection(scanScript, repo, {
        EVENT_NAME: "pull_request",
        BASE_SHA: baseOnly,
        HEAD_SHA: headOnly,
      });
      const scanned = git(repo, ["rev-list", range])
        .split("\n")
        .filter(Boolean);
      expect(scanned).toEqual([headOnly]);
      expect(scanned).not.toContain(baseOnly);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("keeps the two-dot before..sha range for push events", () => {
    const scanScript = scanChangedCommitsRun(workflow("ci.yml", ciSource));
    const repo = makeTempRepo();
    try {
      const before = commit(repo, "before");
      const pushed = commit(repo, "pushed");
      const range = runRangeSelection(scanScript, repo, {
        EVENT_NAME: "push",
        BASE_SHA: before,
        HEAD_SHA: pushed,
      });
      expect(range).toBe(`${before}..${pushed}`);
      expect(git(repo, ["rev-list", range]).split("\n").filter(Boolean)).toEqual(
        [pushed],
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fails closed when the merge base cannot be resolved", () => {
    const scanScript = scanChangedCommitsRun(workflow("ci.yml", ciSource));
    const repo = makeTempRepo();
    try {
      // Two unrelated root histories share no merge base, so `git merge-base`
      // exits non-zero and the step must fail rather than narrow the scan.
      const base = commit(repo, "base-root");
      git(repo, ["checkout", "-q", "--orphan", "orphan"]);
      const head = commit(repo, "orphan-root");
      const result = runScanScript(scanScript, repo, {
        EVENT_NAME: "pull_request",
        BASE_SHA: base,
        HEAD_SHA: head,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("could not resolve the merge base");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("fails if either specialized workflow restores a PR trigger", () => {
    const directDevelop = developSource.replace(
      "  workflow_call:",
      "  pull_request:\n    branches: [develop]",
    );
    expect(() =>
      assertForkPrDispatchContract(ciSource, directDevelop, gitleaksSource),
    ).toThrow();

    const directGitleaks = gitleaksSource.replace(
      "on:\n  push:",
      'on:\n  pull_request:\n    branches: ["main", "develop"]\n  push:',
    );
    expect(() =>
      assertForkPrDispatchContract(ciSource, developSource, directGitleaks),
    ).toThrow();
  });
});
