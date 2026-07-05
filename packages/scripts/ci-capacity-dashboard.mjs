#!/usr/bin/env node
/**
 * Read-only CI capacity dashboard for the self-hosted fleet.
 *
 * develop merges stall on runner *queue starvation*, not on failures (#14051):
 * PR fan-out oversubscribes ~40 self-hosted runners, so the required `ci-ok`
 * roll-up sits QUEUED for hours even though nothing is red. Tuning fan-out down
 * needs one live number to steer by. This helper reads three GitHub Actions
 * endpoints (`actions/runners`, queued `actions/runs`, in-progress
 * `actions/runs`) and reports online/idle runner counts, queue depth, and the
 * oversubscription ratio (active runs ÷ online runners) — the lever the issue's
 * capacity math is written against.
 *
 * The classifier is pure over captured API shapes so the test harness stays
 * offline; live GitHub access is confined to the `gh api` CLI path. Queue depth
 * comes from each response's `total_count` (currently ~9k queued), never from
 * paginating the full run list — the headline number must not cost 90 API
 * pages to read.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  return `Usage:
  node packages/scripts/ci-capacity-dashboard.mjs [--repo owner/repo]
  node packages/scripts/ci-capacity-dashboard.mjs --input <bundle.json>

Reads the self-hosted fleet's live load and prints online/idle runners, queue
depth, in-flight runs, and the oversubscription ratio (active runs / online
runners) — the number #14051's fan-out tuning steers against.

The --input bundle is the offline form: an object shaped
  { "runners": <GET actions/runners>,
    "queued": <GET actions/runs?status=queued>,
    "inProgress": <GET actions/runs?status=in_progress> }

Options:
  --json   Print the machine-readable capacity report.
  --repo   owner/repo (defaults to the git origin remote).`;
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--repo" || arg === "--input") {
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

function ghJson(endpoint) {
  return JSON.parse(run("gh", ["api", endpoint]));
}

/**
 * Coerce a runners response (`{ runners: [...] }`) or a bare array into the
 * runner array. A runner reports `status` ("online"/"offline") and `busy`.
 */
export function normalizeRunners(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.runners)) return payload.runners;
  throw new Error("Runners input must be a runners response or array.");
}

/**
 * Coerce a workflow-runs response into `{ total, runs }`. `total` is the fleet
 * queue depth from the API's `total_count`; `runs` is the (possibly paged)
 * sample used only for the per-workflow breakdown.
 */
export function normalizeRuns(payload) {
  if (Array.isArray(payload)) {
    return { total: payload.length, runs: payload };
  }
  const runs = Array.isArray(payload?.workflow_runs)
    ? payload.workflow_runs
    : [];
  const total =
    typeof payload?.total_count === "number"
      ? payload.total_count
      : runs.length;
  return { total, runs };
}

export function summarizeRunners(payload) {
  const runners = normalizeRunners(payload);
  let online = 0;
  let offline = 0;
  let busy = 0;
  let idle = 0;
  for (const runner of runners) {
    const isOnline = runner.status === "online";
    if (isOnline) online += 1;
    else offline += 1;
    if (runner.busy) busy += 1;
    if (isOnline && !runner.busy) idle += 1;
  }
  return { total: runners.length, online, offline, busy, idle };
}

export function summarizeRuns(payload) {
  const { total, runs } = normalizeRuns(payload);
  const byWorkflow = {};
  let pullRequestRuns = 0;
  for (const workflowRun of runs) {
    const name = workflowRun.name ?? "(unnamed)";
    byWorkflow[name] = (byWorkflow[name] ?? 0) + 1;
    const isPr =
      workflowRun.event === "pull_request" ||
      (workflowRun.pull_requests?.length ?? 0) > 0;
    if (isPr) pullRequestRuns += 1;
  }
  return { total, sampled: runs.length, byWorkflow, pullRequestRuns };
}

function topWorkflows(byWorkflow, limit) {
  return Object.entries(byWorkflow)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * The verdict is the coarse tuning signal: a fleet with idle runners and no
 * queue has headroom; once the queue outnumbers online runners the fan-out is
 * starving merges (the #14051 condition). Thresholds are ratios of active runs
 * (queued + in-progress) to online runners so the call is fleet-size-agnostic.
 */
export function classifyLoad({ online, idle, queuedRuns, oversubscription }) {
  if (online === 0) return "fleet-offline";
  if (queuedRuns === 0 && idle > 0) return "idle";
  if (oversubscription !== null && oversubscription <= 1) return "healthy";
  if (oversubscription !== null && oversubscription <= 2) return "saturated";
  return "oversubscribed";
}

export function computeCapacity({ runners, queued, inProgress }) {
  const fleet = summarizeRunners(runners);
  const queuedSummary = summarizeRuns(queued);
  const inProgressSummary = summarizeRuns(inProgress);
  const queuedRuns = queuedSummary.total;
  const inProgressRuns = inProgressSummary.total;
  const activeRuns = queuedRuns + inProgressRuns;
  const oversubscription =
    fleet.online > 0 ? Number((activeRuns / fleet.online).toFixed(2)) : null;
  const verdict = classifyLoad({
    online: fleet.online,
    idle: fleet.idle,
    queuedRuns,
    oversubscription,
  });
  return {
    fleet,
    queuedRuns,
    inProgressRuns,
    activeRuns,
    onlineRunners: fleet.online,
    idleRunners: fleet.idle,
    oversubscription,
    verdict,
    topQueuedWorkflows: topWorkflows(queuedSummary.byWorkflow, 5),
    queuedPullRequestRuns: queuedSummary.pullRequestRuns,
  };
}

function fetchBundle(repo) {
  return {
    runners: ghJson(`repos/${repo}/actions/runners?per_page=100`),
    queued: ghJson(`repos/${repo}/actions/runs?status=queued&per_page=100`),
    inProgress: ghJson(
      `repos/${repo}/actions/runs?status=in_progress&per_page=100`,
    ),
  };
}

function formatReport(report, repo) {
  const lines = [
    `CI capacity — ${repo}`,
    `  runners:   ${report.fleet.online} online (${report.idleRunners} idle, ${report.fleet.busy} busy) / ${report.fleet.total} total, ${report.fleet.offline} offline`,
    `  queue:     ${report.queuedRuns} queued run(s) (${report.queuedPullRequestRuns}+ from PRs), ${report.inProgressRuns} in-progress`,
    `  oversub:   ${report.oversubscription ?? "n/a"}x (active runs / online runners)`,
    `  verdict:   ${report.verdict}`,
  ];
  if (report.topQueuedWorkflows.length > 0) {
    lines.push("  top queued workflows (sampled):");
    for (const entry of report.topQueuedWorkflows) {
      lines.push(`    - ${entry.name}: ${entry.count}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let bundle;
  let repo = args.repo;
  if (args.input) {
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(args.input, "utf8"),
    );
    bundle = JSON.parse(raw);
    repo = repo ?? args.input;
  } else {
    repo = repo ?? defaultRepo();
    bundle = fetchBundle(repo);
  }

  const report = computeCapacity(bundle);
  if (args.json) {
    console.log(JSON.stringify({ repo, ...report }, null, 2));
  } else {
    console.log(formatReport(report, repo));
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // error-policy:J1 CLI boundary translates failures to stderr + exit status.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
