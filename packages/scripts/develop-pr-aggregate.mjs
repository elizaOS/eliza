#!/usr/bin/env node
/**
 * Fail-closed state machine for the hosted develop pull-request aggregate.
 * The base-trusted workflow supplies the PR head SHA, while this module binds
 * each required check to its owning workflow and waits for one terminal result
 * per context. Missing and non-success terminal states never become green.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GITHUB_ACTIONS_APP_ID = 15368;
export const DEFAULT_PULL_REQUEST_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
];

const DEVELOP_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
];
const PR_METADATA_ACTIONS = [
  "opened",
  "edited",
  "synchronize",
  "reopened",
  "ready_for_review",
  "labeled",
  "unlabeled",
];
const STALE_BASE_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "labeled",
  "unlabeled",
];

export const REQUIRED_CHECKS = Object.freeze([
  {
    context: "Test Integrity (lane coverage)",
    workflowPath: ".github/workflows/develop-pr.yml",
    triggerActions: DEVELOP_PR_ACTIONS,
  },
  {
    context: "lint",
    workflowPath: ".github/workflows/develop-pr.yml",
    triggerActions: DEVELOP_PR_ACTIONS,
  },
  {
    context: "typecheck",
    workflowPath: ".github/workflows/develop-pr.yml",
    triggerActions: DEVELOP_PR_ACTIONS,
  },
  {
    context: "build",
    workflowPath: ".github/workflows/develop-pr.yml",
    triggerActions: DEVELOP_PR_ACTIONS,
  },
  {
    context: "gitleaks",
    workflowPath: ".github/workflows/gitleaks.yml",
    triggerActions: DEFAULT_PULL_REQUEST_ACTIONS,
  },
  {
    context: "coverage on changed files",
    workflowPath: ".github/workflows/coverage-gate.yml",
    triggerActions: DEFAULT_PULL_REQUEST_ACTIONS,
  },
  {
    context: "check-pr-evidence",
    workflowPath: ".github/workflows/pr.yaml",
    triggerActions: PR_METADATA_ACTIONS,
  },
  {
    context: "check-pr-title",
    workflowPath: ".github/workflows/pr.yaml",
    triggerActions: PR_METADATA_ACTIONS,
  },
  {
    context: "stale-base guard",
    workflowPath: ".github/workflows/stale-base-guard.yml",
    triggerActions: STALE_BASE_ACTIONS,
  },
]);

export const AGGREGATE_TRIGGER_ACTIONS = Object.freeze(
  Array.from(
    new Set(REQUIRED_CHECKS.flatMap(({ triggerActions }) => triggerActions)),
  ),
);

export const CANARY_SCENARIOS = Object.freeze([
  "success",
  "missing",
  "cancelled",
  "timed-out",
  "failed",
  "skipped",
  "pending-timeout",
]);

const SUCCESS_CONCLUSION = "success";
const COMPLETED_STATUS = "completed";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const FRESHNESS_SKEW_MS = 10_000;
const DEFAULT_TERMINAL_SETTLE_MS = 15_000;

function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestById(runs) {
  return runs.reduce(
    (latest, run) =>
      latest === null || Number(run.id) > Number(latest.id) ? run : latest,
    null,
  );
}

function detailForRun(run) {
  return run.details_url || `check-run ${run.id}`;
}

function waitingResult(required, code, detail, run = null) {
  return {
    ...required,
    state: "waiting",
    code,
    detail,
    url: run?.details_url ?? null,
  };
}

function failedResult(required, code, detail, run = null) {
  return {
    ...required,
    state: "failed",
    code,
    detail,
    url: run?.details_url ?? null,
  };
}

/**
 * Evaluates one API snapshot. Callers decide when the polling deadline has
 * elapsed; before then, missing/queued/stale observations remain waiting.
 */
