#!/usr/bin/env node
/**
 * Read-only audit for the LifeOps MVP project board. The GitHub Project is the
 * live kanban, but closeout work needs a compact stale-state report instead of
 * a raw 195-item dump: closed issues that are not Done, open MVP issues still
 * active, and the subset that is explicitly human-gated.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_OWNER = "elizaOS";
const DEFAULT_REPO = "elizaOS/eliza";
const DEFAULT_PROJECT = "15";
const DEFAULT_LIMIT = "500";
const DONE_STATUS = "Done";

function usage() {
  return `Usage:
  node packages/scripts/audit-mvp-project-board.mjs [--json] [--strict]
  node packages/scripts/audit-mvp-project-board.mjs --project-json project.json --open-json open.json --closed-json closed.json [--json] [--strict]

Options:
  --owner <org>        GitHub Project owner for live mode (default: ${DEFAULT_OWNER}).
  --project <number>  GitHub Project number for live mode (default: ${DEFAULT_PROJECT}).
  --repo <owner/repo> GitHub repo for live mode (default: ${DEFAULT_REPO}).
  --limit <n>         GitHub item/page limit (default: ${DEFAULT_LIMIT}).
  --strict            Exit 1 when any stale/actionable bucket is non-empty.`;
}

function parseArgs(argv) {
  const out = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    project: DEFAULT_PROJECT,
    limit: DEFAULT_LIMIT,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--strict") {
      out.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (
      arg === "--owner" ||
      arg === "--project" ||
      arg === "--repo" ||
      arg === "--limit" ||
      arg === "--project-json" ||
      arg === "--open-json" ||
      arg === "--closed-json"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      out[
        arg
          .slice(2)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
      ] = value;
      i += 1;
    } else if (arg.includes("=")) {
      const [name, value] = arg.split(/=(.*)/s);
      if (
        ![
          "--owner",
          "--project",
          "--repo",
          "--limit",
          "--project-json",
          "--open-json",
          "--closed-json",
        ].includes(name)
      ) {
        throw new Error(`Unknown argument: ${arg}`);
      }
      out[
        name
          .slice(2)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
      ] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function normalizeProjectIssue(item) {
  if (item?.content?.type !== "Issue") return null;
  const labels = (item.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  return {
    number: item.content.number,
    title: item.title ?? item.content.title,
    url: item.content.url,
    status: item.status ?? null,
    labels: labels.filter(Boolean),
  };
}

function byNumber(items) {
  return new Map(items.map((item) => [item.number, item]));
}

export function summarizeMvpBoard({ projectItems, openIssues, closedIssues }) {
  const openByNumber = byNumber(openIssues);
  const closedNumbers = new Set(closedIssues.map((issue) => issue.number));
  const issues = projectItems.map(normalizeProjectIssue).filter(Boolean);
  const mvpIssues = issues.filter((issue) => issue.labels.includes("mvp"));

  const closedNotDone = mvpIssues.filter(
    (issue) => closedNumbers.has(issue.number) && issue.status !== DONE_STATUS,
  );
  const openOnBoard = mvpIssues.filter(
    (issue) => openByNumber.has(issue.number) && issue.status !== DONE_STATUS,
  );
  const humanGated = openOnBoard.filter((issue) =>
    issue.labels.some(
      (label) => label === "needs-human" || label === "needs-shaw",
    ),
  );
  const agentActionable = openOnBoard.filter(
    (issue) =>
      !issue.labels.some(
        (label) => label === "needs-human" || label === "needs-shaw",
      ),
  );
  const openDone = mvpIssues.filter(
    (issue) => openByNumber.has(issue.number) && issue.status === DONE_STATUS,
  );

  return {
    counts: {
      projectIssues: issues.length,
      mvpIssues: mvpIssues.length,
      closedNotDone: closedNotDone.length,
      openNotDone: openOnBoard.length,
      humanGated: humanGated.length,
      agentActionable: agentActionable.length,
      openDone: openDone.length,
    },
    closedNotDone,
    openNotDone: openOnBoard,
    humanGated,
    agentActionable,
    openDone,
  };
}

export function strictViolations(summary) {
  const violations = [];
  if (summary.closedNotDone.length > 0) {
    violations.push({
      type: "closed-not-done",
      count: summary.closedNotDone.length,
      message: `${summary.closedNotDone.length} closed MVP issue(s) are not marked Done`,
    });
  }
  if (summary.agentActionable.length > 0) {
    violations.push({
      type: "agent-actionable-open",
      count: summary.agentActionable.length,
      message: `${summary.agentActionable.length} open MVP issue(s) are neither Done nor human-gated`,
    });
  }
  if (summary.openDone.length > 0) {
    violations.push({
      type: "open-done",
      count: summary.openDone.length,
      message: `${summary.openDone.length} open MVP issue(s) are already marked Done`,
    });
  }
  return violations;
}

function formatIssue(issue) {
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(",")}]` : "";
  return `#${issue.number} ${issue.status ?? "(no status)"} — ${issue.title}${labels}`;
}

export function formatSummary(summary) {
  const lines = [
    "LifeOps MVP project-board audit",
    `project issues: ${summary.counts.projectIssues}; mvp issues: ${summary.counts.mvpIssues}`,
    `closed-not-Done: ${summary.counts.closedNotDone}`,
    `open-not-Done: ${summary.counts.openNotDone} (${summary.counts.humanGated} human-gated, ${summary.counts.agentActionable} agent-actionable)`,
    `open-but-Done: ${summary.counts.openDone}`,
  ];

  const section = (title, rows) => {
    lines.push("", title);
    if (rows.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const row of rows) lines.push(`  ${formatIssue(row)}`);
  };

  section("Closed MVP issues not marked Done", summary.closedNotDone);
  section(
    "Open MVP issues not Done and not human-gated",
    summary.agentActionable,
  );
  section("Open MVP issues not Done and human-gated", summary.humanGated);
  section("Open MVP issues already marked Done", summary.openDone);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const fixtureInputs = [
    args.projectJson,
    args.openJson,
    args.closedJson,
  ].filter(Boolean);
  if (fixtureInputs.length > 0 && fixtureInputs.length !== 3) {
    throw new Error(
      "--project-json, --open-json, and --closed-json must be passed together",
    );
  }

  const projectData = args.projectJson
    ? readJson(args.projectJson)
    : ghJson([
        "project",
        "item-list",
        args.project,
        "--owner",
        args.owner,
        "--format",
        "json",
        "--limit",
        args.limit,
      ]);
  const openIssues = args.openJson
    ? readJson(args.openJson)
    : ghJson([
        "issue",
        "list",
        "--repo",
        args.repo,
        "--state",
        "open",
        "--label",
        "mvp",
        "--limit",
        args.limit,
        "--json",
        "number,title,labels,url",
      ]);
  const closedIssues = args.closedJson
    ? readJson(args.closedJson)
    : ghJson([
        "issue",
        "list",
        "--repo",
        args.repo,
        "--state",
        "closed",
        "--label",
        "mvp",
        "--limit",
        args.limit,
        "--json",
        "number,title,labels,url",
      ]);

  const summary = summarizeMvpBoard({
    projectItems: projectData.items ?? [],
    openIssues,
    closedIssues,
  });
  const violations = strictViolations(summary);
  const output = args.json
    ? { ...summary, strictViolations: violations }
    : null;
  process.stdout.write(
    args.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `${formatSummary(summary)}\n`,
  );
  if (args.strict && violations.length > 0) {
    process.stderr.write(
      `[audit-mvp-project-board] strict failed: ${violations
        .map((violation) => violation.message)
        .join("; ")}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `[audit-mvp-project-board] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
