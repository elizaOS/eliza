#!/usr/bin/env node

/**
 * Board-readiness audit for the LifeOps MVP project. Open project issues are
 * actionable for agents when they are either actively being implemented or
 * clearly blocked on owner/hardware/live-evidence work; this script keeps the
 * blocker labels and Project 15 status aligned so evidence gaps do not look
 * like unclaimed engineering work.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_REPO = "elizaOS/eliza";
const DEFAULT_PROJECT_OWNER = "elizaOS";
const DEFAULT_PROJECT_NUMBER = "15";
const BLOCKER_LABELS = new Set(["needs-human", "needs-shaw"]);
const REQUIRED_BLOCKED_STATUS = "Needs human review";

function usage() {
  return `Usage:
  node packages/scripts/check-mvp-board-readiness.mjs [--repo owner/repo] [--project-owner org] [--project-number n]
  node packages/scripts/check-mvp-board-readiness.mjs --issues-json issues.json --project-json project-items.json
  node packages/scripts/check-mvp-board-readiness.mjs --issues-json issues.json --issues-only [--json]
  node packages/scripts/check-mvp-board-readiness.mjs --issues-only [--json]

Options:
  --json          Print machine-readable report.
  --issues-only   Skip Project status lookup and check only open MVP blocker labels.
  --min-issues n  Fail if fewer than n open MVP issues are loaded.
  --no-fail      Exit 0 even when violations are found.`;
}

function parseArgs(argv) {
  const out = {
    repo: DEFAULT_REPO,
    projectOwner: DEFAULT_PROJECT_OWNER,
    projectNumber: DEFAULT_PROJECT_NUMBER,
    json: false,
    fail: true,
    issuesOnly: false,
    minIssues: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--issues-only") {
      out.issuesOnly = true;
    } else if (arg === "--no-fail") {
      out.fail = false;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (
      arg === "--repo" ||
      arg === "--project-owner" ||
      arg === "--project-number" ||
      arg === "--min-issues" ||
      arg === "--issues-json" ||
      arg === "--project-json"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      out[
        arg
          .slice(2)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
      ] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function parseNonNegativeInteger(value, flag) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return Number(value);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.stderr || result.stdout || result.error?.message || "unknown"
      }`,
    );
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function ghJson(args) {
  const output = run("gh", args);
  return output ? JSON.parse(output) : null;
}

export function normalizeRestIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url ?? issue.url,
    labels: labelNames(issue).map((name) => ({ name })),
  };
}

function fetchOpenProjectIssues(repo, projectOwner, projectNumber) {
  return ghJson([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `project:${projectOwner}/${projectNumber}`,
    "--limit",
    "500",
    "--json",
    "number,title,url,labels",
  ]).map(normalizeRestIssue);
}

function fetchProjectItems(projectOwner, projectNumber) {
  return ghJson([
    "project",
    "item-list",
    projectNumber,
    "--owner",
    projectOwner,
    "--limit",
    "300",
    "--format",
    "json",
  ]);
}

function labelNames(issue) {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function projectItemNumber(item) {
  return item.content?.number ?? item.number ?? null;
}

function normalizeRepository(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const githubPrefix = "https://github.com/";
  const normalized = value.startsWith(githubPrefix)
    ? value.slice(githubPrefix.length)
    : value;
  return normalized.replace(/\.git$/, "").toLowerCase();
}

function projectItemRepository(item) {
  return normalizeRepository(
    item.content?.repository ?? item.repository ?? item.content?.url,
  );
}

/**
 * True when a project card belongs to `repo`. Cards carrying no repository
 * signal at all are kept — a metadata gap must widen the audit, not silently
 * shrink it. Shared by the closeout audit so board, readiness, and evidence
 * analyzers scope cards identically (#15852).
 */
export function projectItemMatchesRepo(item, repo = DEFAULT_REPO) {
  const expectedRepo = normalizeRepository(repo);
  const itemRepo = projectItemRepository(item);
  return !expectedRepo || !itemRepo || itemRepo === expectedRepo;
}

export function normalizeProjectItems(payload, repo = DEFAULT_REPO) {
  const items = Array.isArray(payload) ? payload : (payload.items ?? []);
  const byNumber = new Map();
  for (const item of items) {
    if (!projectItemMatchesRepo(item, repo)) continue;
    const number = projectItemNumber(item);
    if (typeof number === "number") {
      byNumber.set(number, item);
    }
  }
  return byNumber;
}

