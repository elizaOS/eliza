#!/usr/bin/env node

/**
 * List completed, real GitHub Actions check failures while ignoring noisy
 * cancelled/superseded runs from re-pushes and ready-for-review transitions.
 *
 * Examples:
 *   node packages/scripts/ci-real-failures.mjs --repo elizaOS/eliza --pr 14051
 *   node packages/scripts/ci-real-failures.mjs --repo elizaOS/eliza --sha <sha> --json
 *   node packages/scripts/ci-real-failures.mjs --input check-runs.json
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function usage() {
  return [
    "Usage: ci-real-failures.mjs (--repo owner/repo (--pr N|--sha SHA) | --input file) [--json]",
    "",
    "Filters to completed check-runs with conclusion=failure and excludes",
    "cancelled/skipped/superseded noise.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = { json: false, input: null, repo: null, pr: null, sha: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--pr") args.pr = argv[++i];
    else if (arg === "--sha") args.sha = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (args.input) return args;
  if (!args.repo) throw new Error("--repo is required unless --input is used");
  if (!args.pr && !args.sha) {
    throw new Error("one of --pr or --sha is required unless --input is used");
  }
  if (args.pr && args.sha)
    throw new Error("--pr and --sha are mutually exclusive");
  return args;
}

export function normalizeConclusion(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function isSupersededCheckRun(run) {
  if (run?.superseded === true) return true;
  if (run?.isSuperseded === true) return true;
  const conclusion = normalizeConclusion(run?.conclusion);
  return conclusion === "cancelled" || conclusion === "canceled";
}

export function isRealCompletedFailure(run) {
  return (
    String(run?.status ?? "").toLowerCase() === "completed" &&
    normalizeConclusion(run?.conclusion) === "failure" &&
    !isSupersededCheckRun(run)
  );
}

export function selectRealFailures(runs) {
  return runs.filter(isRealCompletedFailure).map((run) => ({
    name: run.name ?? "(unnamed)",
    workflowName: run.workflow_name ?? run.workflowName ?? run.workflow ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.html_url ?? run.htmlUrl ?? run.details_url ?? null,
    startedAt: run.started_at ?? run.startedAt ?? null,
    completedAt: run.completed_at ?? run.completedAt ?? null,
  }));
}

function runGhJson(args) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh api exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function resolvePrHeadSha(repo, pr) {
  const data = runGhJson([`repos/${repo}/pulls/${pr}`]);
  const sha = data?.head?.sha;
  if (!sha) throw new Error(`could not resolve head sha for PR ${pr}`);
  return sha;
}

function fetchCheckRuns(repo, sha) {
  const out = [];
  for (let page = 1; ; page++) {
    const data = runGhJson([
      "--method",
      "GET",
      `repos/${repo}/commits/${sha}/check-runs`,
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
    ]);
    const pageRuns = data?.check_runs ?? [];
    out.push(...pageRuns);
    if (pageRuns.length < 100) return out;
  }
}

export function readRunsFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.check_runs)) return parsed.check_runs;
  throw new Error(`input ${path} must be an array or {check_runs: [...]}`);
}

export function formatFailureTable(failures) {
  if (!failures.length) return "No real completed check failures found.";
  return failures
    .map((failure) => {
      const workflow = failure.workflowName ? ` [${failure.workflowName}]` : "";
      const url = failure.htmlUrl ? `\n  ${failure.htmlUrl}` : "";
      return `- ${failure.name}${workflow}${url}`;
    })
    .join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const runs = args.input
    ? readRunsFromFile(args.input)
    : fetchCheckRuns(
        args.repo,
        args.sha ?? resolvePrHeadSha(args.repo, args.pr),
      );
  const failures = selectRealFailures(runs);
  if (args.json) {
    console.log(JSON.stringify({ failures }, null, 2));
  } else {
    console.log(formatFailureTable(failures));
  }
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(`[ci-real-failures] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
}
