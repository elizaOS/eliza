#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath } from "./artifact-paths.mjs";

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_OUTPUT = artifactPath("eliza-hub-runner-smoke-evidence.json");
const DEFAULT_WORKFLOW = "runner-smoke.yml";
const DEFAULT_REPO = "elizaos/eliza";
const DEFAULT_REF = "main";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INTERVAL_MS = 5_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
  const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
  const values = readConfiguration(envFile, process.env);
  const baseUrl = requiredValue(
    options.forgejoUrl ??
      values.RUNNER_SMOKE_FORGEJO_URL ??
      values.FORGEJO_ROOT_URL,
    "FORGEJO_ROOT_URL",
  );
  const token = requiredValue(
    values.RUNNER_SMOKE_FORGEJO_TOKEN ??
      values.FORGEJO_STEWARD_TOKEN ??
      values.FORGEJO_TOKEN,
    "RUNNER_SMOKE_FORGEJO_TOKEN or FORGEJO_STEWARD_TOKEN",
  );
  const repoName =
    options.repo ??
    values.RUNNER_SMOKE_REPO ??
    values.MERGE_STEWARD_SMOKE_REPO ??
    DEFAULT_REPO;
  const repo = parseRepo(repoName);
  const workflow =
    options.workflow ?? values.RUNNER_SMOKE_WORKFLOW ?? DEFAULT_WORKFLOW;
  const ref = options.ref ?? values.RUNNER_SMOKE_REF ?? DEFAULT_REF;
  const outputPath =
    options.output ?? values.RUNNER_SMOKE_EVIDENCE_OUTPUT ?? DEFAULT_OUTPUT;
  const dispatch =
    options.dispatch || parseBoolean(values.RUNNER_SMOKE_DISPATCH) === true;
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? values.RUNNER_SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "RUNNER_SMOKE_TIMEOUT_MS",
  );
  const intervalMs = parsePositiveInteger(
    options.intervalMs ?? values.RUNNER_SMOKE_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    "RUNNER_SMOKE_INTERVAL_MS",
  );
  const requestedAt = new Date();
  const client = new ForgejoActionsClient({ baseUrl, token });

  if (dispatch) {
    log(`dispatching ${workflow} for ${repoName}@${ref}`);
    await client.dispatchWorkflow({ repo, workflow, ref });
  } else {
    log(`checking latest ${workflow} run for ${repoName}@${ref}`);
  }

  const result = dispatch
    ? await waitForPassingRun({
        client,
        repo,
        workflow,
        ref,
        requestedAt,
        timeoutMs,
        intervalMs,
      })
    : await readLatestPassingRun({ client, repo, workflow, ref });
  const evidence = buildEvidence({
    baseUrl,
    repo,
    repoName,
    workflow,
    ref,
    dispatch,
    requestedAt,
    run: result.run,
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  log(`wrote runner smoke evidence to ${outputPath}`);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--dispatch") {
      options.dispatch = true;
      continue;
    }

    if (arg === "--env-file") {
      index += 1;
      options.envFile = requireArg(args[index], "--env-file");
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      options.envFile = requireArg(
        arg.slice("--env-file=".length),
        "--env-file",
      );
      continue;
    }

    if (arg === "--forgejo-url") {
      index += 1;
      options.forgejoUrl = requireArg(args[index], "--forgejo-url");
      continue;
    }

    if (arg.startsWith("--forgejo-url=")) {
      options.forgejoUrl = requireArg(
        arg.slice("--forgejo-url=".length),
        "--forgejo-url",
      );
      continue;
    }

    if (arg === "--repo") {
      index += 1;
      options.repo = requireArg(args[index], "--repo");
      continue;
    }

    if (arg.startsWith("--repo=")) {
      options.repo = requireArg(arg.slice("--repo=".length), "--repo");
      continue;
    }

    if (arg === "--workflow") {
      index += 1;
      options.workflow = requireArg(args[index], "--workflow");
      continue;
    }

    if (arg.startsWith("--workflow=")) {
      options.workflow = requireArg(
        arg.slice("--workflow=".length),
        "--workflow",
      );
      continue;
    }

    if (arg === "--ref") {
      index += 1;
      options.ref = requireArg(args[index], "--ref");
      continue;
    }

    if (arg.startsWith("--ref=")) {
      options.ref = requireArg(arg.slice("--ref=".length), "--ref");
      continue;
    }

    if (arg === "--output") {
      index += 1;
      options.output = requireArg(args[index], "--output");
      continue;
    }

    if (arg.startsWith("--output=")) {
      options.output = requireArg(arg.slice("--output=".length), "--output");
      continue;
    }

    if (arg === "--timeout-ms") {
      index += 1;
      options.timeoutMs = requireArg(args[index], "--timeout-ms");
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = requireArg(
        arg.slice("--timeout-ms=".length),
        "--timeout-ms",
      );
      continue;
    }

    if (arg === "--interval-ms") {
      index += 1;
      options.intervalMs = requireArg(args[index], "--interval-ms");
      continue;
    }

    if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = requireArg(
        arg.slice("--interval-ms=".length),
        "--interval-ms",
      );
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return `usage: runner-smoke-evidence.mjs [--dispatch] [--repo owner/name] [--workflow runner-smoke.yml] [--ref main] [--output path]

Dispatches or verifies the trusted Forgejo Actions runner smoke workflow and
writes private evidence for runner-evidence.sh.

Environment:
  ENV_FILE                         Private deployment env file.
  RUNNER_SMOKE_FORGEJO_URL         Forgejo root URL; falls back to FORGEJO_ROOT_URL.
  RUNNER_SMOKE_FORGEJO_TOKEN       API token; falls back to FORGEJO_STEWARD_TOKEN.
  RUNNER_SMOKE_REPO                Repository containing .forgejo/workflows/runner-smoke.yml.
  RUNNER_SMOKE_WORKFLOW            Workflow filename. Default: runner-smoke.yml.
  RUNNER_SMOKE_REF                 Branch or tag to dispatch. Default: main.
  RUNNER_SMOKE_DISPATCH=true       Dispatch workflow_dispatch before polling.
  RUNNER_SMOKE_TIMEOUT_MS          Dispatch polling timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  RUNNER_SMOKE_INTERVAL_MS         Dispatch polling interval. Default: ${DEFAULT_INTERVAL_MS}.
  RUNNER_SMOKE_EVIDENCE_OUTPUT     Output path. Default: ${DEFAULT_OUTPUT}.

The token value is never printed.
`;
}