export function evaluateAggregate({
  checkRuns,
  headSha,
  eventAction,
  eventUpdatedAt,
  nowMs,
  deadlineReached = false,
  terminalSettleMs = DEFAULT_TERMINAL_SETTLE_MS,
}) {
  const eventUpdatedMs = parseTimestamp(eventUpdatedAt);
  const freshAfterMs =
    eventUpdatedMs === null ? null : eventUpdatedMs - FRESHNESS_SKEW_MS;

  const results = REQUIRED_CHECKS.map((required) => {
    const candidates = checkRuns.filter(
      (run) =>
        run.name === required.context &&
        Number(run.app_id) === GITHUB_ACTIONS_APP_ID &&
        run.workflow_path === required.workflowPath &&
        run.workflow_event === "pull_request" &&
        run.workflow_head_sha === headSha,
    );
    const run = latestById(candidates);

    if (run === null) {
      const detail = `no GitHub Actions check run from ${required.workflowPath}`;
      return deadlineReached
        ? failedResult(required, "missing", detail)
        : waitingResult(required, "missing", detail);
    }

    const freshRunRequired = required.triggerActions.includes(eventAction);
    const startedMs = parseTimestamp(run.started_at);
    if (
      freshRunRequired &&
      (freshAfterMs === null || startedMs === null || startedMs < freshAfterMs)
    ) {
      const detail = `latest owner run predates ${eventAction} event`;
      return deadlineReached
        ? failedResult(required, "stale-event-result", detail, run)
        : waitingResult(required, "stale-event-result", detail, run);
    }

    if (run.status !== COMPLETED_STATUS) {
      const detail = `${detailForRun(run)} is ${run.status || "unknown"}`;
      return deadlineReached
        ? failedResult(required, "pending-timeout", detail, run)
        : waitingResult(required, "pending", detail, run);
    }

    if (run.conclusion === SUCCESS_CONCLUSION) {
      return {
        ...required,
        state: "passed",
        code: "success",
        detail: `${detailForRun(run)} concluded success`,
        url: run.details_url ?? null,
      };
    }

    const completedMs = parseTimestamp(run.completed_at);
    if (
      !deadlineReached &&
      completedMs !== null &&
      nowMs - completedMs < terminalSettleMs
    ) {
      return waitingResult(
        required,
        "terminal-settling",
        `${detailForRun(run)} concluded ${run.conclusion || "unknown"}; waiting briefly for a superseding rerun`,
        run,
      );
    }

    if (run.conclusion === "skipped") {
      return failedResult(
        required,
        "skipped-forbidden",
        `${detailForRun(run)} was skipped; required workflows must classify paths inside an always-emitted job`,
        run,
      );
    }

    return failedResult(
      required,
      `terminal-${run.conclusion || "unknown"}`,
      `${detailForRun(run)} concluded ${run.conclusion || "unknown"}`,
      run,
    );
  });

  const failed = results.filter(({ state }) => state === "failed");
  const waiting = results.filter(({ state }) => state === "waiting");
  return {
    verdict:
      failed.length > 0
        ? "failure"
        : waiting.length > 0
          ? "waiting"
          : "success",
    results,
    counts: {
      passed: results.length - failed.length - waiting.length,
      waiting: waiting.length,
      failed: failed.length,
    },
  };
}

