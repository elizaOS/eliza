#!/usr/bin/env bun
/**
 * Runs the production exact-agent image canary through its super-admin HTTP
 * boundary. The fixed target, fixed origin, immutable image references, and
 * strict response correlation keep a manual operator run fail-closed.
 *
 * Evidence is an allowlisted projection of the run: image digests, job IDs,
 * phase verdicts, and timings only. API response bodies, agent/org/user IDs,
 * infrastructure locations, and credentials never enter the artifact.
 */

import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

type JsonObject = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;

export const AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN = "https://api.eliza.app";
export const AGENT_IMAGE_CANARY_FIXED_AGENT_ID =
  "4602b3be-2c01-4e7e-9cdc-849604e1bef7";
export const AGENT_IMAGE_CANARY_DEMO_REPOSITORY = "ghcr.io/elizaos/eliza-demo";
export const AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY = "ghcr.io/elizaos/eliza";

const INVENTORY_PATH =
  "/api/v1/admin/docker-containers?status=running&limit=500";
const CANARY_PATH = "/api/v1/admin/agent-image-canary";
const GHCR_TOKEN_URL =
  "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aelizaos%2Feliza-demo%3Apull";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_EVIDENCE_TIMING_MS = 30 * 60_000;
const REQUEST_ID_NAMESPACE = "77fe2fc4-f2f6-5b7a-a71e-a1a843d9cc8f";
export const AGENT_IMAGE_CANARY_RECOVERY_ACTION = "resume_actor_bound_request";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const CANONICAL_IMAGE_RE =
  /^ghcr\.io\/elizaos\/eliza(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})?$/;
const EXACT_DEMO_IMAGE_RE =
  /^ghcr\.io\/elizaos\/eliza-demo@sha256:[0-9a-f]{64}$/;

const TIMING_PHASES = [
  "health",
  "inventory",
  "publicImage",
  "dryRun",
  "execute",
  "poll",
  "rollbackDryRun",
  "recovery",
  "total",
] as const;
type TimingPhase = (typeof TIMING_PHASES)[number];

const FAILURE_PHASES = [
  "config",
  "health",
  "inventory",
  "public_image",
  "dry_run",
  "execute",
  "poll",
  "recovery",
  "rollback_dry_run",
  "internal",
] as const;
type FailurePhase = (typeof FAILURE_PHASES)[number];

const FAILURE_CODES = [
  "missing_cloud_credential",
  "non_production_target_refused",
  "missing_trusted_deploy_commit",
  "deployed_commit_changed",
  "invalid_request_id",
  "invalid_mode_contract",
  "invalid_target_digest",
  "invalid_source_job_id",
  "request_failed",
  "auth_denied",
  "invalid_response_shape",
  "wrong_environment",
  "missing_deploy_commit",
  "target_not_found",
  "duplicate_target",
  "target_not_running",
  "missing_source_pair",
  "invalid_source_image",
  "image_not_public",
  "source_pair_mismatch",
  "dry_run_mismatch",
  "execute_mismatch",
  "execute_outcome_unknown",
  "recovery_not_found",
  "job_failed",
  "job_nonterminal",
  "poll_timeout",
  "rollback_pair_mismatch",
  "unexpected_error",
] as const;
type FailureCode = (typeof FAILURE_CODES)[number];

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled"]);
const KNOWN_JOB_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

export type AgentImageCanaryMode = "upgrade" | "rollback";
type SafeRepository =
  | typeof AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY
  | typeof AGENT_IMAGE_CANARY_DEMO_REPOSITORY;
type SafeTerminalStatus = "completed" | "failed" | "cancelled" | "canceled";

export interface AgentImageCanaryEvidence {
  schemaVersion: 1;
  verdict: "pending" | "pass" | "fail" | "nonterminal";
  mode: AgentImageCanaryMode | null;
  deployedCommit: string | null;
  image: {
    sourceRepository: SafeRepository | null;
    sourceDigest: string | null;
    targetRepository: SafeRepository | null;
    targetDigest: string | null;
    publicTargetVerified: boolean;
  };
  execution: {
    requestId: string | null;
    planFingerprint: string | null;
    recoveryOnly: boolean;
    inventoryMatched: boolean;
    dryRunPassed: boolean;
    executeAccepted: boolean;
    recovered: boolean;
    recoveryRequired: boolean;
    recoveryAction: typeof AGENT_IMAGE_CANARY_RECOVERY_ACTION | null;
    sourceJobId: string | null;
    jobId: string | null;
    terminalStatus: SafeTerminalStatus | null;
    pollCount: number;
    rollbackDryRunPassed: boolean;
  };
  timingsMs: Partial<Record<TimingPhase, number>>;
  failure: {
    phase: FailurePhase;
    code: FailureCode;
  } | null;
}

export interface AgentImageCanaryOptions {
  apiKey: string;
  mode: string;
  requestId: string;
  expectedDeployCommit?: string;
  targetDigest?: string;
  sourceJobId?: string;
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  recoverExistingRequest?: boolean;
  recoveryOnly?: boolean;
  checkpoint?: (evidence: AgentImageCanaryEvidence) => Promise<void>;
}

interface InventoryTarget {
  organizationId: string;
  dockerImage: string;
  imageDigest: string;
}

interface PlannedTarget {
  operation: AgentImageCanaryMode;
  agentId: string;
  organizationId: string;
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
  sourceRolloutId: string | null;
  sourceJobId: string | null;
  jobId: string | null;
  status: string | null;
}

interface RolloutResponse {
  operation: AgentImageCanaryMode;
  dryRun: boolean;
  requestId: string;
  planFingerprint: string;
  rolloutId: string | null;
  decisionAt: string;
  target: PlannedTarget;
  pollEndpoint: string | null;
}

interface PollExpectation {
  operation: AgentImageCanaryMode;
  rolloutId: string;
  jobId: string;
  target: PlannedTarget;
}