export function auditMvpBoardReadiness(issues, projectPayload, options = {}) {
  const projectCheckSkipped = options.projectCheckSkipped ?? false;
  const minIssues = options.minIssues ?? 0;
  const projectItems = normalizeProjectItems(
    projectPayload,
    options.repo ?? DEFAULT_REPO,
  );
  const violations = [];
  const rows = [];

  const scopedIssues = projectCheckSkipped
    ? issues
    : issues.filter((issue) => {
        const item = projectItems.get(issue.number);
        return item && item.status !== "Done";
      });

  if (scopedIssues.length < minIssues) {
    violations.push({
      type: "too-few-issues",
      minimum: minIssues,
      actual: scopedIssues.length,
      message: `Loaded ${scopedIssues.length} active Project 15 issue(s), below required minimum ${minIssues}`,
    });
  }

  for (const issue of scopedIssues) {
    const labels = labelNames(issue);
    const blockerLabels = labels.filter((label) => BLOCKER_LABELS.has(label));
    const projectItem = projectItems.get(issue.number);
    const status = projectItem?.status ?? null;
    const row = {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      blockerLabels,
      projectStatus: status,
      projectCheckSkipped,
    };
    rows.push(row);

    if (projectCheckSkipped && blockerLabels.length === 0) {
      violations.push({
        type: "missing-blocker-label",
        number: issue.number,
        title: issue.title,
        message: `#${issue.number} is open+mvp but has neither needs-human nor needs-shaw`,
      });
    }

    if (projectCheckSkipped) {
      continue;
    }

    if (blockerLabels.length === 0) {
      violations.push({
        type: "agent-actionable",
        number: issue.number,
        title: issue.title,
        projectStatus: status,
        message: `#${issue.number} is active in Project 15 without a human blocker`,
      });
    }

    if (blockerLabels.length > 0 && status !== REQUIRED_BLOCKED_STATUS) {
      violations.push({
        type: "blocked-status-mismatch",
        number: issue.number,
        title: issue.title,
        projectStatus: status,
        message: `#${issue.number} has ${blockerLabels.join(
          ",",
        )} but Project 15 status is ${status ?? "unset"}`,
      });
    }
    if (status === REQUIRED_BLOCKED_STATUS && blockerLabels.length === 0) {
      violations.push({
        type: "human-status-missing-blocker",
        number: issue.number,
        title: issue.title,
        projectStatus: status,
        message: `#${issue.number} is in ${REQUIRED_BLOCKED_STATUS} but has neither needs-human nor needs-shaw`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    issueCount: scopedIssues.length,
    blockerCount: rows.filter((row) => row.blockerLabels.length > 0).length,
    agentActionableCount: rows.filter((row) => row.blockerLabels.length === 0)
      .length,
    projectCheckSkipped,
    minIssues,
    requiredBlockedStatus: REQUIRED_BLOCKED_STATUS,
    violations,
    rows,
  };
}

function formatText(report) {
  const lines = [
    `MVP board readiness: ${report.ok ? "PASS" : "FAIL"}`,
    `Active Project 15 issues: ${report.issueCount}`,
    `Blocked issues: ${report.blockerCount}`,
    `Agent-actionable issues: ${report.agentActionableCount}`,
    `Project status check: ${report.projectCheckSkipped ? "SKIPPED" : "checked"}`,
  ];
  if (report.minIssues > 0) {
    lines.push(`Minimum issue count: ${report.minIssues}`);
  }
  if (!report.projectCheckSkipped) {
    lines.push(`Required blocked status: ${report.requiredBlockedStatus}`);
  }
  if (report.violations.length > 0) {
    lines.push("", "Violations:");
    for (const violation of report.violations) {
      lines.push(`- ${violation.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (
    (args.issuesJson && !args.projectJson && !args.issuesOnly) ||
    (!args.issuesJson && args.projectJson)
  ) {
    throw new Error(
      "--issues-json and --project-json must be passed together unless --issues-only is used",
    );
  }

  const minIssues = parseNonNegativeInteger(args.minIssues, "--min-issues");
  const issues = args.issuesJson
    ? readJson(args.issuesJson)
    : fetchOpenProjectIssues(args.repo, args.projectOwner, args.projectNumber);
  const projectPayload = args.projectJson
    ? readJson(args.projectJson)
    : args.issuesOnly
      ? { items: [] }
      : fetchProjectItems(args.projectOwner, args.projectNumber);
  const report = auditMvpBoardReadiness(issues, projectPayload, {
    repo: args.repo,
    projectCheckSkipped: args.issuesOnly,
    minIssues,
  });

  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report),
  );
  if (args.fail && !report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`check-mvp-board-readiness: ${error.message}\n`);
    process.exitCode = 1;
  });
}
