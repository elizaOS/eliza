#!/usr/bin/env node

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
const ADVISORIES = ["security", "claude-review"];
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
  const byName = new Map();
  for (const check of checks) {
    if (!byName.has(check.name)) byName.set(check.name, check);
  }
  const waiting = ADVISORIES.filter((name) => {
    const check = byName.get(name);
    return !check || !TERMINAL.has(check.conclusion);
  });
  const failed = ADVISORIES.filter((name) => {
    const check = byName.get(name);
    return (
      check && TERMINAL.has(check.conclusion) && !SUCCESS.has(check.conclusion)
    );
  });
  return {
    waiting,
    failed,
    passed: waiting.length === 0 && failed.length === 0,
  };
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
  const pull = await api(`/repos/${owner}/${repo}/pulls/${pr}`, token);
  const files = await paged(`/repos/${owner}/${repo}/pulls/${pr}/files`, token);
  const decision = classify({
    labels: pull.labels.map((x) => x.name),
    files,
  });
  console.log(decision.reason);
  if (!decision.protected) return;
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const checkRuns = [];
    for (let page = 1; ; page += 1) {
      const data = await api(
        `/repos/${owner}/${repo}/commits/${pull.head.sha}/check-runs?per_page=100&page=${page}`,
        token,
      );
      checkRuns.push(...data.check_runs);
      if (data.check_runs.length < 100) break;
    }
    const state = evaluate(checkRuns);
    if (state.failed.length)
      throw new Error(`advisory checks failed: ${state.failed.join(", ")}`);
    if (state.passed) {
      console.log("security advisories completed successfully");
      return;
    }
    console.log(`waiting for advisory checks: ${state.waiting.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
  throw new Error("timed out waiting for security advisory checks");
}

export async function canary(name) {
  const protectedInput = { labels: ["security"], files: [] };
  const cases = {
    bypass: () =>
      classify({ labels: [], files: ["packages/core/src/foo.ts"] })
        .protected === false,
    protected: () => classify(protectedInput).protected === true,
    waiting: () =>
      evaluate([{ name: "security", conclusion: "success" }]).waiting.includes(
        "claude-review",
      ),
    success: () =>
      evaluate(ADVISORIES.map((x) => ({ name: x, conclusion: "success" })))
        .passed,
    failure: () =>
      evaluate([
        { name: "security", conclusion: "failure" },
        { name: "claude-review", conclusion: "success" },
      ]).failed.includes("security"),
  };
  if (!cases[name] || !cases[name]()) throw new Error(`canary failed: ${name}`);
  console.log(`canary passed: ${name}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selected = process.env.CANARY_SCENARIO;
  await (selected ? canary(selected) : live());
}
