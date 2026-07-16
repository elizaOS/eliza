#!/usr/bin/env bun
/**
 * Fail-closed staging canary for the managed dedicated-agent path.
 *
 * The canary uses an existing Cloud API credential, creates at most one
 * explicitly `alwaysOn` agent, proves one bridge turn and one SSE turn, and
 * deletes only the exact agent it created. Its evidence intentionally contains
 * timings and path verdicts only: no credentials, prompts, model output, agent
 * identifiers, agent names, or infrastructure hostnames.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { classifyBridgeReply } from "./bridge-reply-verdict";
import { SMOKE_AGENT_PLUGINS } from "./smoke-agent-plugins";

type JsonObject = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;
type PrivacySafeObservedTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom"
  | "other";

const STAGING_BASE_URL = "https://api-staging.elizacloud.ai";
const CANARY_NAME_PREFIX = "managed-dedicated-canary-";
const EXPECTED_TIER = "dedicated-always";
const HEARTBEAT_MAX_AGE_MS = 120_000;
const HEARTBEAT_FUTURE_SKEW_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 130_000;
const READY_TIMEOUT_MS = 12 * 60_000;
const CLEANUP_TIMEOUT_MS = 4 * 60_000;
const MAX_ARTIFACT_TIMING_MS = 45 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const CREATE_RECOVERY_TIMEOUT_MS = 30_000;
const CREATE_RECOVERY_POLL_INTERVAL_MS = 2_000;
const MAX_CREATE_RECOVERY_ATTEMPTS = 5;
const MAX_CHAT_ATTEMPTS_PER_PATH = 2;
const MAX_CREATED_AGENTS = 1;
const TIMING_PHASES = [
  "health",
  "capacityGuard",
  "create",
  "ready",
  "bridge",
  "sse",
  "cleanup",
  "total",
] as const;
type TimingPhase = (typeof TIMING_PHASES)[number];
const DEDICATED_BRIDGE_TRANSPORTS = new Set([
  "native-jsonrpc",
  "conversation-rest",
  "central-channel",
  "openai-compat",
]);
const TERMINAL_JOB_STATUSES = new Set(["failed", "cancelled", "canceled"]);
const TERMINAL_AGENT_FAILURE_STATUSES = new Set([
  "error",
  "stopped",
  "sleeping",
  "disconnected",
  "deletion_pending",
  "deletion_failed",
]);
const PRIVACY_SAFE_FAILURE_PHASES = new Set([
  "config",
  "health",
  "capacity_guard",
  "create",
  "create_recovery",
  "provision",
  "ready",
  "bridge_status",
  "bridge_heartbeat",
  "bridge_turn",
  "sse",
  "cleanup",
  "cleanup_verify",
  "cleanup_delete",
  "cleanup_job",
  "cleanup_confirm",
  "internal",
]);
const PRIVACY_SAFE_FAILURE_CODES = new Set([
  "invalid_run_suffix",
  "error_event",
  "unexpected_error",
  "request_failed",
  "invalid_response_shape",
  "invalid_agent_list",
  "job_failed",
  "job_timeout",
  "agent_not_initialized",
  "missing_agent_data",
  "wrong_execution_tier",
  "terminal_agent_state",
  "readiness_timeout",
  "rpc_error_invalid_shape",
  "rpc_sandbox_not_running",
  "rpc_bridge_unreachable",
  "rpc_method_not_found",
  "rpc_error_unclassified",
  "missing_rpc_result",
  "not_ready",
  "proof_missing",
  "non_dedicated_transport",
  "invalid_reply",
  "missing_body",
  "stream_read_failed",
  "missing_done_event",
  "possible_orphan_after_ambiguous_create",
  "identity_mismatch",
  "missing_delete_job",
  "delete_not_confirmed",
  "missing_cloud_credential",
  "non_staging_target_refused",
  "missing_deploy_commit",
  "existing_canary_present",
  "missing_agent_id",
]);

export interface ManagedDedicatedCanaryEvidence {
  schemaVersion: 1;
  verdict: "pass" | "fail";
  deployedCommit: string | null;
  path: {
    requestedTier: "dedicated-always";
    observedTier: PrivacySafeObservedTier | null;
    running: boolean;
    databaseReady: boolean;
    heartbeatFresh: boolean;
    meshAddressPresent: boolean;
    bridgeTransport: string | null;
    sseCompleted: boolean;
    successfulPaths: number;
  };
  capacity: {
    maxCreatedAgents: 1;
    createdAgents: number;
    maxChatRequests: number;
    chatRequests: number;
  };
  timingsMs: Partial<Record<TimingPhase, number>>;
  cleanup: {
    status: "not-required" | "passed" | "failed";
    possibleOrphan: boolean;
  };
  failure: {
    phase: string;
    code: string;
  } | null;
}

export interface ManagedDedicatedCanaryOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  suffix?: string;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  pollIntervalMs?: number;
  createRecoveryTimeoutMs?: number;
  createRecoveryPollIntervalMs?: number;
}

class CanaryFailure extends Error {
  constructor(
    readonly phase: string,
    readonly code: string,
  ) {
    super(`${phase}:${code}`);
    this.name = "CanaryFailure";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This CLI is workflow-owned and never runs as a cached Turbo task. */
