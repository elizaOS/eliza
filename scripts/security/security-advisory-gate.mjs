#!/usr/bin/env node

/**
 * Gates security-sensitive pull requests on the canonical deterministic secret
 * scan and reports approval-held workflows before polling can time out.
 */

import {
  awaitingApprovalMessage,
  loadActionRequiredWorkflowPaths,
} from "../../packages/scripts/github-actions-approval.mjs";

const LABELS = new Set([
  "security",
  "security issue",
  "auth",
  "money-path",
  "payment integration",
]);
const REVIEWED_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|ya?ml)$|(^|\/)Dockerfile$|(^|\/)\.env\.example$/i;
const PATHS = [
  /(^|\/)[^/]*(auth|oauth|security|payments?|billing|wallets?|secrets?|credentials?|tokens?|connectors?|trusted-routing)[^/]*(\/|$)/i,
  /^\.github\/(workflows|actions)\//,
  /(^|\/)(contracts?|migrations)(\/|$)/i,
];
const REQUIRED_CHECKS = ["All Tests Passed"];
const REQUIRED_WORKFLOW_PATHS = [".github/workflows/pr-static-smoke.yml"];
const SUCCESS = new Set(["success"]);
const TERMINAL = new Set([
  "success",
  "failure",
  "cancelled",
  "neutral",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
]);
const ACTIVE = new Set([
  "queued",
  "in_progress",
  "pending",
  "requested",
  "waiting",
]);

export function classify({ labels = [], files = [] }) {
  const normalized = labels.map((label) => label.toLowerCase());
  const label = normalized.find((value) => LABELS.has(value));
  if (label) return { protected: true, reason: `security label: ${label}` };

  // A rename must be classified by both its source and destination. Otherwise
  // moving auth/payment code to an innocuous path bypasses the gate.
  const paths = files.flatMap((file) =>
    typeof file === "string"
      ? [file]
      : [file.filename, file.previous_filename].filter(Boolean),
  );
  const file = paths.find(
    (value) =>
      REVIEWED_FILE.test(value) && PATHS.some((pattern) => pattern.test(value)),
  );
  return file
    ? { protected: true, reason: `security path: ${file}` }
    : { protected: false, reason: "no security label or path" };
}

export function evaluate(checks) {
  // GitHub returns newest check runs first. Preserve the newest rerun for each
  // context instead of allowing an older success to mask a pending rerun.
  const byName = newestChecksByName(checks);
  const waiting = REQUIRED_CHECKS.filter((name) => {
    const check = byName.get(name);
    return !check || !TERMINAL.has(check.conclusion);
  });
  const failed = REQUIRED_CHECKS.filter((name) => {
    const check = byName.get(name);
    return (
      check && TERMINAL.has(check.conclusion) && !SUCCESS.has(check.conclusion)
    );
  });
  const active = REQUIRED_CHECKS.filter((name) => {
    const check = byName.get(name);
    return check && !TERMINAL.has(check.conclusion) && ACTIVE.has(check.status);
  });
  return {
    waiting,
    failed,
    active,
    passed: waiting.length === 0 && failed.length === 0,
  };
}

function newestChecksByName(checks) {
  const byName = new Map();
  for (const check of checks) {
    if (!byName.has(check.name)) byName.set(check.name, check);
  }
  return byName;
}

function timestampAtOrBefore(value, deadline) {
  const timestamp =
    typeof value === "number" ? value : Date.parse(value ?? "invalid");
  return Number.isFinite(timestamp) && timestamp <= deadline;
}

function requiredChecksStartedBy(checks, deadline) {
  const byName = newestChecksByName(checks);
  return REQUIRED_CHECKS.every((name) =>
    timestampAtOrBefore(byName.get(name)?.started_at, deadline),
  );
}

function requiredChecksCompletedBy(checks, deadline) {
  const byName = newestChecksByName(checks);
  return REQUIRED_CHECKS.every((name) => {
    const check = byName.get(name);
    return (
      check &&
      SUCCESS.has(check.conclusion) &&
      timestampAtOrBefore(check.completed_at, deadline)
    );
  });
}