class CanaryFailure extends Error {
  constructor(
    readonly phase: FailurePhase,
    readonly code: FailureCode,
  ) {
    super(`${phase}:${code}`);
    this.name = "CanaryFailure";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function deriveAgentImageCanaryRequestId(
  repositoryId: string,
  runId: string,
): string {
  if (
    !/^[1-9][0-9]{0,31}$/.test(repositoryId) ||
    !/^[1-9][0-9]{0,31}$/.test(runId)
  ) {
    throw new Error("invalid_github_run_identity");
  }
  return uuidV5(REQUEST_ID_NAMESPACE, `${repositoryId}:${runId}`);
}

function deriveRollbackPreviewRequestId(requestId: string): string {
  return uuidV5(REQUEST_ID_NAMESPACE, `${requestId}:rollback-preview`);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_RE.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function repositoryOf(image: string): SafeRepository | null {
  if (CANONICAL_IMAGE_RE.test(image)) {
    return AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY;
  }
  if (EXACT_DEMO_IMAGE_RE.test(image)) {
    return AGENT_IMAGE_CANARY_DEMO_REPOSITORY;
  }
  return null;
}

function isExactProductionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN &&
      !url.username &&
      !url.password &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  } catch {
    // error-policy:J3 Invalid operator input is rejected as configuration.
    return false;
  }
}

function fail(phase: FailurePhase, code: FailureCode): never {
  throw new CanaryFailure(phase, code);
}

function newEvidence(): AgentImageCanaryEvidence {
  return {
    schemaVersion: 1,
    verdict: "pending",
    mode: null,
    deployedCommit: null,
    image: {
      sourceRepository: null,
      sourceDigest: null,
      targetRepository: null,
      targetDigest: null,
      publicTargetVerified: false,
    },
    execution: {
      requestId: null,
      planFingerprint: null,
      recoveryOnly: false,
      inventoryMatched: false,
      dryRunPassed: false,
      executeAccepted: false,
      recovered: false,
      recoveryRequired: false,
      recoveryAction: null,
      sourceJobId: null,
      jobId: null,
      terminalStatus: null,
      pollCount: 0,
      rollbackDryRunPassed: false,
    },
    timingsMs: {},
    failure: null,
  };
}

async function measured<T>(
  evidence: AgentImageCanaryEvidence,
  phase: TimingPhase,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = now();
  try {
    return await operation();
  } finally {
    evidence.timingsMs[phase] = Math.max(0, Math.round(now() - startedAt));
  }
}

async function checkpointEvidence(
  checkpoint: AgentImageCanaryOptions["checkpoint"],
  evidence: AgentImageCanaryEvidence,
): Promise<void> {
  if (checkpoint) await checkpoint(evidence);
}

async function request(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  phase: FailurePhase,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // error-policy:J1 The live-client transport boundary emits a typed failure.
    fail(phase, "request_failed");
  }
}

async function jsonObject(
  response: Response,
  expectedStatus: number,
  phase: FailurePhase,
): Promise<JsonObject> {
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    fail(phase, "auth_denied");
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    fail(phase, "request_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // error-policy:J3 Malformed remote JSON is an explicit invalid response.
    fail(phase, "invalid_response_shape");
  }
  if (!isRecord(body)) {
    fail(phase, "invalid_response_shape");
  }
  return body;
}

function apiHeaders(apiKey: string, withBody = false): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "X-API-Key": apiKey,
  });
  if (withBody) headers.set("Content-Type", "application/json");
  return headers;
}

async function readHealth(
  fetchImpl: Fetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const response = await request(
    fetchImpl,
    `${baseUrl}/api/health`,
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs,
    "health",
  );
  const body = await jsonObject(response, 200, "health");
  if (body.status !== "ok" || body.environment !== "production") {
    fail("health", "wrong_environment");
  }
  if (typeof body.commit !== "string" || !COMMIT_RE.test(body.commit)) {
    fail("health", "missing_deploy_commit");
  }
  return body.commit;
}

export async function readAgentImageCanaryDeploymentCommit(
  options: Pick<
    AgentImageCanaryOptions,
    "baseUrl" | "fetch" | "requestTimeoutMs"
  > = {},
): Promise<string> {
  const baseUrl = options.baseUrl ?? AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  if (
    !isExactProductionOrigin(baseUrl) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    fail("config", "non_production_target_refused");
  }
  return readHealth(options.fetch ?? globalThis.fetch, baseUrl, timeoutMs);
}

