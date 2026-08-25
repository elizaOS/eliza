#!/usr/bin/env bun
/**
 * Runs the canonical staging-only shared-agent onboarding smoke.
 *
 * The smoke uses an existing isolated staging credential, creates exactly one
 * fresh shared agent, proves the JSON-RPC bridge and SSE paths with per-run
 * nonces, asserts that shared agents deliberately have no pairing Web UI, and
 * conditionally deletes only the identity it created. Production origins,
 * idempotent reuse, dedicated tiers, retained resources, and green-by-skip
 * results are all rejected.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyBridgeReply } from "./bridge-reply-verdict";
import { SMOKE_AGENT_PLUGINS } from "./smoke-agent-plugins";

type JsonObject = Record<string, unknown>;
type Fetch = typeof globalThis.fetch;
type AgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";
type ObservedTier = AgentExecutionTier | "other";
type TimingPhase =
  | "preflight"
  | "create"
  | "provision"
  | "bridge"
  | "sse"
  | "pairing"
  | "cleanup"
  | "total";

const STAGING_BASE_URL = "https://api-staging.eliza.app";
const SMOKE_NAME_PREFIX = "shared-staging-smoke-";
const EXPECTED_TIER = "shared";
const REQUEST_TIMEOUT_MS = 130_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const TOTAL_TIMEOUT_MS = 14 * 60_000;
const CLEANUP_RESERVE_MS = 3 * 60_000;
const CREATE_RECOVERY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_CREATE_RECOVERY_ATTEMPTS = 4;
const MAX_CHAT_ATTEMPTS_PER_PATH = 15;
const TERMINAL_JOB_STATUSES = new Set(["failed", "cancelled", "canceled"]);
const SHARED_RUNTIME_WARMING_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
]);

interface JsonResponse {
  status: number;
  body: JsonObject;
  retryAfterMs: number | null;
}

interface AgentIdentity {
  id: string;
  name: string;
  createdAt: string;
  executionTier: AgentExecutionTier;
}

/** Privacy-safe result uploaded by the manual staging workflow. */
export interface SharedStagingSmokeEvidence {
  schemaVersion: 1;
  verdict: "pass" | "fail";
  deployedCommit: string | null;
  path: {
    requestedTier: "shared";
    observedTier: ObservedTier | null;
    credentialPreflight: boolean;
    freshCreate: boolean;
    immediateProvision: boolean;
    bridgeTransport: "shared-runtime" | null;
    bridgeReply: boolean;
    sseCompleted: boolean;
    pairingUnavailable: boolean;
    successfulPaths: number;
  };
  capacity: {
    maxCreatedAgents: 1;
    createdAgents: number;
    maxChatRequests: number;
    chatRequests: number;
    isolatedCredential: boolean;
  };
  cleanup: {
    status: "not-required" | "passed" | "failed";
    possibleOrphan: boolean;
  };
  timingsMs: Partial<Record<TimingPhase, number>>;
  failure: { phase: string; code: string } | null;
}

/** Dependency injection is limited to deterministic contract testing. */
export interface SharedStagingSmokeOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  suffix?: string;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  totalTimeoutMs?: number;
  cleanupReserveMs?: number;
  createRecoveryTimeoutMs?: number;
  pollIntervalMs?: number;
}