export async function waitForRequiredChecks({
  loadChecks,
  loadActionRequiredPaths = async () => [],
  timeoutMs,
  completionGraceMs,
  intervalMs,
  now = Date.now,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onWait = () => {},
}) {
  const approvalDeadline = now() + timeoutMs;
  const completionDeadline = approvalDeadline + completionGraceMs;
  let completionGraceUsed = false;

  for (;;) {
    const actionRequiredPaths = await loadActionRequiredPaths();
    const heldRequiredPaths = REQUIRED_WORKFLOW_PATHS.filter((path) =>
      actionRequiredPaths.includes(path),
    );
    if (heldRequiredPaths.length > 0) {
      throw new Error(awaitingApprovalMessage(heldRequiredPaths));
    }

    const checks = await loadChecks();
    const state = evaluate(checks);
    if (state.failed.length) {
      throw new Error(
        `deterministic security checks failed: ${state.failed.join(", ")}`,
      );
    }

    const currentTime = now();
    if (currentTime < approvalDeadline) {
      if (state.passed) return;
    } else {
      if (!completionGraceUsed) {
        if (
          completionGraceMs <= 0 ||
          !requiredChecksStartedBy(checks, approvalDeadline)
        ) {
          throw new Error("timed out waiting for security advisory checks");
        }
        completionGraceUsed = true;
        onWait(
          `required checks started before the approval deadline; allowing bounded completion grace: ${REQUIRED_CHECKS.join(", ")}`,
        );
      }

      if (state.passed) {
        if (requiredChecksCompletedBy(checks, completionDeadline)) return;
        throw new Error("timed out waiting for security advisory checks");
      }
      if (currentTime >= completionDeadline) {
        throw new Error("timed out waiting for security advisory checks");
      }
    }

    onWait(
      `waiting for deterministic security checks: ${state.waiting.join(", ")}`,
    );
    const deadline = completionGraceUsed
      ? completionDeadline
      : approvalDeadline;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - now())));
  }
}

async function api(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function paged(path, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(
      `${path}${separator}per_page=100&page=${page}`,
      token,
    );
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

async function live() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const pr = Number(process.env.PR_NUMBER);
  const token = process.env.GITHUB_TOKEN;
  const timeout = Number(process.env.POLL_TIMEOUT_SECONDS || 1200);
  const interval = Number(process.env.POLL_INTERVAL_SECONDS || 30);
  const completionGrace = Number(
    process.env.POLL_COMPLETION_GRACE_SECONDS || 240,
  );
  const pull = await api(`/repos/${owner}/${repo}/pulls/${pr}`, token);
  const files = await paged(`/repos/${owner}/${repo}/pulls/${pr}/files`, token);
  const decision = classify({
    labels: pull.labels.map((x) => x.name),
    files,
  });
  console.log(decision.reason);
  if (!decision.protected) return;

  await waitForRequiredChecks({
    timeoutMs: timeout * 1000,
    completionGraceMs: completionGrace * 1000,
    intervalMs: interval * 1000,
    onWait: (message) => console.log(message),
    loadChecks: async () => {
      const checkRuns = [];
      for (let page = 1; ; page += 1) {
        const data = await api(
          `/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
          token,
        );
        checkRuns.push(...data.check_runs);
        if (data.check_runs.length < 100) break;
      }
      return checkRuns;
    },
    loadActionRequiredPaths: () =>
      loadActionRequiredWorkflowPaths({
        repository: `${owner}/${repo}`,
        headSha: pull.head.sha,
        requestJson: (url) => {
          const parsed = new URL(url);
          return api(`${parsed.pathname}${parsed.search}`, token);
        },
      }),
  });
  console.log("deterministic security checks completed successfully");
}

export async function canary(name) {
  const protectedInput = { labels: ["security"], files: [] };
  const cases = {
    bypass: () =>
      classify({ labels: [], files: ["packages/core/src/foo.ts"] })
        .protected === false,
    protected: () => classify(protectedInput).protected === true,
    waiting: () => evaluate([]).waiting.includes("All Tests Passed"),
    success: () =>
      evaluate(REQUIRED_CHECKS.map((x) => ({ name: x, conclusion: "success" })))
        .passed,
    failure: () =>
      evaluate([
        { name: "All Tests Passed", conclusion: "failure" },
      ]).failed.includes("All Tests Passed"),
  };
  if (!cases[name] || !cases[name]()) throw new Error(`canary failed: ${name}`);
  console.log(`canary passed: ${name}`);
}

if (import.meta.main) {
  const selected = process.env.CANARY_SCENARIO;
  await (selected ? canary(selected) : live());
}
