#!/usr/bin/env node

/**
 * Reconciles exact-input branch effects through the durable GitHub Deployment
 * ledger and admits only the still-current fully verified source commit.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  verifyCompleteManifest,
} from "./develop-impact-evidence.mjs";
import {
  requestReviewedPromotion,
  verifyMergedPromotion,
} from "./reviewed-branch-promotion.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_REGISTRY = ".github/develop-effects.json";
const API_VERSION = "2026-03-10";
const LEDGER_SCHEMA_VERSION = 1;
const PAGE_SIZE = 100;
const MAX_LEDGER_PAGES = 10;
const PAYLOAD_KEYS = [
  "effect",
  "inputDigest",
  "ledgerDigest",
  "ledgerVersion",
  "schemaVersion",
  "sourceRunId",
  "sourceSha",
  "workflow",
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertFullSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase full commit SHA`);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requireString(args, key) {
  if (typeof args[key] !== "string" || !args[key]) {
    throw new Error(`--${key} is required`);
  }
  return args[key];
}

function environment(name) {
  return process.env[name];
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertPromotionBranches(sourceBranch, targetBranch) {
  const nextBranch = { develop: "staging", staging: "main" }[sourceBranch];
  if (!nextBranch || targetBranch !== nextBranch) {
    throw new Error("promotion must follow develop -> staging -> main");
  }
}

export function validateRegistry(registry) {
  assertObject(registry, "effect registry");
  if (registry.schemaVersion !== 1)
    throw new Error("unsupported effect registry schemaVersion");
  if (typeof registry.ledgerVersion !== "string" || !registry.ledgerVersion) {
    throw new Error("ledgerVersion must be a non-empty string");
  }
  if (!Array.isArray(registry.effects) || registry.effects.length === 0) {
    throw new Error("effect registry must contain effects");
  }
  const ids = new Set();
  if (registry.afterPromotionEffects !== undefined) {
    throw new Error(
      "post-promotion effects must validate the destination branch first",
    );
  }
  const branch = registry.sourceBranch ?? registry.promotion?.sourceBranch;
  if (!["develop", "staging", "main"].includes(branch))
    throw new Error("invalid registry source branch");
  for (const effect of registry.effects) {
    assertObject(effect, "effect");
    if (!/^[a-z][a-z0-9-]*$/.test(effect.id ?? "")) {
      throw new Error(`invalid effect id: ${effect.id}`);
    }
    if (ids.has(effect.id))
      throw new Error(`duplicate effect id: ${effect.id}`);
    ids.add(effect.id);
    if (!/^[a-z0-9-]+\.yml$/.test(effect.workflow ?? "")) {
      throw new Error(`${effect.id}: invalid workflow`);
    }
    if (!Array.isArray(effect.surfaces) || effect.surfaces.length === 0) {
      throw new Error(`${effect.id}: surfaces must be non-empty`);
    }
    if (new Set(effect.surfaces).size !== effect.surfaces.length) {
      throw new Error(`${effect.id}: duplicate surface`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(effect.shaInput ?? "")) {
      throw new Error(`${effect.id}: invalid shaInput`);
    }
    assertObject(effect.inputs, `${effect.id} inputs`);
    if (Object.hasOwn(effect.inputs, effect.shaInput)) {
      throw new Error(`${effect.id}: inputs may not override shaInput`);
    }
    if (Object.hasOwn(effect.inputs, "effect_digest")) {
      throw new Error(`${effect.id}: inputs may not override effect_digest`);
    }
    for (const [key, value] of Object.entries(effect.inputs)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof value !== "string") {
        throw new Error(`${effect.id}: inputs must be string-keyed strings`);
      }
    }
  }
  if (branch === "main") {
    if (registry.promotion !== null)
      throw new Error(
        "promotion must follow develop -> staging -> main; main is terminal",
      );
    return registry;
  }
  assertObject(registry.promotion, "promotion");
  if (registry.promotion.sourceBranch !== branch)
    throw new Error("registry source branch mismatch");
  if (ids.has(registry.promotion.id))
    throw new Error("promotion id collides with effect");
  for (const key of ["id", "sourceBranch", "targetBranch"]) {
    if (!/^[a-z][a-z0-9-]*$/.test(registry.promotion[key] ?? "")) {
      throw new Error(`invalid promotion ${key}`);
    }
  }
  assertPromotionBranches(
    registry.promotion.sourceBranch,
    registry.promotion.targetBranch,
  );
  return registry;
}

function workflowDigest(repoRoot, workflow) {
  const filePath = path.join(repoRoot, ".github/workflows", workflow);
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(`effect workflow is absent or non-regular: ${workflow}`);
  }
  return sha256(readFileSync(filePath));
}

export function buildEffectPlans({ expected, observed, registry, repoRoot }) {
  validateRegistry(registry);
  const verified = verifyCompleteManifest(expected, observed.surfaces);
  if (canonicalJson(verified) !== canonicalJson(observed)) {
    throw new Error(
      "observed manifest does not exactly match verified evidence",
    );
  }
  const surfaces = new Map(
    expected.surfaces.map((surface) => [surface.id, surface]),
  );
  const registryDigest = sha256(canonicalJson(registry));
  const planEffect = (effect, sourceBranch) => {
    const surfaceDigests = Object.fromEntries(
      [...new Set(effect.surfaces)].sort(compareText).map((id) => {
        const surface = surfaces.get(id);
        if (!surface) throw new Error(`${effect.id}: unknown surface ${id}`);
        return [id, surface.inputDigest];
      }),
    );
    const digest = sha256(
      canonicalJson({
        effect: effect.id,
        sourceSha: expected.headSha,
        inputs: effect.inputs,
        ledgerVersion: registry.ledgerVersion,
        registryDigest,
        shaInput: effect.shaInput,
        surfaceDigests,
        workflow: effect.workflow,
        workflowDigest: workflowDigest(repoRoot, effect.workflow),
      }),
    );
    return {
      ...effect,
      sourceBranch,
      environment: `develop-effect/${effect.id}`,
      inputDigest: digest,
      surfaceDigests,
    };
  };
  const plans = registry.effects.map((effect) =>
    planEffect(
      effect,
      registry.sourceBranch ?? registry.promotion.sourceBranch,
    ),
  );
  const promotionDigest = sha256(
    canonicalJson({
      environmentDigest: expected.environmentDigest,
      graphDigest: expected.graphDigest,
      ledgerVersion: registry.ledgerVersion,
      registryDigest,
      sourceSha: expected.headSha,
      surfaces: Object.fromEntries(
        expected.surfaces.map(({ id, inputDigest }) => [id, inputDigest]),
      ),
    }),
  );
  return {
    plans,
    promotion:
      registry.promotion === null
        ? null
        : {
            ...registry.promotion,
            environment: `develop-effect/${registry.promotion.id}`,
            inputDigest: promotionDigest,
          },
    registryDigest,
  };
}

export function validateSourceRun(
  run,
  sourceSha,
  sourceRunId,
  sourceBranch = "develop",
) {
  if (!["develop", "staging", "main"].includes(sourceBranch)) {
    throw new Error("source branch must be develop, staging, or main");
  }
  assertObject(run, "source workflow run");
  assertFullSha(sourceSha, "source SHA");
  if (String(run.id) !== String(sourceRunId))
    throw new Error("source workflow run id mismatch");
  if (run.event !== "push" && !(run.event === "workflow_dispatch")) {
    throw new Error(
      "source workflow was not a push or a staging validation dispatch",
    );
  }
  if (run.head_branch !== sourceBranch)
    throw new Error(`source workflow branch is not ${sourceBranch}`);
  if (run.head_sha !== sourceSha)
    throw new Error("source workflow SHA mismatch");
  if (run.path !== ".github/workflows/develop-full.yml") {
    throw new Error("source workflow is not Develop Full");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("source Develop Full run is not green");
  }
  return run;
}

export function createLedgerPayload({
  effect,
  inputDigest,
  ledgerVersion,
  sourceRunId,
  sourceSha,
  workflow,
}) {
  assertFullSha(sourceSha, "ledger source SHA");
  if (!/^[0-9a-f]{64}$/.test(inputDigest))
    throw new Error("ledger input digest is invalid");
  const payload = {
    effect,
    inputDigest,
    ledgerVersion,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sourceRunId: String(sourceRunId),
    sourceSha,
    workflow,
  };
  return { ...payload, ledgerDigest: sha256(canonicalJson(payload)) };
}

export function verifyLedgerPayload(payload) {
  assertObject(payload, "ledger payload");
  const keys = Object.keys(payload).sort(compareText);
  if (canonicalJson(keys) !== canonicalJson(PAYLOAD_KEYS)) {
    throw new Error("ambiguous ledger payload fields");
  }
  if (payload.schemaVersion !== LEDGER_SCHEMA_VERSION)
    throw new Error("stale ledger schema");
  assertFullSha(payload.sourceSha, "ledger source SHA");
  if (!/^[0-9a-f]{64}$/.test(payload.inputDigest ?? "")) {
    throw new Error("invalid ledger input digest");
  }
  const { ledgerDigest, ...unsigned } = payload;
  if (ledgerDigest !== sha256(canonicalJson(unsigned))) {
    throw new Error("ledger payload digest mismatch");
  }
  return payload;
}

export function decideEffectReconciliation(plan, sourceSha, deployments) {
  const valid = deployments.map((deployment) => ({
    ...deployment,
    payload: verifyLedgerPayload(deployment.payload),
  }));
  const exact = valid.filter(
    ({ payload }) =>
      payload.effect === plan.id && payload.sourceSha === sourceSha,
  );
  if (exact.length > 1) throw new Error(`${plan.id}: duplicate exact ledger`);
  if (exact.length === 1) {
    if (exact[0].payload.inputDigest !== plan.inputDigest) {
      throw new Error(`${plan.id}: exact SHA has conflicting input digest`);
    }
    if (exact[0].state === "success")
      return { action: "reuse-exact", deployment: exact[0] };
    return { action: "resume", deployment: exact[0] };
  }
  const reusable = valid
    .filter(
      ({ payload, state }) =>
        payload.effect === plan.id &&
        payload.inputDigest === plan.inputDigest &&
        state === "success",
    )
    .sort((left, right) => Number(right.id) - Number(left.id));
  if (reusable.length > 0)
    return { action: "reuse-input", deployment: reusable[0] };
  return { action: "dispatch" };
}

export function decidePromotion({
  developSha,
  mainSha,
  sourceSha,
  comparison,
}) {
  assertFullSha(developSha, "develop SHA");
  assertFullSha(mainSha, "main SHA");
  assertFullSha(sourceSha, "promotion source SHA");
  if (developSha !== sourceSha) return { action: "stale" };
  if (mainSha === sourceSha) return { action: "reconcile-success" };
  if (comparison === "behind") return { action: "reconcile-success" };
  if (!["ahead", "diverged"].includes(comparison))
    throw new Error("invalid branch comparison");
  return { action: "awaiting-review" };
}

export function simulateReconciliation({ plans, sourceSha, state }) {
  assertFullSha(sourceSha, "source SHA");
  if (state.developSha !== sourceSha) {
    return { sourceSha, stale: true, effects: [], promotion: "stale" };
  }
  const effects = plans.plans.map((plan) => {
    const decision = decideEffectReconciliation(
      plan,
      sourceSha,
      state.deployments?.[plan.id] ?? [],
    );
    return {
      id: plan.id,
      inputDigest: plan.inputDigest,
      action: decision.action,
    };
  });
  const promotion =
    plans.promotion === null
      ? "complete"
      : decidePromotion({
          comparison: state.comparison,
          developSha: state.developSha,
          mainSha: state.mainSha,
          sourceSha,
        }).action;
  return { sourceSha, stale: false, effects, promotion };
}

class GitHubApi {
  constructor({ apiUrl, repository, token }) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    if (!/^[^/]+\/[^/]+$/.test(repository ?? ""))
      throw new Error("GITHUB_REPOSITORY is invalid");
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.repository = repository;
    this.token = token;
  }

  async request(method, endpoint, body) {
    const response = await fetch(
      `${this.apiUrl}/repos/${this.repository}${endpoint}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${endpoint} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }

  async graphql(query, variables) {
    const response = await fetch(`${this.apiUrl}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    const result = text ? JSON.parse(text) : null;
    if (!response.ok || result?.errors?.length) {
      throw new Error(
        `GitHub GraphQL failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    return result?.data;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSource(api, sourceSha, sourceRunId, sourceBranch) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const run = await api.request("GET", `/actions/runs/${sourceRunId}`);
    if (run.status === "completed")
      return validateSourceRun(run, sourceSha, sourceRunId, sourceBranch);
    await sleep(5_000);
  }
  throw new Error("timed out waiting for Develop Full completion");
}

function deploymentState(deployment, statuses) {
  return {
    ...deployment,
    state: statuses[0]?.state ?? "pending",
    status: statuses[0] ?? null,
  };
}

export async function listEffectDeployments(api, plan) {
  const deployments = [];
  for (let page = 1; page <= MAX_LEDGER_PAGES; page += 1) {
    const batch = await api.request(
      "GET",
      `/deployments?environment=${encodeURIComponent(plan.environment)}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error(`${plan.id}: invalid ledger page`);
    deployments.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_LEDGER_PAGES) {
      throw new Error(
        `${plan.id}: ledger exceeds ${MAX_LEDGER_PAGES * PAGE_SIZE} rows`,
      );
    }
  }
  const candidates = [];
  for (const deployment of deployments) {
    const payload = verifyLedgerPayload(deployment.payload);
    if (payload.effect !== plan.id) continue;
    const statuses = await api.request(
      "GET",
      `/deployments/${deployment.id}/statuses?per_page=1`,
    );
    candidates.push(deploymentState({ ...deployment, payload }, statuses));
  }
  return candidates;
}

async function createDeployment(api, plan, payload) {
  return api.request("POST", "/deployments", {
    auto_merge: false,
    description: `Reconcile ${plan.id} for ${payload.sourceSha.slice(0, 12)}`,
    environment: plan.environment,
    payload,
    production_environment: false,
    ref: payload.sourceSha,
    required_contexts: [],
    task: "develop-reconcile",
    transient_environment: true,
  });
}

async function setDeploymentStatus(
  api,
  deploymentId,
  state,
  description,
  logUrl = "",
) {
  return api.request("POST", `/deployments/${deploymentId}/statuses`, {
    auto_inactive: false,
    description: description.slice(0, 140),
    log_url: logUrl,
    state,
  });
}

function runIdFromStatus(status) {
  const match = status?.log_url?.match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export async function dispatchEffect(api, plan, sourceSha) {
  const response = await api.request(
    "POST",
    `/actions/workflows/${encodeURIComponent(plan.workflow)}/dispatches`,
    {
      inputs: {
        ...plan.inputs,
        effect_digest: plan.inputDigest,
        [plan.shaInput]: sourceSha,
      },
      ref: plan.sourceBranch,
      return_run_details: true,
    },
  );
  const runId = Number(response?.workflow_run_id);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`${plan.id}: dispatch returned no workflow run id`);
  }
  return runId;
}

export function selectRediscoveredRun(plan, sourceSha, runs) {
  const matches = runs.filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      run.head_sha === sourceSha &&
      run.head_branch === plan.sourceBranch &&
      String(run.path).endsWith(`/${plan.workflow}`) &&
      String(run.display_title).includes(sourceSha) &&
      String(run.display_title).includes(plan.inputDigest),
  );
  if (matches.length > 1) {
    throw new Error(
      `${plan.id}: multiple downstream runs match the durable ledger`,
    );
  }
  return matches[0] ?? null;
}

async function rediscoverEffectRun(api, plan, sourceSha) {
  const runs = [];
  for (let page = 1; page <= MAX_LEDGER_PAGES; page += 1) {
    const response = await api.request(
      "GET",
      `/actions/workflows/${encodeURIComponent(plan.workflow)}/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(sourceSha)}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(response?.workflow_runs)) {
      throw new Error(`${plan.id}: invalid downstream run page`);
    }
    runs.push(...response.workflow_runs);
    if (response.workflow_runs.length < PAGE_SIZE) break;
    if (page === MAX_LEDGER_PAGES) {
      throw new Error(
        `${plan.id}: downstream run search exceeded ${MAX_LEDGER_PAGES * PAGE_SIZE} rows`,
      );
    }
  }
  return selectRediscoveredRun(plan, sourceSha, runs);
}

async function waitForEffectRun(api, plan, sourceSha, runId) {
  for (let attempt = 0; attempt < 960; attempt += 1) {
    const run = await api.request("GET", `/actions/runs/${runId}`);
    if (run.event !== "workflow_dispatch")
      throw new Error(`${plan.id}: downstream run event mismatch`);
    if (run.head_sha !== sourceSha)
      throw new Error(`${plan.id}: downstream run SHA mismatch`);
    if (run.head_branch !== plan.sourceBranch)
      throw new Error(`${plan.id}: downstream run branch mismatch`);
    if (!String(run.path).endsWith(`/${plan.workflow}`))
      throw new Error(`${plan.id}: downstream workflow mismatch`);
    if (run.status === "completed") return run;
    await sleep(15_000);
  }
  throw new Error(`${plan.id}: downstream run timed out`);
}

export async function reconcileEffect(api, plan, context) {
  const deployments = await listEffectDeployments(api, plan);
  const decision = decideEffectReconciliation(
    plan,
    context.sourceSha,
    deployments,
  );
  const payload = createLedgerPayload({
    effect: plan.id,
    inputDigest: plan.inputDigest,
    ledgerVersion: context.ledgerVersion,
    sourceRunId: context.sourceRunId,
    sourceSha: context.sourceSha,
    workflow: plan.workflow,
  });
  if (decision.action === "reuse-exact") return decision.deployment;
  if (decision.action === "reuse-input") {
    const deployment = await createDeployment(api, plan, payload);
    await setDeploymentStatus(
      api,
      deployment.id,
      "success",
      `Reused exact input proof from deployment ${decision.deployment.id}`,
      decision.deployment.status?.log_url ?? "",
    );
    return { ...deployment, payload, state: "success" };
  }
  const deployment =
    decision.action === "resume"
      ? decision.deployment
      : await createDeployment(api, plan, payload);
  let runId = runIdFromStatus(deployment.status);
  if (!runId && decision.action === "resume") {
    const rediscovered = await rediscoverEffectRun(
      api,
      plan,
      context.sourceSha,
    );
    runId = rediscovered?.id ?? null;
    if (!runId) {
      throw new Error(
        `${plan.id}: interrupted dispatch has no rediscoverable run; refusing ambiguous redelivery`,
      );
    }
  }
  if (!runId && ["failure", "error"].includes(deployment.state)) {
    throw new Error(
      `${plan.id}: failed effect has no rediscoverable run; refusing redelivery`,
    );
  }
  if (!runId) {
    await setDeploymentStatus(
      api,
      deployment.id,
      "queued",
      "Awaiting exact downstream dispatch",
    );
    runId = await dispatchEffect(api, plan, context.sourceSha);
    await setDeploymentStatus(
      api,
      deployment.id,
      "in_progress",
      `Downstream run ${runId} is reconciling`,
      `${context.serverUrl}/${context.repository}/actions/runs/${runId}`,
    );
  }
  const run = await waitForEffectRun(api, plan, context.sourceSha, runId);
  const logUrl = `${context.serverUrl}/${context.repository}/actions/runs/${runId}`;
  if (run.conclusion !== "success") {
    await setDeploymentStatus(
      api,
      deployment.id,
      "failure",
      `Downstream run concluded ${run.conclusion ?? "without conclusion"}`,
      logUrl,
    );
    throw new Error(`${plan.id}: downstream run concluded ${run.conclusion}`);
  }
  await setDeploymentStatus(
    api,
    deployment.id,
    "success",
    `Exact effect completed for ${context.sourceSha.slice(0, 12)}`,
    logUrl,
  );
  return { ...deployment, payload, state: "success" };
}

async function getRefSha(api, branch) {
  const ref = await api.request(
    "GET",
    `/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return ref.object?.sha;
}

async function reconcilePromotion(api, promotion, context, effectDeployments) {
  for (const [effectId, deployment] of effectDeployments) {
    if (
      deployment.state !== "success" ||
      deployment.payload.sourceSha !== context.sourceSha
    ) {
      throw new Error(
        `${effectId}: missing exact-SHA success before promotion`,
      );
    }
  }
  return requestReviewedPromotion(api, {
    ...promotion,
    sourceSha: context.sourceSha,
    sourceRunUrl: `${context.serverUrl}/${context.repository}/actions/runs/${context.sourceRunId}`,
  });
}

export async function verifyIncomingEffectProofs(
  api,
  incoming,
  previousRegistry,
) {
  for (const effect of previousRegistry.effects) {
    const records = await listEffectDeployments(api, {
      ...effect,
      environment: `develop-effect/${effect.id}`,
    });
    const proof = records.find(
      (record) =>
        record.state === "success" &&
        record.payload.sourceSha === incoming.sourceSha &&
        record.payload.workflow === effect.workflow &&
        record.payload.ledgerVersion === previousRegistry.ledgerVersion,
    );
    if (!proof)
      throw new Error(
        `${effect.id}: promoted source lacks exact successful effect evidence`,
      );
    const sourceRun = await api.request(
      "GET",
      `/actions/runs/${proof.payload.sourceRunId}`,
    );
    validateSourceRun(
      sourceRun,
      incoming.sourceSha,
      proof.payload.sourceRunId,
      incoming.sourceBranch,
    );
  }
}

async function reconcileCommand(args) {
  const repoRoot = path.resolve(args.repo ?? DEFAULT_REPO_ROOT);
  const sourceSha = requireString(args, "source-sha");
  const sourceRunId = requireString(args, "source-run-id");
  const sourceBranch = requireString(args, "source-branch");
  if (
    !["develop", "staging", "main"].includes(sourceBranch) ||
    environment("GITHUB_REF_NAME") !== sourceBranch
  ) {
    throw new Error(
      "source branch must match the develop, staging, or main workflow ref",
    );
  }
  assertFullSha(sourceSha, "source SHA");
  if (environment("GITHUB_SHA") !== sourceSha) {
    throw new Error("reconcile workflow head SHA does not match source SHA");
  }
  const expected = readJson(path.resolve(requireString(args, "expected")));
  const observed = readJson(path.resolve(requireString(args, "observed")));
  if (expected.headSha !== sourceSha || observed.headSha !== sourceSha) {
    throw new Error("manifest source SHA mismatch");
  }
  const registry = validateRegistry(
    readJson(path.join(repoRoot, `.github/${sourceBranch}-effects.json`)),
  );
  if (
    (registry.sourceBranch ?? registry.promotion?.sourceBranch) !== sourceBranch
  )
    throw new Error("registry source branch mismatch");
  const plans = buildEffectPlans({ expected, observed, registry, repoRoot });
  const api = new GitHubApi({
    apiUrl: environment("GITHUB_API_URL") ?? "https://api.github.com",
    repository: environment("GITHUB_REPOSITORY"),
    token: environment("GITHUB_TOKEN"),
  });
  const sourceRun = await api.request("GET", `/actions/runs/${sourceRunId}`);
  validateSourceRun(sourceRun, sourceSha, sourceRunId, sourceBranch);
  const currentDevelop = await getRefSha(api, sourceBranch);
  if (currentDevelop !== sourceSha) {
    console.log(
      `[develop-effects] ${sourceSha} is no longer ${sourceBranch}; no effects accepted`,
    );
    return;
  }
  const context = {
    ledgerVersion: registry.ledgerVersion,
    reconcileRunId: environment("GITHUB_RUN_ID"),
    repository: environment("GITHUB_REPOSITORY"),
    serverUrl: environment("GITHUB_SERVER_URL") ?? "https://github.com",
    sourceRunId,
    sourceSha,
  };
  if (sourceBranch !== "develop") {
    const incoming = await verifyMergedPromotion(api, sourceBranch, sourceSha);
    const previousRegistry = validateRegistry(
      readJson(
        path.join(repoRoot, `.github/${incoming.sourceBranch}-effects.json`),
      ),
    );
    await verifyIncomingEffectProofs(api, incoming, previousRegistry);
  }
  const completed = new Map();
  for (const plan of plans.plans) {
    const stillCurrent = await getRefSha(api, sourceBranch);
    if (stillCurrent !== sourceSha) {
      console.log(
        `[develop-effects] ${sourceBranch} advanced before ${plan.id}; stopping reconciliation`,
      );
      return;
    }
    completed.set(plan.id, await reconcileEffect(api, plan, context));
  }
  const promotion = plans.promotion
    ? await reconcilePromotion(api, plans.promotion, context, completed)
    : { action: "complete" };
  console.log(
    `[develop-effects] reconciled ${completed.size} effects; promotion=${promotion.action}`,
  );
}

async function awaitSourceCommand(args) {
  const sourceSha = requireString(args, "source-sha");
  const sourceRunId = requireString(args, "source-run-id");
  const sourceBranch = requireString(args, "source-branch");
  if (
    !["develop", "staging", "main"].includes(sourceBranch) ||
    environment("GITHUB_REF_NAME") !== sourceBranch
  ) {
    throw new Error(
      "source branch must match the develop, staging, or main workflow ref",
    );
  }
  const api = new GitHubApi({
    apiUrl: environment("GITHUB_API_URL") ?? "https://api.github.com",
    repository: environment("GITHUB_REPOSITORY"),
    token: environment("GITHUB_TOKEN"),
  });
  await waitForSource(api, sourceSha, sourceRunId, sourceBranch);
  console.log(
    `[develop-effects] Develop Full run ${sourceRunId} is green at ${sourceSha}`,
  );
}

function dryRunCommand(args) {
  const repoRoot = path.resolve(args.repo ?? DEFAULT_REPO_ROOT);
  const sourceSha = requireString(args, "source-sha");
  const expected = readJson(path.resolve(requireString(args, "expected")));
  const observed = readJson(path.resolve(requireString(args, "observed")));
  const registry = validateRegistry(
    readJson(path.join(repoRoot, args.registry ?? DEFAULT_REGISTRY)),
  );
  const plans = buildEffectPlans({ expected, observed, registry, repoRoot });
  const result = simulateReconciliation({
    plans,
    sourceSha,
    state: readJson(path.resolve(requireString(args, "state"))),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "await-source") await awaitSourceCommand(args);
  else if (command === "reconcile") await reconcileCommand(args);
  else if (command === "dry-run") dryRunCommand(args);
  else {
    throw new Error(
      "usage: develop-effect-ledger.mjs <await-source|reconcile|dry-run> [options]",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[develop-effects] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