async function readInventoryTarget(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<InventoryTarget> {
  const response = await request(
    fetchImpl,
    `${baseUrl}${INVENTORY_PATH}`,
    { method: "GET", headers: apiHeaders(apiKey) },
    timeoutMs,
    "inventory",
  );
  const body = await jsonObject(response, 200, "inventory");
  const data = isRecord(body.data) ? body.data : null;
  if (body.success !== true || !data || !Array.isArray(data.containers)) {
    fail("inventory", "invalid_response_shape");
  }

  const matches = data.containers.filter(
    (item) => isRecord(item) && item.id === AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
  );
  if (matches.length === 0) fail("inventory", "target_not_found");
  if (matches.length !== 1) fail("inventory", "duplicate_target");

  const target = matches[0];
  if (!isRecord(target)) fail("inventory", "invalid_response_shape");
  if (target.status !== "running") fail("inventory", "target_not_running");
  if (!isUuid(target.organizationId)) {
    fail("inventory", "invalid_response_shape");
  }
  if (typeof target.dockerImage !== "string" || !isDigest(target.imageDigest)) {
    fail("inventory", "missing_source_pair");
  }
  if (!repositoryOf(target.dockerImage)) {
    fail("inventory", "invalid_source_image");
  }
  return {
    organizationId: target.organizationId,
    dockerImage: target.dockerImage,
    imageDigest: target.imageDigest,
  };
}

async function verifyPublicDemoImage(
  fetchImpl: Fetch,
  digest: string,
  timeoutMs: number,
): Promise<void> {
  const tokenResponse = await request(
    fetchImpl,
    GHCR_TOKEN_URL,
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs,
    "public_image",
  );
  if (tokenResponse.status !== 200) {
    await tokenResponse.body?.cancel();
    fail("public_image", "image_not_public");
  }
  let tokenBody: unknown;
  try {
    tokenBody = await tokenResponse.json();
  } catch {
    // error-policy:J3 Malformed registry JSON proves no public image.
    fail("public_image", "image_not_public");
  }
  const token =
    isRecord(tokenBody) && typeof tokenBody.token === "string"
      ? tokenBody.token
      : null;
  if (!token || token.length > 16_384) {
    fail("public_image", "image_not_public");
  }

  const manifestResponse = await request(
    fetchImpl,
    `https://ghcr.io/v2/elizaos/eliza-demo/manifests/${digest}`,
    {
      method: "GET",
      headers: {
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        Authorization: `Bearer ${token}`,
      },
    },
    timeoutMs,
    "public_image",
  );
  const observedDigest = manifestResponse.headers
    .get("docker-content-digest")
    ?.trim();
  await manifestResponse.body?.cancel();
  if (manifestResponse.status !== 200 || observedDigest !== digest) {
    fail("public_image", "image_not_public");
  }
}

function parsePlannedTarget(
  value: unknown,
  phase: FailurePhase,
): PlannedTarget {
  if (!isRecord(value)) fail(phase, "invalid_response_shape");
  if (
    (value.operation !== "upgrade" && value.operation !== "rollback") ||
    !isUuid(value.agentId) ||
    !isUuid(value.organizationId) ||
    !isUuid(value.targetOwnerUserId) ||
    typeof value.sourceImage !== "string" ||
    !isDigest(value.sourceDigest) ||
    typeof value.targetImage !== "string" ||
    !isDigest(value.targetDigest)
  ) {
    fail(phase, "invalid_response_shape");
  }
  const sourceRolloutId =
    value.sourceRolloutId === undefined ? null : value.sourceRolloutId;
  const sourceJobId =
    value.sourceJobId === undefined ? null : value.sourceJobId;
  const jobId = value.jobId === undefined ? null : value.jobId;
  const status = value.status === undefined ? null : value.status;
  if (
    (sourceRolloutId !== null && !isUuid(sourceRolloutId)) ||
    (sourceJobId !== null && !isUuid(sourceJobId)) ||
    (jobId !== null && !isUuid(jobId)) ||
    (status !== null && typeof status !== "string")
  ) {
    fail(phase, "invalid_response_shape");
  }
  return {
    operation: value.operation,
    agentId: value.agentId,
    organizationId: value.organizationId,
    targetOwnerUserId: value.targetOwnerUserId,
    sourceImage: value.sourceImage,
    sourceDigest: value.sourceDigest,
    targetImage: value.targetImage,
    targetDigest: value.targetDigest,
    sourceRolloutId,
    sourceJobId,
    jobId,
    status,
  };
}

function parseRolloutResponse(
  body: JsonObject,
  operation: AgentImageCanaryMode,
  dryRun: boolean,
  phase: FailurePhase,
  requestId: string,
  expectedPlanFingerprint?: string,
): RolloutResponse {
  const data = isRecord(body.data) ? body.data : null;
  if (
    body.success !== true ||
    !data ||
    data.operation !== operation ||
    data.dryRun !== dryRun ||
    data.requestId !== requestId ||
    !isDigest(data.planFingerprint) ||
    (expectedPlanFingerprint !== undefined &&
      data.planFingerprint !== expectedPlanFingerprint) ||
    !isIsoTimestamp(data.decisionAt) ||
    !Array.isArray(data.targets) ||
    data.targets.length !== 1
  ) {
    fail(phase, "invalid_response_shape");
  }
  const rolloutId = data.rolloutId;
  if ((dryRun && rolloutId !== null) || (!dryRun && !isUuid(rolloutId))) {
    fail(phase, "invalid_response_shape");
  }
  const target = parsePlannedTarget(data.targets[0], phase);

  if (dryRun) {
    if (
      body.polling !== undefined ||
      body.recovery !== undefined ||
      target.jobId ||
      target.status
    ) {
      fail(phase, "invalid_response_shape");
    }
    return {
      operation,
      dryRun,
      requestId,
      planFingerprint: data.planFingerprint,
      rolloutId: null,
      decisionAt: data.decisionAt,
      target,
      pollEndpoint: null,
    };
  }

  if (
    !target.jobId ||
    !target.status ||
    !KNOWN_JOB_STATUSES.has(target.status) ||
    !Array.isArray(body.polling) ||
    body.polling.length !== 1 ||
    !isRecord(body.polling[0]) ||
    !isRecord(body.recovery)
  ) {
    fail(phase, "invalid_response_shape");
  }
  if (!isUuid(rolloutId)) {
    fail(phase, "invalid_response_shape");
  }
  const polling = body.polling[0];
  const expectedEndpoint = `${CANARY_PATH}/jobs/${target.jobId}`;
  if (
    polling.agentId !== AGENT_IMAGE_CANARY_FIXED_AGENT_ID ||
    polling.jobId !== target.jobId ||
    polling.endpoint !== expectedEndpoint ||
    polling.intervalMs !== POLL_INTERVAL_MS ||
    body.recovery.endpoint !== `${CANARY_PATH}/requests/${requestId}` ||
    typeof polling.expectedDurationMs !== "number" ||
    !Number.isFinite(polling.expectedDurationMs) ||
    polling.expectedDurationMs <= 0
  ) {
    fail(phase, "invalid_response_shape");
  }
  return {
    operation,
    dryRun,
    requestId,
    planFingerprint: data.planFingerprint,
    rolloutId,
    decisionAt: data.decisionAt,
    target,
    pollEndpoint: expectedEndpoint,
  };
}

function parseRecoveryResponse(
  body: JsonObject,
  requestId: string,
  phase: FailurePhase,
): RolloutResponse {
  const data = isRecord(body.data) ? body.data : null;
  if (
    body.success !== true ||
    !data ||
    data.dryRun !== false ||
    (data.operation !== "upgrade" && data.operation !== "rollback") ||
    data.requestId !== requestId ||
    !isDigest(data.planFingerprint) ||
    !isUuid(data.rolloutId) ||
    !isIsoTimestamp(data.decisionAt) ||
    !Array.isArray(data.targets) ||
    data.targets.length !== 1 ||
    !Array.isArray(body.polling) ||
    body.polling.length !== 1 ||
    !isRecord(body.polling[0])
  ) {
    fail(phase, "invalid_response_shape");
  }
  const target = parsePlannedTarget(data.targets[0], phase);
  const polling = body.polling[0];
  if (
    !target.jobId ||
    !target.status ||
    !KNOWN_JOB_STATUSES.has(target.status) ||
    polling.agentId !== target.agentId ||
    polling.jobId !== target.jobId ||
    polling.endpoint !== `${CANARY_PATH}/jobs/${target.jobId}` ||
    polling.intervalMs !== POLL_INTERVAL_MS ||
    typeof polling.shouldContinue !== "boolean" ||
    polling.shouldContinue !==
      (target.status === "pending" || target.status === "in_progress")
  ) {
    fail(phase, "invalid_response_shape");
  }
  return {
    operation: data.operation,
    dryRun: false,
    requestId,
    planFingerprint: data.planFingerprint,
    rolloutId: data.rolloutId,
    decisionAt: data.decisionAt,
    target,
    pollEndpoint: polling.endpoint,
  };
}

function samePlannedPair(left: PlannedTarget, right: PlannedTarget): boolean {
  return (
    left.operation === right.operation &&
    left.agentId === right.agentId &&
    left.organizationId === right.organizationId &&
    left.targetOwnerUserId === right.targetOwnerUserId &&
    left.sourceImage === right.sourceImage &&
    left.sourceDigest === right.sourceDigest &&
    left.targetImage === right.targetImage &&
    left.targetDigest === right.targetDigest &&
    left.sourceRolloutId === right.sourceRolloutId &&
    left.sourceJobId === right.sourceJobId
  );
}

function validateUpgradePlan(
  target: PlannedTarget,
  inventory: InventoryTarget,
  targetDigest: string,
  phase: "dry_run" | "execute",
): void {
  const expectedTargetImage = `${AGENT_IMAGE_CANARY_DEMO_REPOSITORY}@${targetDigest}`;
  if (
    target.operation !== "upgrade" ||
    target.agentId !== AGENT_IMAGE_CANARY_FIXED_AGENT_ID ||
    target.organizationId !== inventory.organizationId ||
    target.sourceImage !== inventory.dockerImage ||
    target.sourceDigest !== inventory.imageDigest ||
    target.targetImage !== expectedTargetImage ||
    target.targetDigest !== targetDigest ||
    target.sourceRolloutId !== null ||
    target.sourceJobId !== null
  ) {
    fail(phase, phase === "dry_run" ? "dry_run_mismatch" : "execute_mismatch");
  }
}

function validateRollbackPlan(
  target: PlannedTarget,
  inventory: InventoryTarget,
  sourceJobId: string,
  phase: "dry_run" | "execute" | "rollback_dry_run",
): void {
  if (
    target.operation !== "rollback" ||
    target.agentId !== AGENT_IMAGE_CANARY_FIXED_AGENT_ID ||
    target.organizationId !== inventory.organizationId ||
    target.sourceImage !== inventory.dockerImage ||
    target.sourceDigest !== inventory.imageDigest ||
    target.sourceJobId !== sourceJobId ||
    !target.sourceRolloutId ||
    repositoryOf(target.sourceImage) !== AGENT_IMAGE_CANARY_DEMO_REPOSITORY ||
    target.sourceImage !==
      `${AGENT_IMAGE_CANARY_DEMO_REPOSITORY}@${target.sourceDigest}` ||
    repositoryOf(target.targetImage) !== AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY
  ) {
    fail(
      phase,
      phase === "rollback_dry_run"
        ? "rollback_pair_mismatch"
        : phase === "dry_run"
          ? "dry_run_mismatch"
          : "execute_mismatch",
    );
  }
}

function validateRecoveredIntent(
  response: RolloutResponse,
  mode: AgentImageCanaryMode,
  targetDigest: string | null,
  sourceJobId: string | null,
): void {
  if (response.operation !== mode || response.dryRun) {
    fail("recovery", "execute_mismatch");
  }
  const target = response.target;
  const recoveredInventory: InventoryTarget = {
    organizationId: target.organizationId,
    dockerImage: target.sourceImage,
    imageDigest: target.sourceDigest,
  };
  if (mode === "upgrade") {
    if (
      !targetDigest ||
      repositoryOf(target.sourceImage) !==
        AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY
    ) {
      fail("recovery", "execute_mismatch");
    }
    validateUpgradePlan(target, recoveredInventory, targetDigest, "execute");
    return;
  }
  if (!sourceJobId) fail("recovery", "execute_mismatch");
  validateRollbackPlan(target, recoveredInventory, sourceJobId, "execute");
}

async function postRollout(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  requestBody: JsonObject,
  operation: AgentImageCanaryMode,
  dryRun: boolean,
  timeoutMs: number,
  phase: "dry_run" | "execute" | "rollback_dry_run",
  requestId: string,
  expectedPlanFingerprint?: string,
): Promise<RolloutResponse> {
  const response = await request(
    fetchImpl,
    `${baseUrl}${CANARY_PATH}`,
    {
      method: "POST",
      headers: apiHeaders(apiKey, true),
      body: JSON.stringify(requestBody),
    },
    timeoutMs,
    phase,
  );
  const body = await jsonObject(response, dryRun ? 200 : 202, phase);
  return parseRolloutResponse(
    body,
    operation,
    dryRun,
    phase,
    requestId,
    expectedPlanFingerprint,
  );
}

async function readRecoveredRequest(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  requestId: string,
  timeoutMs: number,
  phase: "execute" | "recovery",
): Promise<RolloutResponse | null> {
  const response = await request(
    fetchImpl,
    `${baseUrl}${CANARY_PATH}/requests/${requestId}`,
    { method: "GET", headers: apiHeaders(apiKey) },
    timeoutMs,
    phase,
  );
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    fail(phase, "auth_denied");
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  const body = await jsonObject(response, 200, phase);
  return parseRecoveryResponse(body, requestId, phase);
}

async function tryExecutePost(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  requestBody: JsonObject,
  operation: AgentImageCanaryMode,
  requestId: string,
  expectedPlanFingerprint: string,
  timeoutMs: number,
): Promise<RolloutResponse | null> {
  let response: Response;
  try {
    response = await request(
      fetchImpl,
      `${baseUrl}${CANARY_PATH}`,
      {
        method: "POST",
        headers: apiHeaders(apiKey, true),
        body: JSON.stringify(requestBody),
      },
      timeoutMs,
      "execute",
    );
  } catch (error) {
    // error-policy:J4 An ambiguous execute transport outcome is recovered by requestId.
    if (
      error instanceof CanaryFailure &&
      error.phase === "execute" &&
      error.code === "request_failed"
    ) {
      return null;
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    fail("execute", "auth_denied");
  }
  if (response.status >= 500) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 202) {
    await response.body?.cancel();
    fail("execute", "request_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // error-policy:J3 Malformed accepted JSON is an ambiguous outcome, not a retry signal.
    return null;
  }
  if (!isRecord(body)) return null;
  try {
    return parseRolloutResponse(
      body,
      operation,
      false,
      "execute",
      requestId,
      expectedPlanFingerprint,
    );
  } catch (error) {
    // error-policy:J4 A malformed accepted envelope degrades to actor-bound recovery.
    if (!(error instanceof CanaryFailure)) throw error;
    return null;
  }
}

function rememberAcceptedCandidate(
  evidence: AgentImageCanaryEvidence,
  response: RolloutResponse,
): void {
  evidence.execution.executeAccepted = true;
  evidence.execution.jobId = response.target.jobId;
  evidence.execution.planFingerprint = response.planFingerprint;
}

async function executeWithRecovery(params: {
  fetchImpl: Fetch;
  baseUrl: string;
  apiKey: string;
  requestBody: JsonObject;
  operation: AgentImageCanaryMode;
  requestId: string;
  expectedPlanFingerprint: string;
  timeoutMs: number;
  evidence: AgentImageCanaryEvidence;
  validate: (response: RolloutResponse) => void;
}): Promise<{ response: RolloutResponse; recovered: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const direct = await tryExecutePost(
      params.fetchImpl,
      params.baseUrl,
      params.apiKey,
      params.requestBody,
      params.operation,
      params.requestId,
      params.expectedPlanFingerprint,
      params.timeoutMs,
    );
    if (direct) {
      try {
        params.validate(direct);
        return { response: direct, recovered: false };
      } catch (error) {
        // error-policy:J4 An inconsistent accepted envelope is resolved from durable state.
        if (!(error instanceof CanaryFailure)) throw error;
      }
    }

    let recovered: RolloutResponse | null;
    try {
      recovered = await readRecoveredRequest(
        params.fetchImpl,
        params.baseUrl,
        params.apiKey,
        params.requestId,
        params.timeoutMs,
        "execute",
      );
    } catch (error) {
      // error-policy:J4 Recovery transport failure leaves an explicit nonterminal handle.
      if (error instanceof CanaryFailure) {
        params.evidence.execution.recoveryRequired = true;
        params.evidence.execution.recoveryAction =
          AGENT_IMAGE_CANARY_RECOVERY_ACTION;
        if (error.code === "auth_denied") throw error;
        fail("execute", "execute_outcome_unknown");
      }
      throw error;
    }
    if (recovered) {
      rememberAcceptedCandidate(params.evidence, recovered);
      if (recovered.planFingerprint !== params.expectedPlanFingerprint) {
        params.evidence.execution.recoveryRequired = true;
        params.evidence.execution.recoveryAction =
          AGENT_IMAGE_CANARY_RECOVERY_ACTION;
        fail("execute", "execute_mismatch");
      }
      try {
        params.validate(recovered);
      } catch (error) {
        // error-policy:J4 Durable but inconsistent recovery remains nonterminal for operators.
        if (!(error instanceof CanaryFailure)) throw error;
        params.evidence.execution.recoveryRequired = true;
        params.evidence.execution.recoveryAction =
          AGENT_IMAGE_CANARY_RECOVERY_ACTION;
        fail("execute", "execute_mismatch");
      }
      return { response: recovered, recovered: true };
    }
  }
  params.evidence.execution.recoveryRequired = true;
  params.evidence.execution.recoveryAction = AGENT_IMAGE_CANARY_RECOVERY_ACTION;
  fail("execute", "execute_outcome_unknown");
}

function validateCompletedResult(
  data: JsonObject,
  expectation: PollExpectation,
): void {
  if (
    data.status !== "completed" ||
    data.error !== null ||
    !isRecord(data.result)
  ) {
    fail("poll", "job_nonterminal");
  }
  const result = data.result;
  if (
    result.success !== true ||
    result.cleanupPending === true ||
    result.jobId !== expectation.jobId ||
    result.operation !== expectation.operation ||
    result.rolloutId !== expectation.rolloutId ||
    !isUuid(result.actorUserId) ||
    !isUuid(result.targetOwnerUserId) ||
    result.agentId !== expectation.target.agentId ||
    result.organizationId !== expectation.target.organizationId ||
    result.sourceImage !== expectation.target.sourceImage ||
    result.sourceDigest !== expectation.target.sourceDigest ||
    result.targetImage !== expectation.target.targetImage ||
    result.targetDigest !== expectation.target.targetDigest ||
    !isIsoTimestamp(result.decisionAt) ||
    !isIsoTimestamp(result.startedAt) ||
    !isIsoTimestamp(result.finishedAt)
  ) {
    fail("poll", "source_pair_mismatch");
  }
}

async function pollJob(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  expectation: PollExpectation,
  evidence: AgentImageCanaryEvidence,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  requestTimeoutMs: number,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<void> {
  const startedAt = now();
  const maxPolls = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs) + 1);
  for (let index = 0; index < maxPolls; index += 1) {
    const response = await request(
      fetchImpl,
      `${baseUrl}${CANARY_PATH}/jobs/${expectation.jobId}`,
      { method: "GET", headers: apiHeaders(apiKey) },
      requestTimeoutMs,
      "poll",
    );
    const body = await jsonObject(response, 200, "poll");
    const data = isRecord(body.data) ? body.data : null;
    const polling = isRecord(body.polling) ? body.polling : null;
    evidence.execution.pollCount += 1;
    if (
      body.success !== true ||
      !data ||
      !polling ||
      data.id !== expectation.jobId ||
      data.type !== "agent_admin_canary_image" ||
      typeof data.status !== "string"
    ) {
      fail("poll", "invalid_response_shape");
    }

    if (data.status === "pending" || data.status === "in_progress") {
      if (polling.shouldContinue !== true) {
        fail("poll", "job_nonterminal");
      }
      if (now() - startedAt >= pollTimeoutMs || index + 1 >= maxPolls) {
        fail("poll", "poll_timeout");
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (TERMINAL_FAILURE_STATUSES.has(data.status)) {
      evidence.execution.terminalStatus = data.status as SafeTerminalStatus;
      if (polling.shouldContinue !== false) {
        fail("poll", "job_nonterminal");
      }
      fail("poll", "job_failed");
    }
    if (data.status !== "completed" || polling.shouldContinue !== false) {
      fail("poll", "job_nonterminal");
    }
    evidence.execution.terminalStatus = "completed";
    validateCompletedResult(data, expectation);
    return;
  }
  fail("poll", "poll_timeout");
}

function parseConfiguration(
  options: AgentImageCanaryOptions,
  evidence: AgentImageCanaryEvidence,
): {
  apiKey: string;
  mode: AgentImageCanaryMode;
  targetDigest: string | null;
  sourceJobId: string | null;
  baseUrl: string;
  expectedDeployCommit: string;
  requestId: string;
} {
  if (
    !options.apiKey ||
    options.apiKey.trim() !== options.apiKey ||
    options.apiKey.length > 16_384
  ) {
    fail("config", "missing_cloud_credential");
  }
  const baseUrl = options.baseUrl ?? AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN;
  if (!isExactProductionOrigin(baseUrl)) {
    fail("config", "non_production_target_refused");
  }
  if (
    !options.expectedDeployCommit ||
    !COMMIT_RE.test(options.expectedDeployCommit)
  ) {
    fail("config", "missing_trusted_deploy_commit");
  }
  if (!isUuid(options.requestId)) {
    fail("config", "invalid_request_id");
  }
  if (options.mode !== "upgrade" && options.mode !== "rollback") {
    fail("config", "invalid_mode_contract");
  }
  evidence.mode = options.mode;
  evidence.execution.requestId = options.requestId;
  evidence.execution.recoveryOnly = options.recoveryOnly === true;

  const targetDigest = options.targetDigest?.trim() || null;
  const sourceJobId = options.sourceJobId?.trim() || null;
  if (options.mode === "upgrade") {
    if (!targetDigest || !DIGEST_RE.test(targetDigest)) {
      fail("config", "invalid_target_digest");
    }
    if (sourceJobId) fail("config", "invalid_mode_contract");
    evidence.image.targetRepository = AGENT_IMAGE_CANARY_DEMO_REPOSITORY;
    evidence.image.targetDigest = targetDigest;
  } else {
    if (!sourceJobId || !UUID_RE.test(sourceJobId)) {
      fail("config", "invalid_source_job_id");
    }
    if (targetDigest) fail("config", "invalid_mode_contract");
    evidence.execution.sourceJobId = sourceJobId;
  }
  return {
    apiKey: options.apiKey,
    mode: options.mode,
    targetDigest,
    sourceJobId,
    baseUrl,
    expectedDeployCommit: options.expectedDeployCommit,
    requestId: options.requestId,
  };
}

function pollExpectation(response: RolloutResponse): PollExpectation {
  if (!response.rolloutId || !response.target.jobId || !response.pollEndpoint) {
    fail("execute", "execute_mismatch");
  }
  return {
    operation: response.operation,
    rolloutId: response.rolloutId,
    jobId: response.target.jobId,
    target: response.target,
  };
}

async function previewExactRollback(params: {
  fetchImpl: Fetch;
  baseUrl: string;
  apiKey: string;
  requestId: string;
  executed: RolloutResponse;
  timeoutMs: number;
}): Promise<void> {
  const expectation = pollExpectation(params.executed);
  const previewRequestId = deriveRollbackPreviewRequestId(params.requestId);
  const rollbackPreview = await postRollout(
    params.fetchImpl,
    params.baseUrl,
    params.apiKey,
    {
      operation: "rollback",
      requestId: previewRequestId,
      dryRun: true,
      source: { jobId: expectation.jobId },
    },
    "rollback",
    true,
    params.timeoutMs,
    "rollback_dry_run",
    previewRequestId,
  );
  const canaryInventory: InventoryTarget = {
    organizationId: params.executed.target.organizationId,
    dockerImage: params.executed.target.targetImage,
    imageDigest: params.executed.target.targetDigest,
  };
  validateRollbackPlan(
    rollbackPreview.target,
    canaryInventory,
    expectation.jobId,
    "rollback_dry_run",
  );
  if (
    rollbackPreview.target.targetImage !== params.executed.target.sourceImage ||
    rollbackPreview.target.targetDigest !==
      params.executed.target.sourceDigest ||
    rollbackPreview.target.sourceRolloutId !== expectation.rolloutId
  ) {
    fail("rollback_dry_run", "rollback_pair_mismatch");
  }
}

export async function runAgentImageCanary(
  options: AgentImageCanaryOptions,
): Promise<AgentImageCanaryEvidence> {
  const evidence = newEvidence();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const totalStartedAt = now();

  try {
    if (
      !Number.isFinite(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      !Number.isFinite(pollIntervalMs) ||
      pollIntervalMs <= 0 ||
      !Number.isFinite(pollTimeoutMs) ||
      pollTimeoutMs < pollIntervalMs
    ) {
      fail("config", "invalid_mode_contract");
    }
    const config = parseConfiguration(options, evidence);
    evidence.deployedCommit = await measured(evidence, "health", now, () =>
      readHealth(fetchImpl, config.baseUrl, requestTimeoutMs),
    );
    if (evidence.deployedCommit !== config.expectedDeployCommit) {
      fail("health", "deployed_commit_changed");
    }
    let recovered: RolloutResponse | null = null;
    if (options.recoverExistingRequest || options.recoveryOnly) {
      try {
        recovered = await measured(evidence, "recovery", now, () =>
          readRecoveredRequest(
            fetchImpl,
            config.baseUrl,
            config.apiKey,
            config.requestId,
            requestTimeoutMs,
            "recovery",
          ),
        );
      } catch (error) {
        // error-policy:J4 A rerun that cannot prove request absence remains nonterminal.
        evidence.execution.recoveryRequired = true;
        evidence.execution.recoveryAction = AGENT_IMAGE_CANARY_RECOVERY_ACTION;
        throw error;
      }
    }

    if (recovered) {
      rememberAcceptedCandidate(evidence, recovered);
      evidence.execution.recovered = true;
      evidence.execution.dryRunPassed = true;
      validateRecoveredIntent(
        recovered,
        config.mode,
        config.targetDigest,
        config.sourceJobId,
      );
      evidence.image.sourceRepository = repositoryOf(
        recovered.target.sourceImage,
      );
      evidence.image.sourceDigest = recovered.target.sourceDigest;
      evidence.image.targetRepository = repositoryOf(
        recovered.target.targetImage,
      );
      evidence.image.targetDigest = recovered.target.targetDigest;
      await checkpointEvidence(options.checkpoint, evidence);
      await measured(evidence, "poll", now, () =>
        pollJob(
          fetchImpl,
          config.baseUrl,
          config.apiKey,
          pollExpectation(recovered),
          evidence,
          now,
          sleep,
          requestTimeoutMs,
          pollIntervalMs,
          pollTimeoutMs,
        ),
      );
      await checkpointEvidence(options.checkpoint, evidence);
      if (config.mode === "upgrade") {
        const targetDigest = config.targetDigest;
        if (!targetDigest) fail("config", "invalid_target_digest");
        await measured(evidence, "publicImage", now, () =>
          verifyPublicDemoImage(fetchImpl, targetDigest, requestTimeoutMs),
        );
        evidence.image.publicTargetVerified = true;
        if (!options.recoveryOnly) {
          await measured(evidence, "rollbackDryRun", now, () =>
            previewExactRollback({
              fetchImpl,
              baseUrl: config.baseUrl,
              apiKey: config.apiKey,
              requestId: config.requestId,
              executed: recovered,
              timeoutMs: requestTimeoutMs,
            }),
          );
          evidence.execution.rollbackDryRunPassed = true;
        }
      }
    } else {
      if (options.recoveryOnly) {
        evidence.execution.recoveryRequired = true;
        evidence.execution.recoveryAction = AGENT_IMAGE_CANARY_RECOVERY_ACTION;
        fail("recovery", "recovery_not_found");
      }
      const inventory = await measured(evidence, "inventory", now, () =>
        readInventoryTarget(
          fetchImpl,
          config.baseUrl,
          config.apiKey,
          requestTimeoutMs,
        ),
      );
      evidence.execution.inventoryMatched = true;
      evidence.image.sourceRepository = repositoryOf(inventory.dockerImage);
      evidence.image.sourceDigest = inventory.imageDigest;

      if (config.mode === "upgrade") {
        if (
          evidence.image.sourceRepository !==
          AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY
        ) {
          fail("inventory", "invalid_source_image");
        }
        const targetDigest = config.targetDigest;
        if (!targetDigest) fail("config", "invalid_target_digest");
        await measured(evidence, "publicImage", now, () =>
          verifyPublicDemoImage(fetchImpl, targetDigest, requestTimeoutMs),
        );
        evidence.image.publicTargetVerified = true;
        const targetImage = `${AGENT_IMAGE_CANARY_DEMO_REPOSITORY}@${targetDigest}`;
        const dryRunBody = {
          operation: "upgrade",
          requestId: config.requestId,
          dryRun: true,
          targetImage,
          targets: [
            {
              agentId: AGENT_IMAGE_CANARY_FIXED_AGENT_ID,
              organizationId: inventory.organizationId,
              expectedSourceImage: inventory.dockerImage,
              expectedSourceDigest: inventory.imageDigest,
            },
          ],
        } as const;
        const preview = await measured(evidence, "dryRun", now, () =>
          postRollout(
            fetchImpl,
            config.baseUrl,
            config.apiKey,
            dryRunBody,
            "upgrade",
            true,
            requestTimeoutMs,
            "dry_run",
            config.requestId,
          ),
        );
        validateUpgradePlan(preview.target, inventory, targetDigest, "dry_run");
        evidence.execution.planFingerprint = preview.planFingerprint;
        evidence.execution.dryRunPassed = true;
        await checkpointEvidence(options.checkpoint, evidence);

        const accepted = await measured(evidence, "execute", now, () =>
          executeWithRecovery({
            fetchImpl,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            requestBody: {
              ...dryRunBody,
              dryRun: false,
              expectedPlanFingerprint: preview.planFingerprint,
            },
            operation: "upgrade",
            requestId: config.requestId,
            expectedPlanFingerprint: preview.planFingerprint,
            timeoutMs: requestTimeoutMs,
            evidence,
            validate: (response) => {
              validateUpgradePlan(
                response.target,
                inventory,
                targetDigest,
                "execute",
              );
              if (
                !samePlannedPair(preview.target, response.target) ||
                !response.rolloutId ||
                !response.target.jobId ||
                !response.pollEndpoint
              ) {
                fail("execute", "execute_mismatch");
              }
            },
          }),
        );
        rememberAcceptedCandidate(evidence, accepted.response);
        evidence.execution.recovered = accepted.recovered;
        await checkpointEvidence(options.checkpoint, evidence);
        await measured(evidence, "poll", now, () =>
          pollJob(
            fetchImpl,
            config.baseUrl,
            config.apiKey,
            pollExpectation(accepted.response),
            evidence,
            now,
            sleep,
            requestTimeoutMs,
            pollIntervalMs,
            pollTimeoutMs,
          ),
        );
        await checkpointEvidence(options.checkpoint, evidence);
        await measured(evidence, "rollbackDryRun", now, () =>
          previewExactRollback({
            fetchImpl,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            requestId: config.requestId,
            executed: accepted.response,
            timeoutMs: requestTimeoutMs,
          }),
        );
        evidence.execution.rollbackDryRunPassed = true;
      } else {
        const sourceJobId = config.sourceJobId;
        if (!sourceJobId) fail("config", "invalid_source_job_id");
        if (
          evidence.image.sourceRepository !==
            AGENT_IMAGE_CANARY_DEMO_REPOSITORY ||
          inventory.dockerImage !==
            `${AGENT_IMAGE_CANARY_DEMO_REPOSITORY}@${inventory.imageDigest}`
        ) {
          fail("inventory", "invalid_source_image");
        }
        const dryRunBody = {
          operation: "rollback",
          requestId: config.requestId,
          dryRun: true,
          source: { jobId: sourceJobId },
        } as const;
        const preview = await measured(evidence, "dryRun", now, () =>
          postRollout(
            fetchImpl,
            config.baseUrl,
            config.apiKey,
            dryRunBody,
            "rollback",
            true,
            requestTimeoutMs,
            "dry_run",
            config.requestId,
          ),
        );
        validateRollbackPlan(preview.target, inventory, sourceJobId, "dry_run");
        evidence.image.targetRepository = repositoryOf(
          preview.target.targetImage,
        );
        evidence.image.targetDigest = preview.target.targetDigest;
        evidence.execution.planFingerprint = preview.planFingerprint;
        evidence.execution.dryRunPassed = true;
        await checkpointEvidence(options.checkpoint, evidence);

        const accepted = await measured(evidence, "execute", now, () =>
          executeWithRecovery({
            fetchImpl,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            requestBody: {
              ...dryRunBody,
              dryRun: false,
              expectedPlanFingerprint: preview.planFingerprint,
            },
            operation: "rollback",
            requestId: config.requestId,
            expectedPlanFingerprint: preview.planFingerprint,
            timeoutMs: requestTimeoutMs,
            evidence,
            validate: (response) => {
              validateRollbackPlan(
                response.target,
                inventory,
                sourceJobId,
                "execute",
              );
              if (
                !samePlannedPair(preview.target, response.target) ||
                !response.rolloutId ||
                !response.target.jobId ||
                !response.pollEndpoint
              ) {
                fail("execute", "execute_mismatch");
              }
            },
          }),
        );
        rememberAcceptedCandidate(evidence, accepted.response);
        evidence.execution.recovered = accepted.recovered;
        await checkpointEvidence(options.checkpoint, evidence);
        await measured(evidence, "poll", now, () =>
          pollJob(
            fetchImpl,
            config.baseUrl,
            config.apiKey,
            pollExpectation(accepted.response),
            evidence,
            now,
            sleep,
            requestTimeoutMs,
            pollIntervalMs,
            pollTimeoutMs,
          ),
        );
        await checkpointEvidence(options.checkpoint, evidence);
      }
    }

    evidence.verdict = "pass";
  } catch (error) {
    // error-policy:J1 The runner projects failures into privacy-safe evidence.
    evidence.failure =
      error instanceof CanaryFailure
        ? { phase: error.phase, code: error.code }
        : { phase: "internal", code: "unexpected_error" };
    if (
      evidence.execution.recoveryRequired ||
      (evidence.execution.executeAccepted &&
        evidence.execution.terminalStatus === null)
    ) {
      evidence.execution.recoveryRequired = true;
      evidence.execution.recoveryAction = AGENT_IMAGE_CANARY_RECOVERY_ACTION;
      evidence.verdict = "nonterminal";
    } else {
      evidence.verdict = "fail";
    }
  } finally {
    evidence.timingsMs.total = Math.max(0, Math.round(now() - totalStartedAt));
  }
  return evidence;
}

function optionalDigest(value: unknown): boolean {
  return value === null || isDigest(value);
}

function optionalUuid(value: unknown): boolean {
  return value === null || isUuid(value);
}

function optionalRepository(value: unknown): boolean {
  return (
    value === null ||
    value === AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY ||
    value === AGENT_IMAGE_CANARY_DEMO_REPOSITORY
  );
}

export function validateAgentImageCanaryEvidence(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["artifact_not_object"];
  if (
    !exactKeys(value, [
      "schemaVersion",
      "verdict",
      "mode",
      "deployedCommit",
      "image",
      "execution",
      "timingsMs",
      "failure",
    ])
  ) {
    errors.push("unexpected_top_level_keys");
  }
  if (value.schemaVersion !== 1) errors.push("invalid_schema_version");
  if (
    value.verdict !== "pending" &&
    value.verdict !== "pass" &&
    value.verdict !== "fail" &&
    value.verdict !== "nonterminal"
  ) {
    errors.push("invalid_verdict");
  }
  if (
    value.mode !== null &&
    value.mode !== "upgrade" &&
    value.mode !== "rollback"
  ) {
    errors.push("invalid_mode");
  }
  if (
    value.deployedCommit !== null &&
    (typeof value.deployedCommit !== "string" ||
      !COMMIT_RE.test(value.deployedCommit))
  ) {
    errors.push("invalid_deployed_commit");
  }

  if (
    !isRecord(value.image) ||
    !exactKeys(value.image, [
      "sourceRepository",
      "sourceDigest",
      "targetRepository",
      "targetDigest",
      "publicTargetVerified",
    ])
  ) {
    errors.push("invalid_image_projection");
  } else {
    if (!optionalRepository(value.image.sourceRepository)) {
      errors.push("invalid_source_repository");
    }
    if (!optionalDigest(value.image.sourceDigest)) {
      errors.push("invalid_source_digest");
    }
    if (!optionalRepository(value.image.targetRepository)) {
      errors.push("invalid_target_repository");
    }
    if (!optionalDigest(value.image.targetDigest)) {
      errors.push("invalid_target_digest");
    }
    if (typeof value.image.publicTargetVerified !== "boolean") {
      errors.push("invalid_public_target_verdict");
    }
  }

  if (
    !isRecord(value.execution) ||
    !exactKeys(value.execution, [
      "requestId",
      "planFingerprint",
      "recoveryOnly",
      "inventoryMatched",
      "dryRunPassed",
      "executeAccepted",
      "recovered",
      "recoveryRequired",
      "recoveryAction",
      "sourceJobId",
      "jobId",
      "terminalStatus",
      "pollCount",
      "rollbackDryRunPassed",
    ])
  ) {
    errors.push("invalid_execution_projection");
  } else {
    for (const key of [
      "recoveryOnly",
      "inventoryMatched",
      "dryRunPassed",
      "executeAccepted",
      "recovered",
      "recoveryRequired",
      "rollbackDryRunPassed",
    ] as const) {
      if (typeof value.execution[key] !== "boolean") {
        errors.push(`invalid_${key}`);
      }
    }
    if (!optionalUuid(value.execution.requestId)) {
      errors.push("invalid_request_id");
    }
    if (!optionalDigest(value.execution.planFingerprint)) {
      errors.push("invalid_plan_fingerprint");
    }
    if (
      value.execution.recoveryAction !== null &&
      value.execution.recoveryAction !== AGENT_IMAGE_CANARY_RECOVERY_ACTION
    ) {
      errors.push("invalid_recovery_action");
    }
    if (!optionalUuid(value.execution.sourceJobId)) {
      errors.push("invalid_source_job_id");
    }
    if (!optionalUuid(value.execution.jobId)) {
      errors.push("invalid_job_id");
    }
    if (
      value.execution.terminalStatus !== null &&
      value.execution.terminalStatus !== "completed" &&
      value.execution.terminalStatus !== "failed" &&
      value.execution.terminalStatus !== "cancelled" &&
      value.execution.terminalStatus !== "canceled"
    ) {
      errors.push("invalid_terminal_status");
    }
    if (
      typeof value.execution.pollCount !== "number" ||
      !Number.isInteger(value.execution.pollCount) ||
      value.execution.pollCount < 0 ||
      value.execution.pollCount > 500
    ) {
      errors.push("invalid_poll_count");
    }
  }

  if (!isRecord(value.timingsMs)) {
    errors.push("invalid_timings");
  } else {
    const allowed = new Set<string>(TIMING_PHASES);
    for (const [key, timing] of Object.entries(value.timingsMs)) {
      if (
        !allowed.has(key) ||
        typeof timing !== "number" ||
        !Number.isFinite(timing) ||
        timing < 0 ||
        timing > MAX_EVIDENCE_TIMING_MS
      ) {
        errors.push(`invalid_timing_${key}`);
      }
    }
  }

  if (value.failure !== null) {
    if (
      !isRecord(value.failure) ||
      !exactKeys(value.failure, ["phase", "code"]) ||
      !FAILURE_PHASES.includes(value.failure.phase as FailurePhase) ||
      !FAILURE_CODES.includes(value.failure.code as FailureCode)
    ) {
      errors.push("invalid_failure");
    }
  }

  if (value.verdict === "pass") {
    if (
      value.failure !== null ||
      (value.mode !== "upgrade" && value.mode !== "rollback") ||
      typeof value.deployedCommit !== "string" ||
      !isRecord(value.image) ||
      !isRecord(value.execution) ||
      (value.execution.inventoryMatched !== true &&
        value.execution.recovered !== true) ||
      value.execution.dryRunPassed !== true ||
      value.execution.executeAccepted !== true ||
      value.execution.recoveryRequired !== false ||
      value.execution.recoveryAction !== null ||
      value.execution.terminalStatus !== "completed" ||
      !isUuid(value.execution.requestId) ||
      !isDigest(value.execution.planFingerprint) ||
      !isUuid(value.execution.jobId)
    ) {
      errors.push("incomplete_pass");
    } else if (value.mode === "upgrade") {
      if (
        value.image.sourceRepository !==
          AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY ||
        value.image.targetRepository !== AGENT_IMAGE_CANARY_DEMO_REPOSITORY ||
        !isDigest(value.image.sourceDigest) ||
        !isDigest(value.image.targetDigest) ||
        value.image.publicTargetVerified !== true ||
        value.execution.sourceJobId !== null ||
        (value.execution.recoveryOnly === true
          ? value.execution.rollbackDryRunPassed !== false
          : value.execution.rollbackDryRunPassed !== true)
      ) {
        errors.push("incomplete_upgrade_pass");
      }
    } else if (
      value.image.sourceRepository !== AGENT_IMAGE_CANARY_DEMO_REPOSITORY ||
      value.image.targetRepository !==
        AGENT_IMAGE_CANARY_CANONICAL_REPOSITORY ||
      !isDigest(value.image.sourceDigest) ||
      !isDigest(value.image.targetDigest) ||
      !isUuid(value.execution.sourceJobId) ||
      value.execution.rollbackDryRunPassed !== false
    ) {
      errors.push("incomplete_rollback_pass");
    }
  } else if (value.verdict === "pending") {
    if (
      value.failure !== null ||
      !isRecord(value.execution) ||
      !isUuid(value.execution.requestId) ||
      value.execution.recoveryRequired !== false ||
      value.execution.recoveryAction !== null
    ) {
      errors.push("invalid_pending_checkpoint");
    }
  } else if (value.verdict === "nonterminal") {
    if (
      value.failure === null ||
      !isRecord(value.execution) ||
      !isUuid(value.execution.requestId) ||
      value.execution.recoveryRequired !== true ||
      value.execution.recoveryAction !== AGENT_IMAGE_CANARY_RECOVERY_ACTION ||
      value.execution.terminalStatus !== null
    ) {
      errors.push("invalid_nonterminal");
    }
  } else if (
    value.failure === null ||
    !isRecord(value.execution) ||
    value.execution.recoveryRequired !== false ||
    value.execution.recoveryAction !== null
  ) {
    errors.push("invalid_failure_state");
  }
  return errors;
}

export function canonicalizeAgentImageCanaryArtifact(raw: string): {
  canonical: string | null;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 Malformed evidence is rejected rather than repaired.
    return { canonical: null, errors: ["artifact_invalid_json"] };
  }
  const errors = validateAgentImageCanaryEvidence(parsed);
  return {
    canonical:
      errors.length === 0 ? `${JSON.stringify(parsed, null, 2)}\n` : null,
    errors,
  };
}

async function writeEvidence(
  path: string,
  evidence: AgentImageCanaryEvidence,
): Promise<void> {
  const errors = validateAgentImageCanaryEvidence(evidence);
  if (errors.length > 0) {
    throw new Error("evidence_validation_failed");
  }
  const temporaryPath = `${path}.pending-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function workflowEnv(name: string): string {
  return process.env[name] ?? "";
}

if (import.meta.main) {
  const evidencePath =
    workflowEnv("AGENT_IMAGE_CANARY_EVIDENCE_PATH") ||
    "reports/agent-image-canary.json";
  const evidence = await runAgentImageCanary({
    apiKey: workflowEnv("ELIZACLOUD_API_KEY"),
    mode: workflowEnv("AGENT_IMAGE_CANARY_MODE"),
    requestId: workflowEnv("AGENT_IMAGE_CANARY_REQUEST_ID"),
    expectedDeployCommit: workflowEnv(
      "AGENT_IMAGE_CANARY_EXPECTED_DEPLOY_COMMIT",
    ),
    targetDigest: workflowEnv("AGENT_IMAGE_CANARY_TARGET_DIGEST"),
    sourceJobId: workflowEnv("AGENT_IMAGE_CANARY_SOURCE_JOB_ID"),
    baseUrl:
      workflowEnv("AGENT_IMAGE_CANARY_BASE_URL") ||
      AGENT_IMAGE_CANARY_PRODUCTION_ORIGIN,
    recoverExistingRequest:
      workflowEnv("AGENT_IMAGE_CANARY_RECOVER_EXISTING") === "true",
    recoveryOnly: workflowEnv("AGENT_IMAGE_CANARY_RECOVERY_ONLY") === "true",
    checkpoint: async (checkpoint) => {
      await writeEvidence(evidencePath, checkpoint);
    },
  });
  try {
    await writeEvidence(evidencePath, evidence);
  } catch {
    // error-policy:J1 The process exits nonzero without printing unsafe state.
    process.stderr.write(
      "[agent-image-canary] privacy-safe evidence validation or write failed\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `[agent-image-canary] ${evidence.mode ?? "invalid"} ${evidence.verdict}\n`,
  );
  process.exit(evidence.verdict === "pass" ? 0 : 1);
}