function readConfiguration(envFile, processEnv) {
  const fileValues = readEnvFile(envFile, processEnv.ALLOW_ENV_ONLY);
  const values = { ...fileValues };

  for (const key of inputKeys()) {
    if (processEnv[key] !== undefined) {
      values[key] = processEnv[key];
    }
  }

  return values;
}

function inputKeys() {
  return [
    "RUNNER_SMOKE_FORGEJO_URL",
    "RUNNER_SMOKE_FORGEJO_TOKEN",
    "RUNNER_SMOKE_REPO",
    "RUNNER_SMOKE_WORKFLOW",
    "RUNNER_SMOKE_REF",
    "RUNNER_SMOKE_DISPATCH",
    "RUNNER_SMOKE_TIMEOUT_MS",
    "RUNNER_SMOKE_INTERVAL_MS",
    "RUNNER_SMOKE_EVIDENCE_OUTPUT",
    "FORGEJO_ROOT_URL",
    "FORGEJO_STEWARD_TOKEN",
    "FORGEJO_TOKEN",
    "MERGE_STEWARD_SMOKE_REPO",
  ];
}

function readEnvFile(envFile, allowEnvOnly) {
  if (!existsSync(envFile)) {
    if (parseBoolean(allowEnvOnly) === true) {
      return {};
    }
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  return parseEnv(readFileSync(envFile, "utf8"));
}

function parseEnv(body) {
  const values = {};

  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(rawValue) {
  const value = rawValue.trimStart();

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted.replace(/\\([\\nrt"])/gu, (_, escaped) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return escaped;
      }
    });
  }

  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }

    if (value[index] === '"') {
      return index;
    }
  }

  return -1;
}

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (TRUE_PATTERN.test(String(value))) {
    return true;
  }

  if (FALSE_PATTERN.test(String(value))) {
    return false;
  }

  throw new Error(`expected boolean value but received ${value}`);
}

function parsePositiveInteger(value, fallback, key) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!/^[0-9]+$/u.test(String(value))) {
    throw new Error(`${key} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function parseRepo(value) {
  const [owner, repo, ...extra] = String(value).split("/");

  if (!owner || !repo || extra.length > 0) {
    throw new Error(`repository must use owner/name format: ${value}`);
  }

  return { owner, repo };
}

function requiredValue(value, key) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${key} is required`);
  }

  return String(value).trim();
}

function requireArg(value, name) {
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

class ForgejoActionsClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  dispatchWorkflow({ repo, workflow, ref }) {
    return this.request(
      "POST",
      `/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.repo)}/actions/workflows/${encodeSegment(workflow)}/dispatches`,
      {
        body: {
          ref,
          inputs: {},
        },
      },
    );
  }

  listWorkflowRuns({ repo, limit = 20 }) {
    return this.request(
      "GET",
      `/repos/${encodeSegment(repo.owner)}/${encodeSegment(repo.repo)}/actions/runs`,
      {
        query: {
          limit,
        },
      },
    );
  }

  async request(method, apiPath, { query = {}, body } = {}) {
    const url = new URL(`api/v1/${apiPath.replace(/^\/+/u, "")}`, this.baseUrl);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      Accept: "application/json",
      "User-Agent": "eliza-runner-smoke-evidence",
      Authorization: `token ${this.token}`,
    };
    const init = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    const contentType = response.headers?.get?.("content-type") ?? "";
    const responseBody =
      text && contentType.includes("application/json")
        ? JSON.parse(text)
        : text || null;

    if (!response.ok) {
      throw new Error(
        `Forgejo API ${method} ${apiPath} failed with ${response.status}`,
      );
    }

    return responseBody;
  }
}

