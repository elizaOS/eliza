#!/usr/bin/env node
/**
 * GitHub check-run triage for crowded PR queues.
 *
 * The merge queue often leaves cancelled or superseded check runs behind after
 * a branch is pushed or marked ready again. This helper reads the current check
 * runs for a PR head/ref, collapses older attempts with the same check name,
 * and reports only current completed failures as actionable.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return `Usage:
  node packages/scripts/gh-check-run-triage.mjs --pr <number> [--repo owner/repo]
  node packages/scripts/gh-check-run-triage.mjs --ref <sha-or-ref> [--repo owner/repo]
  node packages/scripts/gh-check-run-triage.mjs --input <check-runs.json>

Options:
  --json   Print machine-readable summary.
  --fail   Exit 1 when actionable failures are present.`;
}

function parseArgs(argv) {
  const out = { json: false, fail: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--fail") {
      out.fail = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (
      arg === "--repo" ||
      arg === "--pr" ||
      arg === "--ref" ||
      arg === "--input"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
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

function defaultRepo() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) {
    throw new Error(
      "Could not infer GitHub repo from origin; pass --repo owner/repo.",
    );
  }
  return match[1];
}

function ghJson(args) {
  const output = run("gh", ["api", ...args]);
  if (!output) return null;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return lines.map((line) => JSON.parse(line));
  }
  return JSON.parse(output);
}

function prHeadSha(repo, prNumber) {
  const pr = ghJson([`repos/${repo}/pulls/${prNumber}`]);
  return pr.head?.sha;
}

function checkRunsForRef(repo, ref) {
  const checkRuns = ghJson([
    "--paginate",
    "--method",
    "GET",
    `repos/${repo}/commits/${ref}/check-runs`,
    "-f",
    "per_page=100",
    "--jq",
    ".check_runs[]",
  ]);
  return normalizeCheckRuns(checkRuns ?? []);
}

function runTime(checkRun) {
  return Date.parse(
    checkRun.completed_at ??
      checkRun.started_at ??
      checkRun.created_at ??
      "1970-01-01T00:00:00Z",
  );
}

function checkIdentity(checkRun) {
  return checkRun.name ?? checkRun.external_id ?? String(checkRun.id);
}

export function normalizeCheckRuns(payload) {
  if (Array.isArray(payload)) {
    if (
      payload.every(
        (entry) => entry && typeof entry === "object" && "name" in entry,
      )
    ) {
      return payload;
    }
    return payload.flatMap((entry) => normalizeCheckRuns(entry));
  }
  if (Array.isArray(payload?.check_runs)) return payload.check_runs;
  if (Array.isArray(payload?.runs)) return payload.runs;
  if (Array.isArray(payload)) return payload;
  throw new Error(
    "Input JSON must be a check-runs response or array of pages.",
  );
}

export function classifyCheckRuns(checkRuns) {
  const groups = new Map();
  for (const checkRun of checkRuns) {
    const key = checkIdentity(checkRun);
    const list = groups.get(key) ?? [];
    list.push(checkRun);
    groups.set(key, list);
  }

  const latest = [];
  const superseded = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => {
      const byTime = runTime(b) - runTime(a);
      if (byTime !== 0) return byTime;
      return Number(b.id ?? 0) - Number(a.id ?? 0);
    });
    latest.push(sorted[0]);
    superseded.push(...sorted.slice(1));
  }

  const current = latest.sort((a, b) =>
    String(checkIdentity(a)).localeCompare(String(checkIdentity(b))),
  );
  const actionableFailures = current.filter(
    (run) => run.status === "completed" && run.conclusion === "failure",
  );

  return {
    actionableFailures,
    current,
    superseded,
    ignored: current.filter((run) => !actionableFailures.includes(run)),
  };
}

function summarize(checkRuns) {
  const classified = classifyCheckRuns(checkRuns);
  return {
    total: checkRuns.length,
    current: classified.current.length,
    superseded: classified.superseded.length,
    actionableFailures: classified.actionableFailures,
    ignored: classified.ignored,
  };
}

function formatRun(run) {
  const name = checkIdentity(run);
  const url = run.html_url ?? run.details_url ?? "";
  return `- ${name}: ${run.conclusion ?? run.status}${url ? ` ${url}` : ""}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let checkRuns;
  let target = args.ref;
  if (args.input) {
    const input = await import("node:fs/promises").then((fs) =>
      fs.readFile(args.input, "utf8"),
    );
    checkRuns = normalizeCheckRuns(JSON.parse(input));
    target = args.input;
  } else {
    const repo = args.repo ?? defaultRepo();
    if (args.pr) target = prHeadSha(repo, args.pr);
    if (!target) throw new Error("Pass --pr, --ref, or --input.");
    checkRuns = checkRunsForRef(repo, target);
  }

  const summary = summarize(checkRuns);
  if (args.json) {
    console.log(JSON.stringify({ target, ...summary }, null, 2));
  } else {
    console.log(
      `check-run triage: ${summary.actionableFailures.length} actionable failure(s), ${summary.superseded} superseded run(s), ${summary.current} current check(s)`,
    );
    if (summary.actionableFailures.length > 0) {
      console.log("\nActionable failures:");
      console.log(summary.actionableFailures.map(formatRun).join("\n"));
    }
  }

  if (args.fail && summary.actionableFailures.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
