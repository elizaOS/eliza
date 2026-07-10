#!/usr/bin/env node
/**
 * Produces one atomic LifeOps MVP closeout report from a single Project 15
 * snapshot. Board state, readiness policy, and evidence expectations consume
 * identical inputs so rate limits or mid-run board changes cannot create a
 * false parity result.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { buildEvidenceMatrix } from "./audit-mvp-evidence-matrix.mjs";
import {
  strictViolations,
  summarizeMvpBoard,
} from "./audit-mvp-project-board.mjs";
import {
  auditMvpBoardReadiness,
  normalizeProjectItems,
  projectItemMatchesRepo,
} from "./check-mvp-board-readiness.mjs";

const DEFAULT_OWNER = "elizaOS";
const DEFAULT_PROJECT = "15";
const DEFAULT_REPO = "elizaOS/eliza";
const DEFAULT_LIMIT = "500";

function usage() {
  return `Usage:
  node packages/scripts/run-mvp-closeout-audit.mjs [--json] [--output report.json]
  node packages/scripts/run-mvp-closeout-audit.mjs --snapshot-json snapshot.json [--json]

Options:
  --owner <org>             Project owner (default: ${DEFAULT_OWNER}).
  --project <number>        Project number (default: ${DEFAULT_PROJECT}).
  --repo <owner/repo>       Repository (default: ${DEFAULT_REPO}).
  --limit <number>          Maximum project/issues returned (default: ${DEFAULT_LIMIT}).
  --snapshot-json <file>    Use one offline snapshot instead of GitHub.
  --output <file>           Write the report to a file.
  --json                    Emit the complete machine-readable report.`;
}

function parseArgs(argv) {
  const args = {
    owner: DEFAULT_OWNER,
    project: DEFAULT_PROJECT,
    repo: DEFAULT_REPO,
    limit: DEFAULT_LIMIT,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (
      arg === "--owner" ||
      arg === "--project" ||
      arg === "--repo" ||
      arg === "--limit" ||
      arg === "--snapshot-json" ||
      arg === "--output"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      args[
        arg
          .slice(2)
          .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
      ] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function ghJson(args) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function fetchSnapshot(args) {
  const project = ghJson([
    "project",
    "item-list",
    args.project,
    "--owner",
    args.owner,
    "--limit",
    args.limit,
    "--format",
    "json",
  ]);
  const issueFields = "number,title,body,url,labels";
  const search = `project:${args.owner}/${args.project}`;
  const openIssues = ghJson([
    "issue",
    "list",
    "--repo",
    args.repo,
    "--state",
    "open",
    "--search",
    search,
    "--limit",
    args.limit,
    "--json",
    issueFields,
  ]);
  const closedIssues = ghJson([
    "issue",
    "list",
    "--repo",
    args.repo,
    "--state",
    "closed",
    "--search",
    search,
    "--limit",
    args.limit,
    "--json",
    issueFields,
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    source: "github",
    owner: args.owner,
    projectNumber: args.project,
    repo: args.repo,
    project,
    openIssues,
    closedIssues,
  };
}

function assertIssueRows(rows, name) {
  if (!Array.isArray(rows)) throw new Error(`${name} must be an array`);
  const numbers = new Set();
  for (const issue of rows) {
    if (!Number.isInteger(issue?.number)) {
      throw new Error(`${name} contains an issue without an integer number`);
    }
    if (numbers.has(issue.number)) {
      throw new Error(`${name} contains duplicate issue #${issue.number}`);
    }
    numbers.add(issue.number);
  }
  return numbers;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("snapshot must be an object");
  }
  // Provenance is load-bearing in the report: a reviewer must be able to tell
  // a live GitHub pull from an offline fixture, so a snapshot may never
  // default its way into either label (#15852).
  if (typeof snapshot.source !== "string" || snapshot.source.length === 0) {
    throw new Error(
      'snapshot.source must be a non-empty string naming the snapshot provenance (e.g. "github" or "fixture")',
    );
  }
  if (
    !Array.isArray(snapshot.project?.items) ||
    snapshot.project.items.length === 0
  ) {
    throw new Error("snapshot project.items must be a non-empty array");
  }
  const openNumbers = assertIssueRows(
    snapshot.openIssues,
    "snapshot.openIssues",
  );
  const closedNumbers = assertIssueRows(
    snapshot.closedIssues,
    "snapshot.closedIssues",
  );
  for (const number of openNumbers) {
    if (closedNumbers.has(number)) {
      throw new Error(
        `issue #${number} appears in both open and closed snapshot rows`,
      );
    }
  }

  // Scope cards to the audited repository the same way normalizeProjectItems
  // does for readiness, so a foreign-repo card that happens to share an issue
  // number can neither mask a divergence nor hard-fail the open/closed check
  // ("Project issue #N is missing from open/closed snapshot rows").
  const projectNumbers = new Set(
    normalizeProjectItems(
      snapshot.project,
      snapshot.repo ?? DEFAULT_REPO,
    ).keys(),
  );
  if (projectNumbers.size === 0) {
    throw new Error("snapshot contains no Project issue cards");
  }
  for (const number of [...openNumbers, ...closedNumbers]) {
    if (!projectNumbers.has(number)) {
      throw new Error(
        `issue #${number} is not present in snapshot project.items`,
      );
    }
  }
  for (const number of projectNumbers) {
    if (!openNumbers.has(number) && !closedNumbers.has(number)) {
      throw new Error(
        `Project issue #${number} is missing from open/closed snapshot rows`,
      );
    }
  }
  return snapshot;
}

function sortedNumbers(rows) {
  return rows.map((row) => row.number).sort((left, right) => left - right);
}

export function compareIssueNumberSets(readinessRows, evidenceRows) {
  const readiness = sortedNumbers(readinessRows);
  const evidence = sortedNumbers(evidenceRows);
  const readinessSet = new Set(readiness);
  const evidenceSet = new Set(evidence);
  const missingFromEvidence = readiness.filter(
    (number) => !evidenceSet.has(number),
  );
  const missingFromReadiness = evidence.filter(
    (number) => !readinessSet.has(number),
  );
  return {
    ok: missingFromEvidence.length === 0 && missingFromReadiness.length === 0,
    readiness,
    evidence,
    missingFromEvidence,
    missingFromReadiness,
  };
}

export function buildCloseoutReport(snapshot) {
  validateSnapshot(snapshot);
  const repo = snapshot.repo ?? DEFAULT_REPO;
  // All three analyzers must see the same repo-scoped card set; readiness and
  // evidence filter internally, so the board summary gets the filtered items
  // here lest a same-numbered cross-repo card donate its status to an eliza
  // issue.
  const projectItems = snapshot.project.items.filter((item) =>
    projectItemMatchesRepo(item, repo),
  );
  const board = summarizeMvpBoard({
    projectItems,
    openIssues: snapshot.openIssues,
    closedIssues: snapshot.closedIssues,
  });
  const boardViolations = strictViolations(board);
  const readiness = auditMvpBoardReadiness(
    snapshot.openIssues,
    snapshot.project,
    {
      repo,
    },
  );
  const evidence = buildEvidenceMatrix(snapshot.openIssues, snapshot.project, {
    repo,
    projectStatusSource: "atomic-snapshot",
  });
  const parity = compareIssueNumberSets(readiness.rows, evidence.rows);
  return {
    generatedAt: new Date().toISOString(),
    snapshot: {
      fetchedAt: snapshot.fetchedAt ?? null,
      // validateSnapshot already rejected snapshots without a source; a
      // fixture is labeled "fixture" only because the fixture says so.
      source: snapshot.source,
      owner: snapshot.owner ?? null,
      projectNumber: snapshot.projectNumber ?? null,
      repo,
      projectItemCount: snapshot.project.items.length,
      openIssueCount: snapshot.openIssues.length,
      closedIssueCount: snapshot.closedIssues.length,
    },
    integrityOk: parity.ok,
    ready: parity.ok && boardViolations.length === 0 && readiness.ok,
    parity,
    board: { ...board, strictViolations: boardViolations },
    readiness,
    evidence,
  };
}

function formatText(report) {
  return [
    `MVP atomic closeout: ${report.ready ? "READY" : "NOT READY"}`,
    `Snapshot integrity: ${report.integrityOk ? "PASS" : "FAIL"}`,
    `Project issues: ${report.board.counts.projectIssues}`,
    `Open not Done: ${report.board.counts.openNotDone}`,
    `Human-gated: ${report.board.counts.humanGated}`,
    `Agent-actionable: ${report.board.counts.agentActionable}`,
    `Closed not Done: ${report.board.counts.closedNotDone}`,
    `Evidence contracts: ${report.evidence.counts.activeProjectIssues}`,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const snapshot = args.snapshotJson
    ? JSON.parse(readFileSync(args.snapshotJson, "utf8"))
    : fetchSnapshot(args);
  const report = buildCloseoutReport(snapshot);
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatText(report)}\n`;
  if (args.output) writeFileSync(args.output, output);
  else process.stdout.write(output);
  if (!report.integrityOk) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // error-policy:J1 Translate the outer CLI boundary to stderr and a failing exit code.
    process.stderr.write(
      `[mvp-closeout-audit] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