async function readLatestPassingRun({ client, repo, workflow, ref }) {
  const body = await client.listWorkflowRuns({ repo });
  const runs = normalizeWorkflowRuns(body);
  const run = runs.find(
    (candidate) =>
      runMatches(candidate, { workflow, ref }) && runPassed(candidate),
  );

  if (!run) {
    throw new Error(
      `no passing ${workflow} runner smoke workflow was found for ${repo.owner}/${repo.repo}@${ref}`,
    );
  }

  return { run };
}

async function waitForPassingRun({
  client,
  repo,
  workflow,
  ref,
  requestedAt,
  timeoutMs,
  intervalMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastMatchedRun = null;

  while (Date.now() <= deadline) {
    const body = await client.listWorkflowRuns({ repo });
    const runs = normalizeWorkflowRuns(body);
    const run = runs.find((candidate) =>
      runMatches(candidate, { workflow, ref, requestedAt }),
    );

    if (run) {
      lastMatchedRun = run;
      if (runPassed(run)) {
        return { run };
      }

      if (runTerminalFailed(run)) {
        throw new Error(
          `runner smoke workflow finished with ${runConclusion(run)}`,
        );
      }
    }

    await sleep(intervalMs);
  }

  const suffix = lastMatchedRun
    ? `; last status was ${runConclusion(lastMatchedRun)}`
    : "";
  throw new Error(`runner smoke workflow did not pass before timeout${suffix}`);
}

function normalizeWorkflowRuns(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body?.workflow_runs)) {
    return body.workflow_runs;
  }

  if (Array.isArray(body?.runs)) {
    return body.runs;
  }

  if (Array.isArray(body?.actions)) {
    return body.actions;
  }

  return [];
}

function runMatches(run, { workflow, ref, requestedAt }) {
  return (
    workflowMatches(run, workflow) &&
    refMatches(run, ref) &&
    createdAfter(run, requestedAt)
  );
}

function workflowMatches(run, workflow) {
  const workflowStem = path.basename(workflow).replace(/\.ya?ml$/iu, "");
  const expected = [workflow, workflowStem].map(normalizeToken).filter(Boolean);
  const candidates = [
    run.path,
    run.workflow_id,
    run.workflow,
    run.workflow?.path,
    run.workflow?.name,
    run.name,
    run.display_title,
    run.title,
  ].map(normalizeToken);

  return candidates.some((candidate) =>
    expected.some((item) => candidate.includes(item)),
  );
}

function refMatches(run, ref) {
  const expected = normalizeRef(ref);
  const candidates = [
    run.head_branch,
    run.ref,
    run.ref_name,
    run.branch,
    run.head?.ref,
  ]
    .map(normalizeRef)
    .filter(Boolean);

  return (
    candidates.length === 0 ||
    candidates.some((candidate) => candidate === expected)
  );
}

function createdAfter(run, requestedAt) {
  if (!requestedAt) {
    return true;
  }

  const createdAt =
    run.created_at ??
    run.created ??
    run.createdAt ??
    run.run_started_at ??
    run.updated_at;
  if (!createdAt) {
    return true;
  }

  const createdTime = Date.parse(createdAt);
  if (Number.isNaN(createdTime)) {
    return true;
  }

  return createdTime >= requestedAt.getTime() - 30_000;
}

function runPassed(run) {
  return ["success", "passed"].includes(runConclusion(run));
}

function runTerminalFailed(run) {
  return [
    "failure",
    "failed",
    "cancelled",
    "canceled",
    "skipped",
    "timed_out",
    "timeout",
  ].includes(runConclusion(run));
}

function runConclusion(run) {
  return String(
    run.conclusion ?? run.result ?? run.status ?? "unknown",
  ).toLowerCase();
}

function buildEvidence({
  baseUrl,
  repo,
  repoName,
  workflow,
  ref,
  dispatch,
  requestedAt,
  run,
}) {
  return {
    runnerSmoke: {
      ok: true,
      trustedWorkflowPassed: true,
      repository: repoName,
      workflow,
      ref,
      dispatched: dispatch,
      requestedAt: requestedAt.toISOString(),
      observedAt: new Date().toISOString(),
      runId: run.id ?? run.run_id ?? null,
      runNumber: run.run_number ?? run.number ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? run.result ?? null,
      workflowRunUrl: workflowRunUrl({ baseUrl, repo, run }),
    },
  };
}

function workflowRunUrl({ baseUrl, repo, run }) {
  const existing = run.html_url ?? run.run_url ?? run.web_url;
  if (existing) {
    return existing;
  }

  const runNumber = run.run_number ?? run.number ?? run.id ?? run.run_id;
  if (!runNumber) {
    return null;
  }

  return new URL(
    `${repo.owner}/${repo.repo}/actions/runs/${runNumber}`,
    normalizeBaseUrl(baseUrl),
  ).href;
}

function normalizeToken(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function normalizeRef(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  return String(value)
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/tags\//u, "");
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(message) {
  console.error(`[runner-smoke-evidence] ${message}`);
}

main().catch((error) => {
  console.error(`[runner-smoke-evidence] error: ${error.message}`);
  process.exitCode = 1;
});
