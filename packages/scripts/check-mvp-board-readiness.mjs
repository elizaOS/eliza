#!/usr/bin/env node

/**
 * Board-readiness audit for the LifeOps MVP project. Open MVP issues are only
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

Options:
  --json          Print machine-readable report.
  --issues-only   Skip Project status lookup and check only open MVP blocker labels.
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

function fetchOpenMvpIssues(repo) {
  return ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues?state=open&labels=mvp&per_page=100`,
  ])
    .flat()
    .filter((issue) => !issue.pull_request)
    .slice(0, 300)
    .map(normalizeRestIssue);
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

function normalizeProjectItems(payload, repo = DEFAULT_REPO) {
  const items = Array.isArray(payload) ? payload : (payload.items ?? []);
  const byNumber = new Map();
  const expectedRepo = normalizeRepository(repo);
  for (const item of items) {
    const itemRepo = projectItemRepository(item);
    if (expectedRepo && itemRepo && itemRepo !== expectedRepo) continue;
    const number = projectItemNumber(item);
    if (typeof number === "number") {
      byNumber.set(number, item);
    }
  }
  return byNumber;
}

export function auditMvpBoardReadiness(issues, projectPayload, options = {}) {
  const projectCheckSkipped = options.projectCheckSkipped ?? false;
  const projectItems = normalizeProjectItems(
    projectPayload,
    options.repo ?? DEFAULT_REPO,
  );
  const violations = [];
  const rows = [];

  for (const issue of issues) {
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

    if (blockerLabels.length === 0) {
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

    if (!projectItem) {
      violations.push({
        type: "missing-project-item",
        number: issue.number,
        title: issue.title,
        message: `#${issue.number} is open+mvp but is not present on Project 15`,
      });
      continue;
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
  }

  return {
    ok: violations.length === 0,
    issueCount: issues.length,
    blockerCount: rows.filter((row) => row.blockerLabels.length > 0).length,
    projectCheckSkipped,
    requiredBlockedStatus: REQUIRED_BLOCKED_STATUS,
    violations,
    rows,
  };
}

function formatText(report) {
  const lines = [
    `MVP board readiness: ${report.ok ? "PASS" : "FAIL"}`,
    `Open MVP issues: ${report.issueCount}`,
    `Blocked issues: ${report.blockerCount}`,
    `Project status check: ${report.projectCheckSkipped ? "SKIPPED" : "checked"}`,
  ];
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

  const issues = args.issuesJson
    ? readJson(args.issuesJson)
    : fetchOpenMvpIssues(args.repo);
  const projectPayload = args.projectJson
    ? readJson(args.projectJson)
    : args.issuesOnly
      ? { items: [] }
      : fetchProjectItems(args.projectOwner, args.projectNumber);
  const report = auditMvpBoardReadiness(issues, projectPayload, {
    repo: args.repo,
    projectCheckSkipped: args.issuesOnly,
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
