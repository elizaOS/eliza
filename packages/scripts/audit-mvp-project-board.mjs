#!/usr/bin/env node
/**
 * Read-only audit for the LifeOps MVP project board. The GitHub Project is the
 * live kanban, but closeout work needs a compact stale-state report instead of
 * a raw 195-item dump: closed issues that are not Done, open MVP issues still
 * active, and the subset that is explicitly human-gated.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

const DEFAULT_OWNER = "elizaOS";
const DEFAULT_REPO = "elizaOS/eliza";
const DEFAULT_PROJECT = "15";
const DEFAULT_LIMIT = "500";
const DONE_STATUS = "Done";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1) return process.argv[index + 1] ?? fallback;
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
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
  const owner = argValue("--owner", DEFAULT_OWNER);
  const project = argValue("--project", DEFAULT_PROJECT);
  const repo = argValue("--repo", DEFAULT_REPO);
  const limit = argValue("--limit", DEFAULT_LIMIT);
  const jsonMode = process.argv.includes("--json");

  const projectData = ghJson([
    "project",
    "item-list",
    project,
    "--owner",
    owner,
    "--format",
    "json",
    "--limit",
    limit,
  ]);
  const openIssues = ghJson([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    "mvp",
    "--limit",
    limit,
    "--json",
    "number,title,labels,url",
  ]);
  const closedIssues = ghJson([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--label",
    "mvp",
    "--limit",
    limit,
    "--json",
    "number,title,labels,url",
  ]);

  const summary = summarizeMvpBoard({
    projectItems: projectData.items ?? [],
    openIssues,
    closedIssues,
  });
  process.stdout.write(
    jsonMode
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `${formatSummary(summary)}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `[audit-mvp-project-board] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