function extractWorkflowRunId(detailsUrl) {
  if (typeof detailsUrl !== "string") return null;
  const match = detailsUrl.match(/\/actions\/runs\/(\d+)\/job\/\d+/);
  return match ? Number(match[1]) : null;
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "elizaOS-develop-pr-aggregate",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function requestJson(url, token) {
  const response = await fetch(url, { headers: apiHeaders(token) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${url}: ${body.slice(0, 500)}`,
    );
  }
  return response.json();
}

export async function loadOwnedCheckRuns({
  repository,
  headSha,
  token,
  workflowRunCache = new Map(),
}) {
  const requiredNames = new Set(REQUIRED_CHECKS.map(({ context }) => context));
  const rawRuns = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `https://api.github.com/repos/${repository}/commits/${headSha}/check-runs` +
      `?filter=all&per_page=${PAGE_SIZE}&page=${page}&app_id=${GITHUB_ACTIONS_APP_ID}`;
    const payload = await requestJson(url, token);
    const pageRuns = Array.isArray(payload.check_runs)
      ? payload.check_runs
      : [];
    rawRuns.push(...pageRuns.filter(({ name }) => requiredNames.has(name)));
    // total_count covers every Actions check on the commit, while rawRuns is
    // intentionally narrowed to required names. Page fullness is therefore
    // the reliable pagination boundary for this filtered in-memory set.
    if (pageRuns.length < PAGE_SIZE) {
      break;
    }
  }

  const runIds = new Set(
    rawRuns
      .map(({ details_url: detailsUrl }) => extractWorkflowRunId(detailsUrl))
      .filter((runId) => runId !== null),
  );
  for (const runId of runIds) {
    if (workflowRunCache.has(runId)) continue;
    const workflowRun = await requestJson(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
      token,
    );
    workflowRunCache.set(runId, {
      path: workflowRun.path,
      event: workflowRun.event,
      headSha: workflowRun.head_sha,
    });
  }

  return rawRuns.map((run) => {
    const workflowRunId = extractWorkflowRunId(run.details_url);
    const owner =
      workflowRunId === null ? null : workflowRunCache.get(workflowRunId);
    return {
      ...run,
      app_id: run.app?.id,
      workflow_path: owner?.path ?? null,
      workflow_event: owner?.event ?? null,
      workflow_head_sha: owner?.headSha ?? null,
    };
  });
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderSummary(evaluation, { headSha, eventAction, attempt }) {
  const lines = [
    "### Develop PR Gate",
    "",
    `- Head SHA: \`${headSha}\``,
    `- Pull-request action: \`${eventAction}\``,
    `- Poll attempt: ${attempt}`,
    `- Verdict: **${evaluation.verdict}**`,
    `- Passed / waiting / failed: ${evaluation.counts.passed} / ${evaluation.counts.waiting} / ${evaluation.counts.failed}`,
    "",
    "| Required context | Owning workflow | State | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of evaluation.results) {
    const detail = result.url
      ? `[${escapeCell(result.detail)}](${result.url})`
      : escapeCell(result.detail);
    lines.push(
      `| ${escapeCell(result.context)} | \`${escapeCell(result.workflowPath)}\` | ${result.state} | ${detail} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeSummary(summary) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub creates this per-job file outside Turbo's cache contract.
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) writeFileSync(path, summary);
}

function positiveInteger(value, name, fallback) {
  const resolved = value === undefined || value === "" ? fallback : value;
  if (!/^\d+$/.test(String(resolved)) || Number(resolved) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(resolved);
}

function validateProductionEnvironment(env) {
  if (env.AGGREGATE_EVENT_NAME !== "pull_request_target") {
    throw new Error("production aggregate requires pull_request_target");
  }
  if (!/^\d+$/.test(env.PR_NUMBER ?? "")) {
    throw new Error("PR_NUMBER must be a pull request number");
  }
  if (!/^[0-9a-f]{40}$/.test(env.HEAD_SHA ?? "")) {
    throw new Error("HEAD_SHA must be a full commit SHA");
  }
  if (!/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/repository");
  }
  if (!AGGREGATE_TRIGGER_ACTIONS.includes(env.PR_ACTION)) {
    throw new Error(`unsupported pull-request action: ${env.PR_ACTION}`);
  }
  if (parseTimestamp(env.PR_UPDATED_AT) === null) {
    throw new Error("PR_UPDATED_AT must be an ISO timestamp");
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildCanaryCheckRuns(scenario, nowMs) {
  if (!CANARY_SCENARIOS.includes(scenario)) {
    throw new Error(`unsupported canary scenario: ${scenario}`);
  }
  const startedAt = new Date(nowMs - 60_000).toISOString();
  const completedAt = new Date(nowMs - 30_000).toISOString();
  const runs = REQUIRED_CHECKS.map((required, index) => ({
    id: 10_000 + index,
    name: required.context,
    app_id: GITHUB_ACTIONS_APP_ID,
    workflow_path: required.workflowPath,
    workflow_event: "pull_request",
    workflow_head_sha: "a".repeat(40),
    status: COMPLETED_STATUS,
    conclusion: SUCCESS_CONCLUSION,
    started_at: startedAt,
    completed_at: completedAt,
    details_url: `https://github.example/actions/runs/1/job/${10_000 + index}`,
  }));
  const targetIndex = runs.findIndex(({ name }) => name === "gitleaks");
  if (scenario === "missing") runs.splice(targetIndex, 1);
  if (scenario === "cancelled") runs[targetIndex].conclusion = "cancelled";
  if (scenario === "timed-out") runs[targetIndex].conclusion = "timed_out";
  if (scenario === "failed") runs[targetIndex].conclusion = "failure";
  if (scenario === "skipped") runs[targetIndex].conclusion = "skipped";
  if (scenario === "pending-timeout") {
    runs[targetIndex].status = "in_progress";
    runs[targetIndex].conclusion = null;
    runs[targetIndex].completed_at = null;
  }
  return runs;
}

async function runCanary(scenario) {
  const nowMs = Date.now();
  const evaluation = evaluateAggregate({
    checkRuns: buildCanaryCheckRuns(scenario, nowMs),
    headSha: "a".repeat(40),
    eventAction: "synchronize",
    eventUpdatedAt: new Date(nowMs - 90_000).toISOString(),
    nowMs,
    deadlineReached: true,
    terminalSettleMs: 0,
  });
  const summary = renderSummary(evaluation, {
    headSha: "synthetic-canary",
    eventAction: scenario,
    attempt: 1,
  });
  writeSummary(summary);
  console.log(summary);
  return evaluation.verdict === "success" ? 0 : 1;
}

async function runProduction(env) {
  validateProductionEnvironment(env);
  const timeoutSeconds = positiveInteger(
    env.POLL_TIMEOUT_SECONDS,
    "POLL_TIMEOUT_SECONDS",
    2_400,
  );
  const intervalSeconds = positiveInteger(
    env.POLL_INTERVAL_SECONDS,
    "POLL_INTERVAL_SECONDS",
    30,
  );
  const deadlineMs = Date.now() + timeoutSeconds * 1_000;
  const workflowRunCache = new Map();
  let attempt = 1;

  while (true) {
    const nowMs = Date.now();
    const checkRuns = await loadOwnedCheckRuns({
      repository: env.GITHUB_REPOSITORY,
      headSha: env.HEAD_SHA,
      token: env.GITHUB_TOKEN,
      workflowRunCache,
    });
    const deadlineReached = nowMs >= deadlineMs;
    const evaluation = evaluateAggregate({
      checkRuns,
      headSha: env.HEAD_SHA,
      eventAction: env.PR_ACTION,
      eventUpdatedAt: env.PR_UPDATED_AT,
      nowMs,
      deadlineReached,
    });
    const summary = renderSummary(evaluation, {
      headSha: env.HEAD_SHA,
      eventAction: env.PR_ACTION,
      attempt,
    });
    writeSummary(summary);
    console.log(
      `Develop PR Gate poll ${attempt}: passed=${evaluation.counts.passed} waiting=${evaluation.counts.waiting} failed=${evaluation.counts.failed}`,
    );
    for (const result of evaluation.results) {
      console.log(
        `${result.state.toUpperCase()} ${result.context}: ${result.detail}`,
      );
    }

    if (evaluation.verdict === "success") return 0;
    if (evaluation.verdict === "failure") return 1;

    attempt += 1;
    await sleep(
      Math.min(intervalSeconds * 1_000, Math.max(1, deadlineMs - nowMs)),
    );
  }
}

export async function main(env = process.env) {
  const canary = env.CANARY_SCENARIO;
  if (canary) {
    if (env.AGGREGATE_EVENT_NAME !== "workflow_dispatch") {
      throw new Error("canary scenarios are restricted to workflow_dispatch");
    }
    return runCanary(canary);
  }
  return runProduction(env);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
