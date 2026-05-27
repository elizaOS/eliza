import { execSync } from "node:child_process";
import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { dirExists, fileExists, readUtf8Safe } from "../util/fs.js";

export const gitleaksWorkflow: Check = {
  id: "CC8.1-gitleaks-workflow",
  title: ".github/workflows/gitleaks.yml exists",
  tsc: ["CC8.1", "CC6.8"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      join(ctx.elizaRoot, ".github/workflows/gitleaks.yml"),
      join(ctx.outerRoot, ".github/workflows/gitleaks.yml"),
    ];
    const found = candidates.filter(fileExists);
    return found.length > 0
      ? {
          status: "pass",
          evidence: `gitleaks workflow present.`,
          files: found,
        }
      : {
          status: "fail",
          evidence: `gitleaks workflow missing.`,
          files: candidates,
        };
  },
};

export const noCommittedSecrets: Check = {
  id: "CC8.1-no-committed-secrets",
  title: "gitleaks reports no high-severity findings at HEAD",
  tsc: ["CC6.1", "CC8.1"],
  severity: "critical",
  async run(ctx): Promise<CheckResult> {
    let installed = false;
    try {
      execSync("gitleaks version", { stdio: "ignore" });
      installed = true;
    } catch {
      installed = false;
    }
    if (!installed) {
      return {
        status: "skip",
        evidence: `gitleaks not installed — install with 'brew install gitleaks' to run this check locally. CI workflow runs it on every PR.`,
      };
    }
    try {
      execSync(
        `gitleaks detect --no-banner --redact --source "${ctx.elizaRoot}" --log-opts "-1" --timeout 120`,
        {
          stdio: "pipe",
        },
      );
      return {
        status: "pass",
        evidence: `gitleaks: zero findings at HEAD.`,
      };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
      return {
        status: "fail",
        evidence: `gitleaks reported findings:\n${(stdout + stderr).slice(0, 4000)}`,
      };
    }
  },
};

function listWorkflowFiles(root: string): string[] {
  const dir = join(root, ".github/workflows");
  if (!dirExists(dir)) return [];
  // synchronous shallow listing is fine — workflows are flat
  // walk() is async; do a simple readdir here.
  // We need to avoid pulling in a dep, so use fs.readdirSync.
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f));
}

export const workflowPermissions: Check = {
  id: "CC8.1-workflow-permissions",
  title: "Every workflow declares an explicit permissions: block",
  tsc: ["CC8.1", "CC6.3"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const files = [
      ...listWorkflowFiles(ctx.elizaRoot),
      ...listWorkflowFiles(ctx.outerRoot),
    ];
    const missing: string[] = [];
    for (const f of files) {
      const src = readUtf8Safe(f);
      if (!src) continue;
      // top-level "permissions:" (not nested inside a job).
      // Heuristic: a permissions: line that is unindented or only one level.
      if (!/^permissions\s*:/m.test(src)) {
        missing.push(f);
      }
    }
    if (files.length === 0) {
      return {
        status: "warn",
        evidence: `No workflow files found.`,
      };
    }
    if (missing.length === 0) {
      return {
        status: "pass",
        evidence: `${files.length} workflows; all declare top-level permissions:.`,
      };
    }
    return {
      status: "fail",
      evidence: `${missing.length}/${files.length} workflows lack a top-level permissions: block:\n${missing.slice(0, 20).join("\n")}${missing.length > 20 ? `\n…and ${missing.length - 20} more` : ""}`,
      files: missing.slice(0, 10),
    };
  },
};

const SHA_RE = /uses:\s*([^\s@#]+)@([^\s#]+)/g;

export const actionsPinnedBySha: Check = {
  id: "CC8.1-actions-pinned-by-sha",
  title: "All `uses:` references pin third-party actions by 40-char SHA",
  tsc: ["CC8.1", "CC6.8"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const files = [
      ...listWorkflowFiles(ctx.elizaRoot),
      ...listWorkflowFiles(ctx.outerRoot),
    ];
    const violations: string[] = [];
    let totalRefs = 0;
    for (const f of files) {
      const src = readUtf8Safe(f);
      if (!src) continue;
      const inspectableSource = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      SHA_RE.lastIndex = 0;
      let match = SHA_RE.exec(inspectableSource);
      while (match !== null) {
        const [, actionRef, ver] = match;
        match = SHA_RE.exec(inspectableSource);
        if (!actionRef) continue;
        totalRefs++;
        // Skip local actions (./...) and repo-relative reusable workflows (start with org/repo/.github/).
        if (actionRef.startsWith("./")) continue;
        if (/^[^/]+\/[^/]+\/\.github\/workflows\//.test(actionRef)) continue;
        if (!ver || !/^[0-9a-f]{40}$/.test(ver)) {
          violations.push(`${f}: ${actionRef}@${ver}`);
        }
      }
    }
    if (totalRefs === 0) {
      return { status: "warn", evidence: `No 'uses:' references found.` };
    }
    if (violations.length === 0) {
      return {
        status: "pass",
        evidence: `${totalRefs} action refs; all pinned by SHA.`,
      };
    }
    return {
      status: "fail",
      evidence: `${violations.length}/${totalRefs} action refs not pinned by SHA:\n${violations.slice(0, 30).join("\n")}${violations.length > 30 ? `\n…and ${violations.length - 30} more` : ""}`,
    };
  },
};