class SharedSmokeFailure extends Error {
  constructor(
    readonly phase: string,
    readonly code: string,
  ) {
    super(`${phase}:${code}`);
    this.name = "SharedSmokeFailure";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This CLI is workflow-owned and never runs as a cached Turbo task. */
function workflowEnv(name: string): string | undefined {
  return process.env[name];
}

function stringField(value: JsonObject | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function dataRecord(body: JsonObject): JsonObject | null {
  return isRecord(body.data) ? body.data : null;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function isSharedRuntimeWarming(response: JsonResponse): boolean {
  const code = response.body.code;
  return (
    response.status === 503 &&
    response.body.retryable === true &&
    typeof code === "string" &&
    SHARED_RUNTIME_WARMING_CODES.has(code)
  );
}

function asExecutionTier(value: string | null): AgentExecutionTier | null {
  switch (value) {
    case "shared":
    case "dedicated-lazy":
    case "dedicated-always":
    case "custom":
      return value;
    default:
      return null;
  }
}

function privacySafeTier(value: string | null): ObservedTier | null {
  return asExecutionTier(value) ?? (value === null ? null : "other");
}

function validCreatedAt(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function parseIdentity(value: JsonObject | null): AgentIdentity | null {
  const id = stringField(value, "id") ?? stringField(value, "agentId");
  const name = stringField(value, "agentName");
  const createdAt = stringField(value, "createdAt");
  const executionTier = asExecutionTier(stringField(value, "executionTier"));
  if (!id || !name || !validCreatedAt(createdAt) || !executionTier) return null;
  return { id, name, createdAt, executionTier };
}

function identityMatches(value: JsonObject | null, expected: AgentIdentity) {
  const identity = parseIdentity(value);
  return (
    identity !== null &&
    identity.id === expected.id &&
    identity.name === expected.name &&
    identity.createdAt === expected.createdAt &&
    identity.executionTier === expected.executionTier
  );
}

/** Only this exact origin is authorized; even path/query variants fail closed. */
export function isExactSharedSmokeStagingOrigin(value: string): boolean {
  return value === STAGING_BASE_URL;
}

function sanitizeSuffix(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24);
  if (normalized.length < 8) {
    throw new SharedSmokeFailure("config", "invalid_run_suffix");
  }
  return normalized;
}

function freshEvidence(): SharedStagingSmokeEvidence {
  return {
    schemaVersion: 1,
    verdict: "fail",
    deployedCommit: null,
    path: {
      requestedTier: EXPECTED_TIER,
      observedTier: null,
      credentialPreflight: false,
      freshCreate: false,
      immediateProvision: false,
      bridgeTransport: null,
      bridgeReply: false,
      sseCompleted: false,
      pairingUnavailable: false,
      successfulPaths: 0,
    },
    capacity: {
      maxCreatedAgents: 1,
      createdAgents: 0,
      maxChatRequests: MAX_CHAT_ATTEMPTS_PER_PATH * 2,
      chatRequests: 0,
      isolatedCredential: false,
    },
    cleanup: { status: "not-required", possibleOrphan: false },
    timingsMs: {},
    failure: null,
  };
}

function asFailure(error: unknown): SharedSmokeFailure {
  return error instanceof SharedSmokeFailure
    ? error
    : new SharedSmokeFailure("internal", "unexpected_error");
}

function timedPhase(
  evidence: SharedStagingSmokeEvidence,
  phase: TimingPhase,
  now: () => number,
): () => void {
  const started = now();
  return () => {
    evidence.timingsMs[phase] = Math.max(0, Math.round(now() - started));
  };
}

async function inTimedPhase<T>(
  evidence: SharedStagingSmokeEvidence,
  phase: TimingPhase,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const finish = timedPhase(evidence, phase, now);
  try {
    return await operation();
  } finally {
    finish();
  }
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
    // error-policy:J3 Plain SSE data is valid text, never fabricated JSON.
    return { event, data: { text: value } };
  }
}

function sseText(event: string, data: JsonObject | null): string {
  if (!data || event === "done") return "";
  if (event === "error") {
    throw new SharedSmokeFailure("sse", "error_event");
  }
  for (const key of ["text", "chunk", "content"] as const) {
    const value = data[key];
    if (typeof value === "string") return value;
    if (isRecord(value) && typeof value.text === "string") return value.text;
  }
  return "";
}

function createFailureMayHaveCommitted(error: unknown): boolean {
  const failure = asFailure(error);
  return (
    failure.phase === "create" &&
    (failure.code === "request_failed" ||
      failure.code === "invalid_create_contract" ||
      failure.code === "missing_created_identity" ||
      /^invalid_json_response_http_[25]\d\d$/.test(failure.code) ||
      /^invalid_response_shape_http_[25]\d\d$/.test(failure.code) ||
      /^unexpected_http_2\d\d$/.test(failure.code) ||
      /^unexpected_http_5\d\d$/.test(failure.code) ||
      failure.code === "redirect_refused")
  );
}

/**
 * Exercises the complete shared onboarding contract without ever selecting a
 * dedicated tier. All failures are reduced to privacy-safe phase/code pairs;
 * exact identifiers remain process-local solely for conditional cleanup.
 */
export async function runSharedStagingOnboardingSmoke(
  options: SharedStagingSmokeOptions,
): Promise<SharedStagingSmokeEvidence> {
  const evidence = freshEvidence();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? STAGING_BASE_URL;
  const apiKey = options.apiKey.trim();
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const cleanupReserveMs = options.cleanupReserveMs ?? CLEANUP_RESERVE_MS;
  const createRecoveryTimeoutMs =
    options.createRecoveryTimeoutMs ?? CREATE_RECOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const rawSuffix =
    options.suffix ??
    `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  const totalDone = timedPhase(evidence, "total", now);
  const startedAt = now();
  const totalDeadline = startedAt + totalTimeoutMs;
  const operationDeadline = totalDeadline - cleanupReserveMs;

  let suffix = "";
  let expectedName = "";
  let identity: AgentIdentity | null = null;
  let possibleOrphan = false;

  function remainingMs(deadline: number, phase: string): number {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new SharedSmokeFailure(phase, "absolute_deadline_exceeded");
    }
    return remaining;
  }

  async function sleepWithin(
    phase: string,
    requestedMs: number,
    deadline = operationDeadline,
  ): Promise<void> {
    await sleep(Math.min(requestedMs, remainingMs(deadline, phase)));
  }

  async function request(
    phase: string,
    path: string,
    init: RequestInit = {},
    expectedStatuses: readonly number[] = [200],
    timeoutMs = requestTimeoutMs,
    deadline = operationDeadline,
  ): Promise<JsonResponse> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", "eliza-shared-staging-smoke/1.0");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal:
          init.signal ??
          AbortSignal.timeout(
            Math.min(timeoutMs, remainingMs(deadline, phase)),
          ),
      });
    } catch {
      throw new SharedSmokeFailure(phase, "request_failed");
    }
    if (response.redirected) {
      throw new SharedSmokeFailure(phase, "redirect_refused");
    }
    if (response.url && new URL(response.url).origin !== STAGING_BASE_URL) {
      throw new SharedSmokeFailure(phase, "redirect_refused");
    }

    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new SharedSmokeFailure(
        phase,
        `invalid_json_response_http_${response.status}`,
      );
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new SharedSmokeFailure(phase, `unexpected_http_${response.status}`);
    }
    if (!isRecord(parsed)) {
      throw new SharedSmokeFailure(
        phase,
        `invalid_response_shape_http_${response.status}`,
      );
    }
    return {
      status: response.status,
      body: parsed,
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    };
  }

  async function requestStream(
    path: string,
    body: string,
  ): Promise<Response | JsonResponse> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "text/event-stream",
          "content-type": "application/json",
          "user-agent": "eliza-shared-staging-smoke/1.0",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.min(requestTimeoutMs, remainingMs(operationDeadline, "sse")),
        ),
      });
    } catch {
      throw new SharedSmokeFailure("sse", "request_failed");
    }
    if (response.redirected) {
      throw new SharedSmokeFailure("sse", "redirect_refused");
    }
    if (response.url && new URL(response.url).origin !== STAGING_BASE_URL) {
      throw new SharedSmokeFailure("sse", "redirect_refused");
    }
    if (response.status !== 200) {
      let parsed: unknown;
      try {
        const text = await response.text();
        parsed = text ? JSON.parse(text) : {};
      } catch {
        // error-policy:J3 Untrusted SSE responses fail closed on malformed JSON.
        throw new SharedSmokeFailure(
          "sse",
          `invalid_json_response_http_${response.status}`,
        );
      }
      if (!isRecord(parsed)) {
        throw new SharedSmokeFailure(
          "sse",
          `invalid_response_shape_http_${response.status}`,
        );
      }
      return {
        status: response.status,
        body: parsed,
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      };
    }
    if (!response.body) throw new SharedSmokeFailure("sse", "missing_body");
    return response;
  }

  async function listAgents(phase: string): Promise<JsonObject[]> {
    const { body } = await request(phase, "/api/v1/eliza/agents");
    if (!Array.isArray(body.data) || !body.data.every(isRecord)) {
      throw new SharedSmokeFailure(phase, "invalid_agent_list");
    }
    return body.data;
  }

  async function recoverAmbiguousCreate(): Promise<boolean> {
    const deadline = Math.min(
      now() + createRecoveryTimeoutMs,
      operationDeadline,
    );
    let attempts = 0;
    do {
      attempts += 1;
      try {
        const matches = (await listAgents("create_recovery")).filter(
          (agent) => stringField(agent, "agentName") === expectedName,
        );
        if (matches.length === 1) {
          const recovered = parseIdentity(matches[0]);
          if (recovered && recovered.name === expectedName) {
            identity = recovered;
            evidence.capacity.createdAgents = 1;
            evidence.path.observedTier = privacySafeTier(
              recovered.executionTier,
            );
            possibleOrphan = false;
            return true;
          }
        }
      } catch {
        // error-policy:J6 Recovery is bounded and cleanup reports exhaustion.
      }
      if (attempts >= MAX_CREATE_RECOVERY_ATTEMPTS || now() >= deadline) {
        break;
      }
      await sleepWithin("create_recovery", pollIntervalMs, deadline);
    } while (now() <= deadline);
    possibleOrphan = true;
    return false;
  }

  async function jsonRpc(
    phase: string,
    method: string,
    params: JsonObject = {},
  ): Promise<JsonResponse> {
    if (!identity) {
      throw new SharedSmokeFailure(phase, "agent_not_initialized");
    }
    return request(
      phase,
      `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}/bridge`,
      {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `${method}-${suffix}`,
          method,
          params,
        }),
      },
      [200, 503],
    );
  }

  function rpcResult(response: JsonResponse, phase: string): JsonObject {
    if (response.status !== 200) {
      throw new SharedSmokeFailure(phase, `unexpected_http_${response.status}`);
    }
    const { body } = response;
    if (body.error !== undefined) {
      throw new SharedSmokeFailure(phase, "rpc_error");
    }
    if (!isRecord(body.result)) {
      throw new SharedSmokeFailure(phase, "missing_rpc_result");
    }
    return body.result;
  }

  async function proveBridge(): Promise<void> {
    const token = `shared-bridge-${suffix}`;
    let lastFailure = new SharedSmokeFailure("bridge", "invalid_shared_reply");
    for (let attempt = 0; attempt < MAX_CHAT_ATTEMPTS_PER_PATH; attempt += 1) {
      evidence.capacity.chatRequests += 1;
      try {
        const response = await jsonRpc("bridge", "message.send", {
          text: `Include the token ${token} in one short sentence.`,
          roomId: `shared-smoke-bridge-${suffix}`,
          userId: `shared-smoke-user-${suffix}`,
          mode: "simple",
        });
        if (isSharedRuntimeWarming(response)) {
          lastFailure = new SharedSmokeFailure(
            "bridge",
            `unexpected_http_${response.status}`,
          );
          if (attempt + 1 < MAX_CHAT_ATTEMPTS_PER_PATH) {
            await sleepWithin(
              "bridge",
              response.retryAfterMs ?? pollIntervalMs,
            );
            continue;
          }
          break;
        }
        const verdict = classifyBridgeReply(
          rpcResult(response, "bridge"),
          token,
        );
        if (verdict.ok && verdict.transport === "shared-runtime") {
          evidence.path.bridgeTransport = "shared-runtime";
          evidence.path.bridgeReply = true;
          evidence.path.successfulPaths += 1;
          return;
        }
        lastFailure = new SharedSmokeFailure("bridge", "invalid_shared_reply");
      } catch (error) {
        lastFailure = asFailure(error);
      }
      break;
    }
    throw lastFailure;
  }

  async function streamTurn(token: string): Promise<JsonResponse | null> {
    if (!identity) {
      throw new SharedSmokeFailure("sse", "agent_not_initialized");
    }
    const response = await requestStream(
      `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}/stream`,
      JSON.stringify({
        jsonrpc: "2.0",
        id: `stream-${suffix}`,
        method: "message.send",
        params: {
          text: `Include the token ${token} in one short sentence.`,
          roomId: `shared-smoke-sse-${suffix}`,
          mode: "simple",
        },
      }),
    );
    if (!(response instanceof Response)) {
      if (isSharedRuntimeWarming(response)) return response;
      throw new SharedSmokeFailure("sse", `unexpected_http_${response.status}`);
    }
    const stream = response.body;
    if (!stream) throw new SharedSmokeFailure("sse", "missing_body");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = "";
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
          reply += sseText(parsed.event, parsed.data);
        }
        if (completed) break;
      }
    } catch (error) {
      if (error instanceof SharedSmokeFailure) throw error;
      throw new SharedSmokeFailure("sse", "stream_read_failed");
    }
    if (!completed && buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        if (parsed.event === "done") completed = true;
        reply += sseText(parsed.event, parsed.data);
      }
    }
    if (!completed) throw new SharedSmokeFailure("sse", "missing_done_event");
    const verdict = classifyBridgeReply({ text: reply }, token);
    if (!verdict.ok) {
      throw new SharedSmokeFailure("sse", "invalid_shared_reply");
    }
    return null;
  }

  async function proveSse(): Promise<void> {
    const token = `shared-sse-${suffix}`;
    for (let attempt = 0; attempt < MAX_CHAT_ATTEMPTS_PER_PATH; attempt += 1) {
      evidence.capacity.chatRequests += 1;
      const warming = await streamTurn(token);
      if (warming) {
        if (attempt + 1 < MAX_CHAT_ATTEMPTS_PER_PATH) {
          await sleepWithin("sse", warming.retryAfterMs ?? pollIntervalMs);
          continue;
        }
        throw new SharedSmokeFailure(
          "sse",
          `unexpected_http_${warming.status}`,
        );
      }
      evidence.path.sseCompleted = true;
      evidence.path.successfulPaths += 1;
      return;
    }
  }

  async function pollDeleteJob(jobId: string, deadline: number): Promise<void> {
    while (now() < deadline) {
      const { body } = await request(
        "cleanup_job",
        `/api/v1/jobs/${encodeURIComponent(jobId)}`,
        {},
        [200],
        requestTimeoutMs,
        deadline,
      );
      const status = stringField(dataRecord(body), "status") ?? "unknown";
      if (status === "completed") return;
      if (TERMINAL_JOB_STATUSES.has(status)) {
        throw new SharedSmokeFailure("cleanup_job", "delete_job_failed");
      }
      await sleepWithin("cleanup_job", pollIntervalMs, deadline);
    }
    throw new SharedSmokeFailure("cleanup_job", "delete_job_timeout");
  }

  async function cleanup(): Promise<void> {
    const finish = timedPhase(evidence, "cleanup", now);
    try {
      if (!identity) {
        if (possibleOrphan) {
          evidence.cleanup.status = "failed";
          evidence.cleanup.possibleOrphan = true;
          throw new SharedSmokeFailure(
            "cleanup",
            "possible_orphan_after_ambiguous_create",
          );
        }
        evidence.cleanup.status = "not-required";
        evidence.cleanup.possibleOrphan = false;
        return;
      }

      const deadline = Math.min(now() + cleanupTimeoutMs, totalDeadline);
      const current = await request(
        "cleanup_verify",
        `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}`,
        {},
        [200, 404],
        requestTimeoutMs,
        deadline,
      );
      if (current.status === 404) {
        throw new SharedSmokeFailure(
          "cleanup_verify",
          "created_agent_missing_before_delete",
        );
      }
      if (!identityMatches(dataRecord(current.body), identity)) {
        throw new SharedSmokeFailure("cleanup_verify", "identity_mismatch");
      }

      const deletion = await request(
        "cleanup_delete",
        `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expectedAgentName: identity.name,
            expectedCreatedAt: identity.createdAt,
            expectedExecutionTier: identity.executionTier,
          }),
        },
        [200, 202],
        requestTimeoutMs,
        deadline,
      );
      if (deletion.status === 200) {
        const data = dataRecord(deletion.body);
        if (
          deletion.body.success !== true ||
          deletion.body.deleted !== true ||
          deletion.body.source !== "shared_runtime" ||
          stringField(data, "agentId") !== identity.id ||
          stringField(data, "status") !== "deleted" ||
          stringField(data, "executionTier") !== identity.executionTier
        ) {
          throw new SharedSmokeFailure(
            "cleanup_delete",
            "invalid_sync_delete_contract",
          );
        }
      } else {
        const jobId = stringField(dataRecord(deletion.body), "jobId");
        if (!jobId) {
          throw new SharedSmokeFailure("cleanup_delete", "missing_delete_job");
        }
        await pollDeleteJob(jobId, deadline);
      }

      while (now() < deadline) {
        const confirmation = await request(
          "cleanup_confirm",
          `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}`,
          {},
          [200, 404],
          requestTimeoutMs,
          deadline,
        );
        if (confirmation.status === 404) {
          identity = null;
          evidence.cleanup.status = "passed";
          evidence.cleanup.possibleOrphan = false;
          return;
        }
        if (!identityMatches(dataRecord(confirmation.body), identity)) {
          throw new SharedSmokeFailure("cleanup_confirm", "identity_mismatch");
        }
        await sleepWithin("cleanup_confirm", pollIntervalMs, deadline);
      }
      throw new SharedSmokeFailure("cleanup_confirm", "final_404_not_observed");
    } finally {
      finish();
    }
  }

  try {
    suffix = sanitizeSuffix(rawSuffix);
    expectedName = `${SMOKE_NAME_PREFIX}${suffix}`;
    if (!apiKey) {
      throw new SharedSmokeFailure("config", "missing_cloud_credential");
    }
    if (!isExactSharedSmokeStagingOrigin(baseUrl)) {
      throw new SharedSmokeFailure("config", "non_staging_target_refused");
    }

    await inTimedPhase(evidence, "preflight", now, async () => {
      const health = await request("preflight", "/api/health");
      const commit = stringField(health.body, "commit");
      if (!commit || !/^[a-f0-9]{40}$/.test(commit)) {
        throw new SharedSmokeFailure("preflight", "missing_deploy_commit");
      }
      evidence.deployedCommit = commit;

      const existingAgents = await listAgents("preflight");
      if (existingAgents.length !== 0) {
        throw new SharedSmokeFailure("preflight", "credential_not_isolated");
      }
      evidence.path.credentialPreflight = true;
      evidence.capacity.isolatedCredential = true;
    });

    await inTimedPhase(evidence, "create", now, async () => {
      try {
        const created = await request(
          "create",
          "/api/v1/eliza/agents",
          {
            method: "POST",
            body: JSON.stringify({
              agentName: expectedName,
              autoProvision: false,
              agentConfig: {
                name: "Shared Staging Smoke",
                username: expectedName,
                system: "A concise staging smoke assistant.",
                bio: ["Shared staging onboarding smoke."],
                topics: ["shared staging onboarding"],
                adjectives: ["concise"],
                plugins: [...SMOKE_AGENT_PLUGINS],
                settings: { secrets: {} },
              },
              environmentVars: {
                ELIZA_SHARED_STAGING_SMOKE: "1",
              },
            }),
          },
          [200, 201],
        );
        const createdData = dataRecord(created.body);
        const parsedIdentity = parseIdentity(createdData);
        if (created.body.created === false) {
          throw new SharedSmokeFailure("create", "fresh_create_required");
        }
        if (created.body.created !== true) {
          throw new SharedSmokeFailure("create", "invalid_create_contract");
        }
        // A response that explicitly says it created a row is cleanup-owned
        // even if the HTTP status/source later drift from the required
        // contract. Idempotent `created:false` responses remain untouchable.
        if (parsedIdentity) {
          identity = parsedIdentity;
          evidence.capacity.createdAgents = 1;
          evidence.path.observedTier = privacySafeTier(
            parsedIdentity.executionTier,
          );
        } else {
          possibleOrphan = true;
          throw new SharedSmokeFailure("create", "missing_created_identity");
        }
        if (parsedIdentity.name !== expectedName) {
          throw new SharedSmokeFailure("create", "created_name_mismatch");
        }

        if (
          created.status !== 201 ||
          created.body.success !== true ||
          created.body.created !== true ||
          created.body.source !== "shared_runtime" ||
          !identity
        ) {
          throw new SharedSmokeFailure("create", "fresh_create_required");
        }
        if (identity.executionTier !== EXPECTED_TIER) {
          throw new SharedSmokeFailure("create", "wrong_execution_tier");
        }
        evidence.path.freshCreate = true;
      } catch (error) {
        if (!identity && createFailureMayHaveCommitted(error)) {
          await recoverAmbiguousCreate();
        }
        throw error;
      }
    });

    await inTimedPhase(evidence, "provision", now, async () => {
      if (!identity) {
        throw new SharedSmokeFailure("provision", "agent_not_initialized");
      }
      const provisioned = await request(
        "provision",
        `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}/provision`,
        { method: "POST" },
      );
      const data = dataRecord(provisioned.body);
      if (
        provisioned.body.success !== true ||
        provisioned.body.source !== "shared_runtime" ||
        stringField(data, "id") !== identity.id ||
        stringField(data, "agentName") !== identity.name ||
        stringField(data, "status") !== "running" ||
        stringField(data, "executionTier") !== EXPECTED_TIER
      ) {
        throw new SharedSmokeFailure(
          "provision",
          "invalid_immediate_shared_contract",
        );
      }

      const detail = await request(
        "provision",
        `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}`,
      );
      const detailData = dataRecord(detail.body);
      if (
        !identityMatches(detailData, identity) ||
        stringField(detailData, "status") !== "running"
      ) {
        throw new SharedSmokeFailure("provision", "identity_mismatch");
      }
      evidence.path.immediateProvision = true;
    });

    await inTimedPhase(evidence, "bridge", now, proveBridge);
    await inTimedPhase(evidence, "sse", now, proveSse);

    await inTimedPhase(evidence, "pairing", now, async () => {
      if (!identity) {
        throw new SharedSmokeFailure("pairing", "agent_not_initialized");
      }
      const pairing = await request(
        "pairing",
        `/api/v1/eliza/agents/${encodeURIComponent(identity.id)}/pairing-token`,
        { method: "POST" },
        [503],
      );
      if (
        pairing.body.success !== false ||
        pairing.body.code !== "AGENT_WEB_UI_NOT_READY"
      ) {
        throw new SharedSmokeFailure(
          "pairing",
          "invalid_shared_pairing_contract",
        );
      }
      evidence.path.pairingUnavailable = true;
    });
  } catch (error) {
    const failure = asFailure(error);
    evidence.failure = { phase: failure.phase, code: failure.code };
  } finally {
    try {
      await cleanup();
    } catch (error) {
      // Cleanup is authoritative: an unconfirmed retained resource is more
      // important than the operation failure that led to teardown.
      const failure = asFailure(error);
      evidence.cleanup.status = "failed";
      evidence.cleanup.possibleOrphan = possibleOrphan || identity !== null;
      evidence.failure = { phase: failure.phase, code: failure.code };
    }
    totalDone();
  }

  if (
    evidence.failure === null &&
    evidence.path.credentialPreflight &&
    evidence.path.freshCreate &&
    evidence.path.immediateProvision &&
    evidence.path.bridgeReply &&
    evidence.path.sseCompleted &&
    evidence.path.pairingUnavailable &&
    evidence.path.successfulPaths === 2 &&
    evidence.capacity.createdAgents === 1 &&
    evidence.capacity.isolatedCredential &&
    evidence.capacity.chatRequests >= 2 &&
    evidence.capacity.chatRequests <= evidence.capacity.maxChatRequests &&
    evidence.cleanup.status === "passed" &&
    !evidence.cleanup.possibleOrphan
  ) {
    evidence.verdict = "pass";
  }
  return evidence;
}

async function main(): Promise<void> {
  const githubRunId = workflowEnv("GITHUB_RUN_ID")?.trim();
  const githubRunAttempt = workflowEnv("GITHUB_RUN_ATTEMPT")?.trim();
  const evidencePath =
    workflowEnv("CLOUD_SHARED_STAGING_SMOKE_EVIDENCE_PATH")?.trim() ||
    "/tmp/shared-staging-smoke-evidence.json";
  const evidence = await runSharedStagingOnboardingSmoke({
    apiKey: workflowEnv("ELIZAOS_CLOUD_API_KEY") ?? "",
    baseUrl: workflowEnv("CLOUD_SMOKE_BASE_URL"),
    suffix:
      githubRunId && githubRunAttempt
        ? `r${githubRunId}a${githubRunAttempt}`
        : undefined,
  });
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log(
    `[shared-staging-smoke] verdict=${evidence.verdict} paths=${evidence.path.successfulPaths}/2 pairing-negative=${evidence.path.pairingUnavailable} cleanup=${evidence.cleanup.status} possible-orphan=${evidence.cleanup.possibleOrphan}`,
  );
  if (evidence.verdict !== "pass") process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