function workflowEnv(name: string): string | undefined {
  return process.env[name];
}

function dataRecord(body: JsonObject): JsonObject | null {
  return isRecord(body.data) ? body.data : null;
}

function stringField(record: JsonObject | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function privacySafeObservedTier(
  value: string | null,
): PrivacySafeObservedTier | null {
  switch (value) {
    case "shared":
    case "dedicated-lazy":
    case "dedicated-always":
    case "custom":
      return value;
    case null:
      return null;
    default:
      return "other";
  }
}

function isPrivacySafeObservedTier(
  value: unknown,
): value is PrivacySafeObservedTier {
  return typeof value === "string" && privacySafeObservedTier(value) === value;
}

function sanitizeSuffix(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  if (normalized.length < 8) {
    throw new CanaryFailure("config", "invalid_run_suffix");
  }
  return normalized;
}

function isStagingBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === STAGING_BASE_URL &&
      !url.username &&
      !url.password &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isHeadscaleIpv4(value: string): boolean {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    return false;
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return false;
  // Tailscale/Headscale IPv4 addresses are allocated from 100.64.0.0/10.
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function hasExactHeadscaleIpv4Url(value: string): boolean {
  // Read the raw authority before WHATWG URL parsing: URL.hostname normalizes
  // legacy octal/short IPv4 forms (for example `100.0100.0.21`) and would turn
  // a non-exact input into a different apparently valid mesh address.
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value)?.[1];
  if (!authority || authority.includes("@") || authority.startsWith("[")) {
    return false;
  }
  const colon = authority.indexOf(":");
  if (colon !== -1 && colon !== authority.lastIndexOf(":")) return false;
  const hostname = colon === -1 ? authority : authority.slice(0, colon);
  if (!isHeadscaleIpv4(hostname)) return false;
  try {
    return new URL(value).hostname === hostname;
  } catch {
    return false;
  }
}

function hasMeshAddress(agent: JsonObject): boolean {
  const adminDetails = isRecord(agent.adminDetails) ? agent.adminDetails : null;
  const explicit = stringField(adminDetails, "headscaleIp");
  if (explicit && isHeadscaleIpv4(explicit)) return true;

  const bridgeUrl = stringField(agent, "bridgeUrl");
  if (!bridgeUrl) return false;
  return hasExactHeadscaleIpv4Url(bridgeUrl);
}

function heartbeatIsFresh(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = nowMs - timestamp;
  return age >= -HEARTBEAT_FUTURE_SKEW_MS && age <= HEARTBEAT_MAX_AGE_MS;
}

function parseSseBlock(
  block: string,
): { event: string; data: JsonObject | null } | null {
  if (!block.trim()) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) return { event, data: null };
  const value = dataLines.join("\n");
  if (value === "[DONE]") return { event: "done", data: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    return { event, data: isRecord(parsed) ? parsed : { value: parsed } };
  } catch {
    return { event, data: { text: value } };
  }
}

function sseText(event: string, data: JsonObject | null): string {
  if (!data || event === "done") return "";
  if (event === "error") {
    throw new CanaryFailure("sse", "error_event");
  }
  for (const key of ["text", "chunk", "content"] as const) {
    const value = data[key];
    if (typeof value === "string") return value;
    if (isRecord(value) && typeof value.text === "string") return value.text;
  }
  return "";
}

function freshEvidence(): ManagedDedicatedCanaryEvidence {
  return {
    schemaVersion: 1,
    verdict: "fail",
    deployedCommit: null,
    path: {
      requestedTier: EXPECTED_TIER,
      observedTier: null,
      running: false,
      databaseReady: false,
      heartbeatFresh: false,
      meshAddressPresent: false,
      bridgeTransport: null,
      sseCompleted: false,
      successfulPaths: 0,
    },
    capacity: {
      maxCreatedAgents: MAX_CREATED_AGENTS,
      createdAgents: 0,
      maxChatRequests: MAX_CHAT_ATTEMPTS_PER_PATH * 2,
      chatRequests: 0,
    },
    timingsMs: {},
    cleanup: { status: "not-required", possibleOrphan: false },
    failure: null,
  };
}

