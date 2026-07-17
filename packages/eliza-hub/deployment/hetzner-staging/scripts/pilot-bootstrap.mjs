#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath } from "./artifact-paths.mjs";

const DEFAULT_OUTPUT = artifactPath("eliza-hub-pilot-bootstrap-evidence.json");
const DEFAULT_REPO_OWNER = "elizaos";
const DEFAULT_REPO_NAME = "eliza";
const DEFAULT_UPSTREAM = "https://github.com/elizaos/eliza.git";
const DEFAULT_BRANCH = "main";
const DEFAULT_REQUIRED_CHECKS = ["runner-smoke / smoke"];
const DEFAULT_AGENT_IDS = ["agent-codex", "agent-docs"];
const WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "status",
];
const REQUIRED_APPLY_STEPS = Object.freeze([
  "forgejo-api-schema",
  "mirror-repository",
  "verify-default-branch",
  "steward-webhook",
  "branch-protection",
  "repo-policy",
  "agent-identities",
  "pilot-surfaces",
]);
const PASSING_STEP_STATUSES = Object.freeze([
  "verified",
  "verified-existing",
  "created",
  "updated",
  "upserted",
  "synced",
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
  const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
  const values = readConfiguration(envFile, process.env, {
    allowEnvOnly: options.allowEnvOnly,
  });
  const config = buildConfig(values, options);
  const steps = [];
  const startedAt = new Date().toISOString();

  if (config.dryRun) {
    buildDryRunPlan(config, steps);
  } else {
    await runApply(config, steps);
  }

  const evidence = buildEvidence({
    config,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  writeEvidence(config.output, evidence);
  log(`wrote pilot bootstrap evidence: ${config.output}`);

  if (config.dryRun) {
    log(
      "dry-run complete; rerun with --apply or PILOT_BOOTSTRAP_DRY_RUN=false to execute",
    );
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--apply") {
      options.dryRun = false;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--allow-env-only") {
      options.allowEnvOnly = true;
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
    if (arg === "--output") {
      index += 1;
      options.output = requireArg(args[index], "--output");
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = requireArg(arg.slice("--output=".length), "--output");
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
    if (arg === "--upstream") {
      index += 1;
      options.upstream = requireArg(args[index], "--upstream");
      continue;
    }
    if (arg.startsWith("--upstream=")) {
      options.upstream = requireArg(
        arg.slice("--upstream=".length),
        "--upstream",
      );
      continue;
    }
    if (arg === "--target-branch") {
      index += 1;
      options.targetBranch = requireArg(args[index], "--target-branch");
      continue;
    }
    if (arg.startsWith("--target-branch=")) {
      options.targetBranch = requireArg(
        arg.slice("--target-branch=".length),
        "--target-branch",
      );
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function buildConfig(values, options) {
  const repo = parseRepo(options.repo ?? values.ELIZA_HUB_REPO, values);
  const requiredChecks = parseJsonArray(
    values.ELIZA_REQUIRED_CHECKS,
    DEFAULT_REQUIRED_CHECKS,
    "ELIZA_REQUIRED_CHECKS",
  );
  const trustedAgentIds = parseJsonArray(
    values.ELIZA_TRUSTED_AGENT_IDS,
    DEFAULT_AGENT_IDS,
    "ELIZA_TRUSTED_AGENT_IDS",
  );
  const dryRun =
    options.dryRun ?? parseBoolean(values.PILOT_BOOTSTRAP_DRY_RUN, true);
  const forgejoRootUrl = requiredUrl(
    values.FORGEJO_ROOT_URL,
    "FORGEJO_ROOT_URL",
  );
  const stewardUrl = requiredUrl(values.MERGE_STEWARD_URL, "MERGE_STEWARD_URL");

  const config = {
    dryRun,
    output:
      options.output ?? values.PILOT_BOOTSTRAP_EVIDENCE_OUT ?? DEFAULT_OUTPUT,
    forgejoRootUrl,
    stewardUrl,
    forgejoToken:
      values.FORGEJO_BOOTSTRAP_TOKEN ?? values.FORGEJO_STEWARD_TOKEN ?? "",
    stewardToken:
      values.MERGE_STEWARD_CONTROL_TOKEN ??
      values.MERGE_STEWARD_API_TOKEN ??
      values.MERGE_STEWARD_DOCTOR_TOKEN ??
      "",
    webhookSecret: values.FORGEJO_WEBHOOK_SECRET ?? "",
    upstreamAuthToken: values.ELIZA_UPSTREAM_AUTH_TOKEN ?? "",
    repo,
    upstreamGitUrl:
      options.upstream ?? values.ELIZA_UPSTREAM_GIT_URL ?? DEFAULT_UPSTREAM,
    targetBranch:
      options.targetBranch ?? values.ELIZA_TARGET_BRANCH ?? DEFAULT_BRANCH,
    requiredChecks,
    trustedAgentIds,
    registeredBy:
      values.PILOT_BOOTSTRAP_REGISTERED_BY ?? "eliza-cloud-operator",
    mirrorInterval: values.ELIZA_MIRROR_INTERVAL ?? "10m",
  };

  if (!config.dryRun) {
    if (!config.forgejoToken)
      throw new Error(
        "FORGEJO_BOOTSTRAP_TOKEN or FORGEJO_STEWARD_TOKEN is required with --apply",
      );
    if (!config.stewardToken)
      throw new Error(
        "MERGE_STEWARD_CONTROL_TOKEN or MERGE_STEWARD_API_TOKEN is required with --apply",
      );
    if (!config.webhookSecret)
      throw new Error("FORGEJO_WEBHOOK_SECRET is required with --apply");
  }

  return config;
}

function buildDryRunPlan(config, steps) {
  addStep(steps, "forgejo-api-schema", "planned", {
    method: "GET",
    target: "swagger.v1.json or api/swagger",
  });
  addStep(steps, "mirror-repository", "planned", {
    method: "POST",
    path: "/api/v1/repos/migrate",
  });
  addStep(steps, "verify-default-branch", "planned", {
    method: "GET",
    path: `/api/v1/repos/${config.repo.owner}/${config.repo.name}/branches/${config.targetBranch}`,
  });
  addStep(steps, "steward-webhook", "planned", {
    method: "POST",
    path: `/api/v1/repos/${config.repo.owner}/${config.repo.name}/hooks`,
  });
  addStep(steps, "branch-protection", "planned", {
    method: "POST/PATCH",
    path: `/api/v1/repos/${config.repo.owner}/${config.repo.name}/branch_protections`,
  });
  addStep(steps, "repo-policy", "planned", {
    method: "POST",
    path: "/api/repo-policies",
  });
  addStep(steps, "agent-identities", "planned", {
    method: "POST",
    path: "/api/agent-identities",
    count: config.trustedAgentIds.length,
  });
  addStep(steps, "pilot-surfaces", "planned", {
    method: "GET",
    paths: ["/api/project-board", "/api/work-dashboard", "/api/merge-queue"],
  });
}

async function runApply(config, steps) {
  const forgejo = new HttpClient({
    baseUrl: config.forgejoRootUrl,
    token: config.forgejoToken,
    tokenScheme: "token",
  });
  const steward = new HttpClient({
    baseUrl: config.stewardUrl,
    token: config.stewardToken,
    tokenScheme: "Bearer",
  });

  await verifyForgejoSchema(forgejo, steps);
  await ensureMirrorRepository(forgejo, config, steps);
  await ensureWebhook(forgejo, config, steps);
  await ensureBranchProtection(forgejo, config, steps);
  await upsertRepoPolicy(steward, config, steps);
  await syncAgentIdentities(steward, config, steps);
  await verifyPilotSurfaces(steward, config, steps);
}

async function verifyForgejoSchema(forgejo, steps) {
  for (const candidate of ["swagger.v1.json", "api/swagger"]) {
    try {
      await forgejo.get(candidate, { api: false });
      addStep(steps, "forgejo-api-schema", "verified", {
        path: `/${candidate}`,
      });
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  throw new Error(
    "Forgejo API schema was not available at /swagger.v1.json or /api/swagger",
  );
}

async function ensureMirrorRepository(forgejo, config, steps) {
  const repoPath = `repos/${encodeSegment(config.repo.owner)}/${encodeSegment(config.repo.name)}`;
  let repo = null;

  try {
    repo = await forgejo.get(repoPath);
    addStep(steps, "mirror-repository", "verified-existing", {
      repo: config.repo.fullName,
      mirror:
        repo?.mirror === true || repo?.mirror === undefined
          ? repo?.mirror
          : false,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;

    await forgejo.post("repos/migrate", {
      clone_addr: config.upstreamGitUrl,
      auth_token: config.upstreamAuthToken || undefined,
      repo_owner: config.repo.owner,
      repo_name: config.repo.name,
      service: "github",
      mirror: true,
      mirror_interval: config.mirrorInterval,
      private: true,
      issues: true,
      labels: true,
      milestones: true,
      pull_requests: true,
      releases: true,
      wiki: false,
      lfs: true,
    });
    addStep(steps, "mirror-repository", "created", {
      repo: config.repo.fullName,
      mirror: true,
      private: true,
    });
    repo = await forgejo.get(repoPath);
  }

  const branch = await forgejo.get(
    `${repoPath}/branches/${encodeSegment(config.targetBranch)}`,
  );
  addStep(steps, "verify-default-branch", "verified", {
    repo: config.repo.fullName,
    branch: branch?.name ?? config.targetBranch,
  });

  return repo;
}

async function ensureWebhook(forgejo, config, steps) {
  const hooksPath = `repos/${encodeSegment(config.repo.owner)}/${encodeSegment(config.repo.name)}/hooks`;
  const webhookUrl = joinUrl(config.stewardUrl, "/api/webhooks/forgejo");
  const hooks = arrayValue(await forgejo.get(hooksPath));
  const existing = hooks.find(
    (hook) =>
      hook?.type === "forgejo" &&
      hook?.active !== false &&
      hook?.config?.url === webhookUrl,
  );

  if (existing) {
    addStep(steps, "steward-webhook", "verified-existing", {
      id: existing.id ?? null,
      url: webhookUrl,
      events: existing.events ?? [],
    });
    return existing;
  }

  const created = await forgejo.post(hooksPath, {
    type: "forgejo",
    active: true,
    branch_filter: "*",
    events: WEBHOOK_EVENTS,
    config: {
      url: webhookUrl,
      content_type: "json",
      secret: config.webhookSecret,
    },
  });
  addStep(steps, "steward-webhook", "created", {
    id: created?.id ?? null,
    url: webhookUrl,
    events: WEBHOOK_EVENTS,
  });
  return created;
}

async function ensureBranchProtection(forgejo, config, steps) {
  const protectionPath = `repos/${encodeSegment(config.repo.owner)}/${encodeSegment(config.repo.name)}/branch_protections`;
  const protections = arrayValue(await forgejo.get(protectionPath));
  const existing = protections.find(
    (rule) => rule?.rule_name === config.targetBranch,
  );
  const body = branchProtectionBody(config);

  if (!existing) {
    const created = await forgejo.post(protectionPath, body);
    addStep(
      steps,
      "branch-protection",
      "created",
      branchProtectionSummary(created ?? body, config),
    );
    return created;
  }

  if (branchProtectionMatches(existing, config)) {
    addStep(
      steps,
      "branch-protection",
      "verified-existing",
      branchProtectionSummary(existing, config),
    );
    return existing;
  }

  const updated = await forgejo.patch(
    `${protectionPath}/${encodeSegment(config.targetBranch)}`,
    body,
  );
  addStep(
    steps,
    "branch-protection",
    "updated",
    branchProtectionSummary(updated ?? body, config),
  );
  return updated;
}

async function upsertRepoPolicy(steward, config, steps) {
  const body = { policy: repoPolicyBody(config) };
  const result = await steward.post("api/repo-policies", body, { api: false });
  addStep(steps, "repo-policy", "upserted", {
    repo: result?.policy?.repo ?? config.repo.fullName,
    queueMode: result?.policy?.queueMode ?? "batched",
    requiredChecks: result?.policy?.requiredChecks ?? config.requiredChecks,
  });

  await steward.get(
    `api/repo-policies/item?repo=${encodeURIComponent(config.repo.fullName)}`,
    { api: false },
  );
  addStep(steps, "repo-policy-verify", "verified", {
    repo: config.repo.fullName,
  });
}

async function syncAgentIdentities(steward, config, steps) {
  const synced = [];
  for (const id of config.trustedAgentIds) {
    const result = await steward.post(
      "api/agent-identities",
      {
        agent: {
          id,
          displayName: id,
          source: "eliza-cloud",
          status: "active",
          metadata: {
            pilot: true,
            repo: config.repo.fullName,
          },
        },
        registeredBy: config.registeredBy,
      },
      { api: false },
    );
    synced.push(result?.agent?.id ?? id);
  }

  const active = await steward.get("api/agent-identities?status=active", {
    api: false,
  });
  addStep(steps, "agent-identities", "synced", {
    synced,
    activeCount: Array.isArray(active?.agents) ? active.agents.length : null,
  });
}

async function verifyPilotSurfaces(steward, config, steps) {
  const repo = encodeURIComponent(config.repo.fullName);
  await steward.get(
    `api/repository-protection?repo=${repo}&targetBranch=${encodeURIComponent(config.targetBranch)}&requireLive=true`,
    { api: false },
  );
  await steward.get(`api/project-board?repo=${repo}&emptyColumns=true`, {
    api: false,
  });
  await steward.get(`api/work-dashboard?repo=${repo}`, { api: false });
  await steward.get(`api/merge-queue?repo=${repo}`, { api: false });
  addStep(steps, "pilot-surfaces", "verified", {
    repo: config.repo.fullName,
    surfaces: [
      "repository-protection",
      "project-board",
      "work-dashboard",
      "merge-queue",
    ],
  });
}

function repoPolicyBody(config) {
  return {
    repo: config.repo.fullName,
    queueMode: "batched",
    protectedBranches: [config.targetBranch],
    requiredChecks: config.requiredChecks,
    trustedActors: config.trustedAgentIds,
    allowForks: false,
    policy: {
      maxBatchSize: 4,
      requireStackDependencyOrder: true,
      requireWorkReservation: true,
      requireWorkItem: true,
      requireVerifiedAgentRunReceipt: true,
    },
  };
}

function branchProtectionBody(config) {
  return {
    rule_name: config.targetBranch,
    enable_push: false,
    enable_push_whitelist: true,
    push_whitelist_usernames: [],
    push_whitelist_teams: [],
    enable_status_check: true,
    status_check_contexts: config.requiredChecks,
    block_on_outdated_branch: true,
    block_on_rejected_reviews: true,
    dismiss_stale_approvals: true,
    required_approvals: 1,
    require_signed_commits: false,
    apply_to_admins: true,
  };
}

function branchProtectionMatches(rule, config) {
  const contexts = new Set(arrayValue(rule?.status_check_contexts));
  return (
    rule?.enable_status_check === true &&
    config.requiredChecks.every((check) => contexts.has(check)) &&
    Number(rule?.required_approvals ?? 0) >= 1 &&
    rule?.apply_to_admins === true
  );
}

function branchProtectionSummary(rule, config) {
  return {
    ruleName: rule?.rule_name ?? config.targetBranch,
    enableStatusCheck: rule?.enable_status_check === true,
    requiredChecks:
      arrayValue(rule?.status_check_contexts).length > 0
        ? arrayValue(rule.status_check_contexts)
        : config.requiredChecks,
    requiredApprovals: Number(rule?.required_approvals ?? 1),
    applyToAdmins: rule?.apply_to_admins === true,
  };
}

function buildEvidence({ config, steps, startedAt, finishedAt }) {
  const upstream = summarizeUpstream(config.upstreamGitUrl);
  const summary = summarizeBootstrapSteps({ config, steps, upstream });

  return {
    schema: "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1",
    status: "passed",
    dryRun: config.dryRun,
    startedAt,
    finishedAt,
    repo: {
      owner: config.repo.owner,
      name: config.repo.name,
      fullName: config.repo.fullName,
      targetBranch: config.targetBranch,
    },
    upstream,
    migration: {
      sourceService: upstream.service,
      direction: "pull",
      mirror: true,
      private: true,
    },
    requiredChecks: config.requiredChecks,
    trustedAgentIds: config.trustedAgentIds,
    summary,
    outputs: {
      evidence: config.output,
    },
    steps,
  };
}

function summarizeBootstrapSteps({ config, steps, upstream }) {
  const summary = {
    productionReady: false,
    stepCount: steps.length,
    requiredCheckCount: config.requiredChecks.length,
    trustedAgentCount: config.trustedAgentIds.length,
    mirrorVerified: successfulStep(
      steps,
      "mirror-repository",
      (step) => step.status === "created" || step.mirror === true,
    ),
    defaultBranchVerified: successfulStep(steps, "verify-default-branch"),
    webhookVerified: successfulStep(steps, "steward-webhook"),
    branchProtectionVerified: successfulStep(steps, "branch-protection"),
    repoPolicyVerified:
      successfulStep(steps, "repo-policy") &&
      (config.dryRun || successfulStep(steps, "repo-policy-verify")),
    agentIdentitiesSynced: successfulStep(steps, "agent-identities"),
    pilotSurfacesVerified: successfulStep(steps, "pilot-surfaces"),
    pullMirrorOnly: upstream.service === "github",
  };

  summary.productionReady =
    config.dryRun === false &&
    summary.pullMirrorOnly === true &&
    summary.requiredCheckCount > 0 &&
    summary.trustedAgentCount > 0 &&
    REQUIRED_APPLY_STEPS.every((stepName) => successfulStep(steps, stepName)) &&
    summary.mirrorVerified === true &&
    summary.defaultBranchVerified === true &&
    summary.webhookVerified === true &&
    summary.branchProtectionVerified === true &&
    summary.repoPolicyVerified === true &&
    summary.agentIdentitiesSynced === true &&
    summary.pilotSurfacesVerified === true;

  return summary;
}

function successfulStep(steps, name, predicate = () => true) {
  return steps.some(
    (step) =>
      step?.name === name &&
      PASSING_STEP_STATUSES.includes(step.status) &&
      predicate(step),
  );
}

function addStep(steps, name, status, detail = {}) {
  steps.push({
    index: steps.length + 1,
    name,
    status,
    ...redactDetail(detail),
  });
}

function redactDetail(value) {
  if (Array.isArray(value)) return value.map(redactDetail);
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|auth/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = redactDetail(child);
    }
  }
  return output;
}

function summarizeUpstream(upstreamGitUrl) {
  try {
    const url = new URL(upstreamGitUrl);
    return {
      host: url.host,
      pathname: url.pathname,
      service: url.host.includes("github.com") ? "github" : "git",
    };
  } catch {
    return {
      host: null,
      pathname: null,
      service: "git",
    };
  }
}

function writeEvidence(outputPath, evidence) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readConfiguration(envFile, env, { allowEnvOnly = false } = {}) {
  const values = { ...env };
  if (!existsSync(envFile)) {
    if (allowEnvOnly || parseBoolean(env.ALLOW_ENV_ONLY, false)) return values;
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^(?:export|source|\.)\s/.test(trimmed)) {
      throw new Error(
        `unsupported shell syntax in ${envFile} line ${index + 1}`,
      );
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      throw new Error(
        `malformed env assignment in ${envFile} line ${index + 1}`,
      );
    }
    if (match[2].includes("$(") || match[2].includes("`")) {
      throw new Error(
        `command substitution is not allowed in ${envFile} line ${index + 1}`,
      );
    }

    values[match[1]] = unquote(match[2]);
  });

  return values;
}

function parseRepo(value, env) {
  const fullName =
    value ??
    (env.ELIZA_HUB_REPO_OWNER && env.ELIZA_HUB_REPO_NAME
      ? `${env.ELIZA_HUB_REPO_OWNER}/${env.ELIZA_HUB_REPO_NAME}`
      : `${DEFAULT_REPO_OWNER}/${DEFAULT_REPO_NAME}`);
  const [owner, name, extra] = String(fullName).split("/");
  if (!owner || !name || extra)
    throw new Error("ELIZA_HUB_REPO must be owner/name");
  return { owner, name, fullName: `${owner}/${name}` };
}

function parseJsonArray(raw, fallback, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be a JSON array: ${error.message}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} must be a JSON array of non-empty strings`);
  }
  return parsed;
}

function requiredUrl(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function joinUrl(base, pathname) {
  return new URL(pathname.replace(/^\/+/, ""), base).toString();
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value));
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function isNotFound(error) {
  return error?.status === 404;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function log(message) {
  process.stdout.write(`[pilot-bootstrap] ${message}\n`);
}

class HttpClient {
  constructor({ baseUrl, token, tokenScheme }) {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    this.baseUrl = url;
    this.apiBaseUrl = new URL("api/v1/", url);
    this.token = token;
    this.tokenScheme = tokenScheme;
  }

  get(pathname, options) {
    return this.request("GET", pathname, options);
  }

  post(pathname, body, options) {
    return this.request("POST", pathname, { ...options, body });
  }

  patch(pathname, body, options) {
    return this.request("PATCH", pathname, { ...options, body });
  }

  async request(method, pathname, { body, api = true } = {}) {
    const base = api ? this.apiBaseUrl : this.baseUrl;
    const url = new URL(String(pathname).replace(/^\/+/, ""), base);
    const headers = {
      Accept: "application/json",
      "User-Agent": "eliza-hub-pilot-bootstrap",
    };
    if (this.token) headers.Authorization = `${this.tokenScheme} ${this.token}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const parsed =
      text && contentType.includes("application/json")
        ? JSON.parse(text)
        : text || null;
    if (!response.ok) {
      const error = new Error(
        `${method} ${url.pathname} failed with ${response.status}`,
      );
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return parsed;
  }
}

function usage() {
  return `Usage: pilot-bootstrap.mjs [--apply] [--env-file PATH] [--repo owner/name]

Bootstraps the first private Eliza Hub pilot repository.

Defaults are intentionally safe:
  PILOT_BOOTSTRAP_DRY_RUN=true  Plan the bootstrap and write evidence only.

Live mode requires --apply or PILOT_BOOTSTRAP_DRY_RUN=false and private tokens:
  FORGEJO_BOOTSTRAP_TOKEN
  FORGEJO_WEBHOOK_SECRET
  MERGE_STEWARD_CONTROL_TOKEN or MERGE_STEWARD_API_TOKEN

Important inputs:
  FORGEJO_ROOT_URL
  MERGE_STEWARD_URL
  ELIZA_HUB_REPO or ELIZA_HUB_REPO_OWNER / ELIZA_HUB_REPO_NAME
  ELIZA_UPSTREAM_GIT_URL
  ELIZA_TARGET_BRANCH
  ELIZA_REQUIRED_CHECKS='["runner-smoke / smoke"]'
  ELIZA_TRUSTED_AGENT_IDS='["agent-codex","agent-docs"]'
  PILOT_BOOTSTRAP_EVIDENCE_OUT
`;
}

main().catch((error) => {
  process.stderr.write(
    `[pilot-bootstrap] error: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