function exactEvidenceRecord(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  errors: string[],
  allowedKeys: readonly string[] = requiredKeys,
): JsonObject | null {
  if (!isRecord(value)) {
    errors.push(`${path}_not_object`);
    return null;
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    // Never echo an untrusted key into logs: field names can carry secrets too.
    errors.push(`${path}_unexpected_field`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}_missing_${key}`);
  }
  return value;
}

function isBoundedInteger(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isPrivacySafeFailureCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    PRIVACY_SAFE_FAILURE_CODES.has(value) ||
    /^(?:invalid_json_response_http|unexpected_http|rpc_upstream_http)_[1-5]\d{2}$/.test(
      value,
    ) ||
    /^rpc_error_code_-?\d{1,6}$/.test(value)
  );
}

/**
 * Strict artifact-boundary validator. Unlike the pass/fail acceptance
 * validator below, this accepts both red and green canary evidence, but only
 * when every object has the exact privacy-safe schema and every string is an
 * allowlisted enum/hash/sanitized failure code. It never includes untrusted
 * keys or values in its own errors.
 */
export function validateManagedDedicatedCanaryArtifact(
  value: unknown,
): string[] {
  const errors: string[] = [];
  const evidence = exactEvidenceRecord(
    value,
    "evidence",
    [
      "schemaVersion",
      "verdict",
      "deployedCommit",
      "path",
      "capacity",
      "timingsMs",
      "cleanup",
      "failure",
    ],
    errors,
  );
  if (!evidence) return errors;

  if (evidence.schemaVersion !== 1) errors.push("unsafe_schema_version");
  if (evidence.verdict !== "pass" && evidence.verdict !== "fail") {
    errors.push("unsafe_verdict");
  }
  if (
    evidence.deployedCommit !== null &&
    (typeof evidence.deployedCommit !== "string" ||
      !/^[a-f0-9]{40}$/.test(evidence.deployedCommit))
  ) {
    errors.push("unsafe_deployed_commit");
  }

  const path = exactEvidenceRecord(
    evidence.path,
    "path",
    [
      "requestedTier",
      "observedTier",
      "running",
      "databaseReady",
      "heartbeatFresh",
      "meshAddressPresent",
      "bridgeTransport",
      "sseCompleted",
      "successfulPaths",
    ],
    errors,
  );
  if (path) {
    if (path.requestedTier !== EXPECTED_TIER) {
      errors.push("unsafe_requested_tier");
    }
    if (
      path.observedTier !== null &&
      !isPrivacySafeObservedTier(path.observedTier)
    ) {
      errors.push("unsafe_observed_tier");
    }
    for (const key of [
      "running",
      "databaseReady",
      "heartbeatFresh",
      "meshAddressPresent",
      "sseCompleted",
    ]) {
      if (typeof path[key] !== "boolean") errors.push(`unsafe_path_${key}`);
    }
    if (
      path.bridgeTransport !== null &&
      (typeof path.bridgeTransport !== "string" ||
        !DEDICATED_BRIDGE_TRANSPORTS.has(path.bridgeTransport))
    ) {
      errors.push("unsafe_bridge_transport");
    }
    if (!isBoundedInteger(path.successfulPaths, 0, 2)) {
      errors.push("unsafe_successful_paths");
    }
  }

  const capacity = exactEvidenceRecord(
    evidence.capacity,
    "capacity",
    ["maxCreatedAgents", "createdAgents", "maxChatRequests", "chatRequests"],
    errors,
  );
  if (capacity) {
    if (capacity.maxCreatedAgents !== MAX_CREATED_AGENTS) {
      errors.push("unsafe_max_created_agents");
    }
    if (!isBoundedInteger(capacity.createdAgents, 0, MAX_CREATED_AGENTS)) {
      errors.push("unsafe_created_agents");
    }
    if (capacity.maxChatRequests !== MAX_CHAT_ATTEMPTS_PER_PATH * 2) {
      errors.push("unsafe_max_chat_requests");
    }
    if (
      !isBoundedInteger(
        capacity.chatRequests,
        0,
        MAX_CHAT_ATTEMPTS_PER_PATH * 2,
      )
    ) {
      errors.push("unsafe_chat_requests");
    }
  }

  const timings = exactEvidenceRecord(
    evidence.timingsMs,
    "timings",
    [],
    errors,
    TIMING_PHASES,
  );
  if (timings) {
    if (!Object.hasOwn(timings, "total")) errors.push("timings_missing_total");
    for (const value of Object.values(timings)) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_ARTIFACT_TIMING_MS
      ) {
        errors.push("unsafe_timing_value");
        break;
      }
    }
  }

  const cleanup = exactEvidenceRecord(
    evidence.cleanup,
    "cleanup",
    ["status", "possibleOrphan"],
    errors,
  );
  if (cleanup) {
    if (
      cleanup.status !== "not-required" &&
      cleanup.status !== "passed" &&
      cleanup.status !== "failed"
    ) {
      errors.push("unsafe_cleanup_status");
    }
    if (typeof cleanup.possibleOrphan !== "boolean") {
      errors.push("unsafe_cleanup_orphan_flag");
    }
  }

  if (evidence.failure !== null) {
    const failure = exactEvidenceRecord(
      evidence.failure,
      "failure",
      ["phase", "code"],
      errors,
    );
    if (failure) {
      if (
        typeof failure.phase !== "string" ||
        !PRIVACY_SAFE_FAILURE_PHASES.has(failure.phase)
      ) {
        errors.push("unsafe_failure_phase");
      }
      if (!isPrivacySafeFailureCode(failure.code)) {
        errors.push("unsafe_failure_code");
      }
    }
  }
  return errors;
}

/**
 * Parse and canonically reserialize evidence only after strict validation.
 * Rewriting the bytes is part of the privacy boundary: JSON.parse collapses
 * duplicate keys, so validating an object and uploading the original text
 * could otherwise retain a secret in an earlier duplicate field.
 */
export function canonicalizeManagedDedicatedCanaryArtifact(raw: string): {
  canonical: string | null;
  errors: string[];
} {
  let evidence: unknown;
  try {
    evidence = JSON.parse(raw);
  } catch {
    return { canonical: null, errors: ["evidence_invalid_json"] };
  }
  const errors = validateManagedDedicatedCanaryArtifact(evidence);
  return {
    canonical:
      errors.length === 0 ? `${JSON.stringify(evidence, null, 2)}\n` : null,
    errors,
  };
}

/**
 * Independent fail-closed validator used by the workflow after the live
 * process exits. This prevents an accidental early return, skip, or zero-turn
 * result from becoming green solely because the process returned status 0.
 */
export function validateManagedDedicatedCanaryEvidence(
  value: unknown,
): string[] {
  if (!isRecord(value)) return ["evidence_not_an_object"];
  const evidence = value as unknown as ManagedDedicatedCanaryEvidence;
  const errors: string[] = [];
  if (evidence.schemaVersion !== 1) errors.push("wrong_schema_version");
  if (evidence.verdict !== "pass") errors.push("verdict_not_pass");
  if (!/^[a-f0-9]{40}$/.test(evidence.deployedCommit ?? "")) {
    errors.push("missing_deployed_commit");
  }
  if (evidence.path?.requestedTier !== EXPECTED_TIER) {
    errors.push("wrong_requested_tier");
  }
  if (evidence.path?.observedTier !== EXPECTED_TIER) {
    errors.push("wrong_observed_tier");
  }
  for (const [key, ok] of [
    ["running", evidence.path?.running],
    ["database_ready", evidence.path?.databaseReady],
    ["heartbeat_fresh", evidence.path?.heartbeatFresh],
    ["mesh_address_present", evidence.path?.meshAddressPresent],
    ["sse_completed", evidence.path?.sseCompleted],
  ] as const) {
    if (ok !== true) errors.push(key);
  }
  if (!DEDICATED_BRIDGE_TRANSPORTS.has(evidence.path?.bridgeTransport ?? "")) {
    errors.push("invalid_bridge_transport");
  }
  if (evidence.path?.successfulPaths !== 2) {
    errors.push("successful_paths_not_two");
  }
  if (
    evidence.capacity?.maxCreatedAgents !== MAX_CREATED_AGENTS ||
    evidence.capacity?.createdAgents !== 1
  ) {
    errors.push("created_agent_count_invalid");
  }
  if (
    evidence.capacity?.maxChatRequests !== MAX_CHAT_ATTEMPTS_PER_PATH * 2 ||
    !Number.isInteger(evidence.capacity?.chatRequests) ||
    evidence.capacity.chatRequests < 2 ||
    evidence.capacity.chatRequests > evidence.capacity.maxChatRequests
  ) {
    errors.push("chat_request_count_invalid");
  }
  if (evidence.cleanup?.status !== "passed") errors.push("cleanup_not_passed");
  if (evidence.cleanup?.possibleOrphan !== false) {
    errors.push("possible_orphan_present");
  }
  for (const phase of TIMING_PHASES) {
    const timing = evidence.timingsMs?.[phase];
    if (typeof timing !== "number" || !Number.isFinite(timing) || timing < 0) {
      errors.push(`invalid_timing_${phase}`);
    }
  }
  if (evidence.failure !== null) errors.push("failure_present");
  return errors;
}

function asFailure(error: unknown): CanaryFailure {
  return error instanceof CanaryFailure
    ? error
    : new CanaryFailure("internal", "unexpected_error");
}

/**
 * Reduce a JSON-RPC error to an allowlisted, privacy-safe diagnostic. Never
 * persist the upstream message: it is outside the canary's trust boundary and
 * could contain runtime/provider details. The bridge service's public error
 * contract is intentionally small, so exact known messages plus a restricted
 * HTTP-status pattern are enough to distinguish actionable failure classes.
 */
function classifyRpcError(value: unknown): string {
  if (!isRecord(value)) return "rpc_error_invalid_shape";
  const message = stringField(value, "message");
  if (message === "Sandbox is not running") return "rpc_sandbox_not_running";
  if (message === "Sandbox bridge is unreachable") {
    return "rpc_bridge_unreachable";
  }
  if (message?.startsWith("Method not found:")) return "rpc_method_not_found";

  const upstreamStatus = /^Bridge returned HTTP ([1-5]\d{2})$/.exec(
    message ?? "",
  )?.[1];
  if (upstreamStatus) return `rpc_upstream_http_${upstreamStatus}`;

  const rpcCode = value.code;
  if (
    typeof rpcCode === "number" &&
    Number.isSafeInteger(rpcCode) &&
    Math.abs(rpcCode) <= 999_999
  ) {
    return `rpc_error_code_${rpcCode}`;
  }
  return "rpc_error_unclassified";
}

function timedPhase(
  evidence: ManagedDedicatedCanaryEvidence,
  label: TimingPhase,
  now: () => number,
): () => void {
  const started = now();
  return () => {
    evidence.timingsMs[label] = Math.max(0, Math.round(now() - started));
  };
}

async function inTimedPhase<T>(
  evidence: ManagedDedicatedCanaryEvidence,
  label: TimingPhase,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = timedPhase(evidence, label, now);
  try {
    return await operation();
  } finally {
    finish();
  }
}

export async function runManagedDedicatedCanary(
  options: ManagedDedicatedCanaryOptions,
): Promise<ManagedDedicatedCanaryEvidence> {
  const evidence = freshEvidence();
  const totalDone = timedPhase(evidence, "total", options.now ?? Date.now);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const baseUrl = (options.baseUrl ?? STAGING_BASE_URL).replace(/\/+$/, "");
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const createRecoveryTimeoutMs =
    options.createRecoveryTimeoutMs ?? CREATE_RECOVERY_TIMEOUT_MS;
  const createRecoveryPollIntervalMs =
    options.createRecoveryPollIntervalMs ?? CREATE_RECOVERY_POLL_INTERVAL_MS;
  const apiKey = options.apiKey.trim();
  const rawSuffix =
    options.suffix ??
    `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  let suffix = "";
  let expectedName = "";
  let agentId: string | null = null;
  let possibleOrphan = false;

  async function request(
    phase: string,
    path: string,
    init: RequestInit = {},
    expectedStatuses: readonly number[] = [200],
    timeoutOverrideMs = Math.min(requestTimeoutMs, CONTROL_REQUEST_TIMEOUT_MS),
  ): Promise<{ status: number; body: JsonObject }> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${apiKey}`);
      headers.set("accept", "application/json");
      headers.set("user-agent", "eliza-managed-dedicated-canary/1.0");
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutOverrideMs),
      });
    } catch {
      throw new CanaryFailure(phase, "request_failed");
    }
    let parsed: unknown = {};
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new CanaryFailure(
        phase,
        `invalid_json_response_http_${response.status}`,
      );
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new CanaryFailure(phase, `unexpected_http_${response.status}`);
    }
    if (!isRecord(parsed)) {
      throw new CanaryFailure(phase, "invalid_response_shape");
    }
    return { status: response.status, body: parsed };
  }

  async function listAgents(phase: string): Promise<JsonObject[]> {
    const { body } = await request(phase, "/api/v1/eliza/agents");
    if (!Array.isArray(body.data) || !body.data.every(isRecord)) {
      throw new CanaryFailure(phase, "invalid_agent_list");
    }
    return body.data;
  }

  async function recoverCreatedAgent(): Promise<boolean> {
    if (agentId) return true;
    const deadline = now() + createRecoveryTimeoutMs;
    let attempts = 0;
    do {
      attempts += 1;
      try {
        const agents = await listAgents("create_recovery");
        const matches = agents.filter(
          (agent) => stringField(agent, "agentName") === expectedName,
        );
        if (matches.length === 1) {
          const recoveredId = stringField(matches[0], "id");
          if (recoveredId) {
            agentId = recoveredId;
            evidence.capacity.createdAgents = 1;
            possibleOrphan = false;
            return true;
          }
        }
        // More than one exact-name match is not safe to guess between. Keep
        // retrying within the same bounded budget in case one is a deleting row.
      } catch {
        // A transient list failure is expected after a timed-out create. Retry
        // within the fixed attempt + wall-clock budget; never hide exhaustion.
      }
      if (attempts >= MAX_CREATE_RECOVERY_ATTEMPTS || now() >= deadline) {
        break;
      }
      await sleep(
        Math.min(createRecoveryPollIntervalMs, Math.max(0, deadline - now())),
      );
    } while (now() <= deadline);
    return false;
  }

  function createFailureMayHaveCommitted(error: unknown): boolean {
    const failure = asFailure(error);
    return (
      failure.phase === "create" &&
      (failure.code === "request_failed" ||
        failure.code === "invalid_response_shape" ||
        failure.code === "missing_agent_id" ||
        /^invalid_json_response_http_[25]\d\d$/.test(failure.code) ||
        /^unexpected_http_5\d\d$/.test(failure.code))
    );
  }

  async function pollJob(
    jobId: string,
    phase: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const { body } = await request(
        phase,
        `/api/v1/jobs/${encodeURIComponent(jobId)}`,
      );
      const data = dataRecord(body);
      const status = stringField(data, "status") ?? "unknown";
      if (status === "completed") return;
      if (TERMINAL_JOB_STATUSES.has(status)) {
        throw new CanaryFailure(phase, "job_failed");
      }
      await sleep(pollIntervalMs);
    }
    throw new CanaryFailure(phase, "job_timeout");
  }

  async function getAgent(
    phase: string,
    expectedStatuses: readonly number[] = [200],
  ): Promise<{ status: number; data: JsonObject | null }> {
    if (!agentId) throw new CanaryFailure(phase, "agent_not_initialized");
    const result = await request(
      phase,
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
      {},
      expectedStatuses,
    );
    return { status: result.status, data: dataRecord(result.body) };
  }

  async function waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const { data } = await getAgent("ready");
      if (!data) throw new CanaryFailure("ready", "missing_agent_data");
      const observedTier = stringField(data, "executionTier");
      const status = stringField(data, "status");
      const databaseStatus = stringField(data, "databaseStatus");
      const lastHeartbeatAt = stringField(data, "lastHeartbeatAt");
      evidence.path.observedTier = privacySafeObservedTier(observedTier);
      evidence.path.running = status === "running";
      evidence.path.databaseReady = databaseStatus === "ready";
      evidence.path.heartbeatFresh = heartbeatIsFresh(lastHeartbeatAt, now());
      evidence.path.meshAddressPresent = hasMeshAddress(data);

      if (observedTier !== EXPECTED_TIER) {
        throw new CanaryFailure("ready", "wrong_execution_tier");
      }
      if (status && TERMINAL_AGENT_FAILURE_STATUSES.has(status)) {
        throw new CanaryFailure("ready", "terminal_agent_state");
      }
      if (
        evidence.path.running &&
        evidence.path.databaseReady &&
        evidence.path.heartbeatFresh &&
        evidence.path.meshAddressPresent
      ) {
        return;
      }
      await sleep(pollIntervalMs);
    }
    throw new CanaryFailure("ready", "readiness_timeout");
  }

  async function jsonRpc(
    phase: string,
    method: string,
    params: JsonObject = {},
    timeoutMs = Math.min(requestTimeoutMs, CONTROL_REQUEST_TIMEOUT_MS),
  ): Promise<JsonObject> {
    if (!agentId) throw new CanaryFailure(phase, "agent_not_initialized");
    const { body } = await request(
      phase,
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/bridge`,
      {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `${method}-${suffix}`,
          method,
          params,
        }),
      },
      [200],
      timeoutMs,
    );
    if (body.error) {
      throw new CanaryFailure(phase, classifyRpcError(body.error));
    }
    if (!isRecord(body.result)) {
      throw new CanaryFailure(phase, "missing_rpc_result");
    }
    return body.result;
  }

  async function proveBridge(): Promise<void> {
    const status = await jsonRpc("bridge_status", "status.get");
    if (status.ready !== true) {
      throw new CanaryFailure("bridge_status", "not_ready");
    }
    const heartbeat = await jsonRpc("bridge_heartbeat", "heartbeat");
    if (heartbeat.ready !== true && heartbeat.ok !== true) {
      throw new CanaryFailure("bridge_heartbeat", "not_ready");
    }
    const token = `bridge-${suffix}`;
    let lastCode = "proof_missing";
    for (let attempt = 0; attempt < MAX_CHAT_ATTEMPTS_PER_PATH; attempt += 1) {
      evidence.capacity.chatRequests += 1;
      const result = await jsonRpc(
        "bridge_turn",
        "message.send",
        {
          text: `Include the token ${token} in one short sentence.`,
          roomId: `canary-bridge-${suffix}`,
          userId: `canary-user-${suffix}`,
          mode: "simple",
        },
        requestTimeoutMs,
      );
      const verdict = classifyBridgeReply(result, token);
      if (verdict.ok && DEDICATED_BRIDGE_TRANSPORTS.has(verdict.transport)) {
        evidence.path.bridgeTransport = verdict.transport;
        evidence.path.successfulPaths += 1;
        return;
      }
      lastCode = verdict.ok ? "non_dedicated_transport" : "invalid_reply";
    }
    throw new CanaryFailure("bridge_turn", lastCode);
  }

  async function streamTurn(token: string): Promise<void> {
    if (!agentId) throw new CanaryFailure("sse", "agent_not_initialized");
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/api/v1/eliza/agents/${encodeURIComponent(agentId)}/stream`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "text/event-stream",
            "content-type": "application/json",
            "user-agent": "eliza-managed-dedicated-canary/1.0",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `stream-${suffix}`,
            method: "message.send",
            params: {
              text: `Include the token ${token} in one short sentence.`,
              roomId: `canary-sse-${suffix}`,
              mode: "simple",
            },
          }),
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );
    } catch {
      throw new CanaryFailure("sse", "request_failed");
    }
    if (!response.ok) {
      throw new CanaryFailure("sse", `unexpected_http_${response.status}`);
    }
    if (!response.body) throw new CanaryFailure("sse", "missing_body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          if (parsed.event === "done") completed = true;
          text += sseText(parsed.event, parsed.data);
        }
        if (completed) break;
      }
    } catch (error) {
      if (error instanceof CanaryFailure) throw error;
      throw new CanaryFailure("sse", "stream_read_failed");
    }
    if (!completed && buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        if (parsed.event === "done") completed = true;
        text += sseText(parsed.event, parsed.data);
      }
    }
    if (!completed) throw new CanaryFailure("sse", "missing_done_event");
    const verdict = classifyBridgeReply({ text }, token);
    if (!verdict.ok) throw new CanaryFailure("sse", "invalid_reply");
  }

  async function proveSse(): Promise<void> {
    const token = `sse-${suffix}`;
    for (let attempt = 0; attempt < MAX_CHAT_ATTEMPTS_PER_PATH; attempt += 1) {
      evidence.capacity.chatRequests += 1;
      try {
        await streamTurn(token);
        evidence.path.sseCompleted = true;
        evidence.path.successfulPaths += 1;
        return;
      } catch (error) {
        if (attempt + 1 >= MAX_CHAT_ATTEMPTS_PER_PATH) throw error;
      }
    }
  }

  async function cleanup(): Promise<void> {
    const finish = timedPhase(evidence, "cleanup", now);
    try {
      if (!agentId) {
        if (possibleOrphan) {
          evidence.cleanup.status = "failed";
          evidence.cleanup.possibleOrphan = true;
          throw new CanaryFailure(
            "cleanup",
            "possible_orphan_after_ambiguous_create",
          );
        }
        evidence.cleanup.status = "not-required";
        evidence.cleanup.possibleOrphan = false;
        return;
      }
      const cleanupDeadline = now() + cleanupTimeoutMs;
      while (now() < cleanupDeadline) {
        const current = await getAgent("cleanup_verify", [200, 404]);
        if (current.status === 404) {
          agentId = null;
          evidence.cleanup.status = "passed";
          evidence.cleanup.possibleOrphan = false;
          return;
        }
        if (!current.data) {
          throw new CanaryFailure("cleanup", "missing_agent_data");
        }
        if (
          stringField(current.data, "id") !== agentId ||
          stringField(current.data, "agentName") !== expectedName
        ) {
          throw new CanaryFailure("cleanup", "identity_mismatch");
        }
        if (stringField(current.data, "status") !== "provisioning") break;
        await sleep(pollIntervalMs);
      }

      const result = await request(
        "cleanup_delete",
        `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
        { method: "DELETE" },
        [200, 202, 404],
      );
      if (result.status === 202) {
        const jobId = stringField(dataRecord(result.body), "jobId");
        if (!jobId) throw new CanaryFailure("cleanup", "missing_delete_job");
        await pollJob(
          jobId,
          "cleanup_job",
          Math.max(1, cleanupDeadline - now()),
        );
      }
      while (now() < cleanupDeadline) {
        const check = await getAgent("cleanup_confirm", [200, 404]);
        if (check.status === 404) {
          agentId = null;
          evidence.cleanup.status = "passed";
          evidence.cleanup.possibleOrphan = false;
          return;
        }
        await sleep(pollIntervalMs);
      }
      throw new CanaryFailure("cleanup", "delete_not_confirmed");
    } finally {
      finish();
    }
  }

  try {
    suffix = sanitizeSuffix(rawSuffix);
    expectedName = `${CANARY_NAME_PREFIX}${suffix}`;
    if (!apiKey) {
      throw new CanaryFailure("config", "missing_cloud_credential");
    }
    if (!isStagingBaseUrl(baseUrl)) {
      throw new CanaryFailure("config", "non_staging_target_refused");
    }

    await inTimedPhase(evidence, "health", now, async () => {
      const health = await request("health", "/api/health", {}, [200]);
      const deployedCommit = stringField(health.body, "commit");
      if (!deployedCommit || !/^[a-f0-9]{40}$/.test(deployedCommit)) {
        throw new CanaryFailure("health", "missing_deploy_commit");
      }
      evidence.deployedCommit = deployedCommit;
    });

    await inTimedPhase(evidence, "capacityGuard", now, async () => {
      const before = await listAgents("capacity_guard");
      if (
        before.some((agent) =>
          (stringField(agent, "agentName") ?? "").startsWith(
            CANARY_NAME_PREFIX,
          ),
        )
      ) {
        throw new CanaryFailure("capacity_guard", "existing_canary_present");
      }
    });

    const createDone = timedPhase(evidence, "create", now);
    let readinessDeadline = now() + readyTimeoutMs;
    try {
      const created = await request(
        "create",
        "/api/v1/eliza/agents",
        {
          method: "POST",
          body: JSON.stringify({
            agentName: expectedName,
            alwaysOn: true,
            forceCreate: true,
            autoProvision: true,
            agentConfig: {
              name: "Managed Dedicated Canary",
              username: expectedName,
              system: "A concise staging canary assistant.",
              bio: ["Managed dedicated staging canary."],
              topics: ["managed dedicated canary"],
              adjectives: ["concise"],
              plugins: [...SMOKE_AGENT_PLUGINS],
              settings: { secrets: {} },
            },
            environmentVars: {
              ELIZA_MANAGED_DEDICATED_CANARY: "1",
            },
          }),
        },
        [201, 202],
      );
      const data = dataRecord(created.body);
      agentId = stringField(data, "id") ?? stringField(data, "agentId");
      if (!agentId) throw new CanaryFailure("create", "missing_agent_id");
      evidence.capacity.createdAgents = 1;
      const observedTier = stringField(data, "executionTier");
      evidence.path.observedTier = privacySafeObservedTier(observedTier);
      if (observedTier !== EXPECTED_TIER) {
        throw new CanaryFailure("create", "wrong_execution_tier");
      }
      const jobId = stringField(data, "jobId");
      readinessDeadline = now() + readyTimeoutMs;
      if (jobId) {
        await pollJob(
          jobId,
          "provision",
          Math.max(1, readinessDeadline - now()),
        );
      }
    } catch (error) {
      if (!agentId && createFailureMayHaveCommitted(error)) {
        possibleOrphan = !(await recoverCreatedAgent());
      }
      throw error;
    } finally {
      createDone();
    }

    await inTimedPhase(evidence, "ready", now, () =>
      waitUntilReady(Math.max(1, readinessDeadline - now())),
    );
    await inTimedPhase(evidence, "bridge", now, proveBridge);
    await inTimedPhase(evidence, "sse", now, proveSse);
  } catch (error) {
    const failure = asFailure(error);
    evidence.failure = { phase: failure.phase, code: failure.code };
  } finally {
    try {
      await cleanup();
    } catch (error) {
      const failure = asFailure(error);
      evidence.cleanup.status = "failed";
      evidence.cleanup.possibleOrphan = possibleOrphan || agentId !== null;
      evidence.failure = { phase: failure.phase, code: failure.code };
    }
    totalDone();
  }

  if (
    !evidence.failure &&
    evidence.path.successfulPaths === 2 &&
    evidence.capacity.createdAgents === 1 &&
    evidence.capacity.chatRequests > 0 &&
    evidence.capacity.chatRequests <= evidence.capacity.maxChatRequests &&
    evidence.cleanup.status === "passed"
  ) {
    evidence.verdict = "pass";
  }
  return evidence;
}

async function main(): Promise<void> {
  const githubRunId = workflowEnv("GITHUB_RUN_ID");
  const githubRunAttempt = workflowEnv("GITHUB_RUN_ATTEMPT");
  const evidencePath =
    workflowEnv("CLOUD_DEDICATED_CANARY_EVIDENCE_PATH") ??
    "/tmp/managed-dedicated-canary-evidence.json";
  const evidence = await runManagedDedicatedCanary({
    apiKey: workflowEnv("ELIZAOS_CLOUD_API_KEY") ?? "",
    baseUrl: workflowEnv("CLOUD_DEDICATED_CANARY_BASE_URL"),
    suffix:
      githubRunId && githubRunAttempt
        ? `r${githubRunId}a${githubRunAttempt}`
        : undefined,
  });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

  // Keep stdout privacy-safe and compact. The artifact contains the exact
  // timing/path fields; no raw request or model data is ever printed.
  console.log(
    `[dedicated-canary] verdict=${evidence.verdict} paths=${evidence.path.successfulPaths}/2 cleanup=${evidence.cleanup.status} possibleOrphan=${evidence.cleanup.possibleOrphan}`,
  );
  if (evidence.verdict !== "pass") process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
