/**
 * Authenticated loopback HTTP boundary for the subscription gateway. Distinct
 * bearer credentials bind requests to fair-scheduler harness lanes by default.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { type AuditSink, InMemoryAuditStore } from "./audit.js";
import {
  canonicalizeChatCompletion,
  GatewayRequestError,
  normalizedToolChoiceLabel,
  stableJson,
} from "./canonical.js";
import {
  buildGatewayContentAttestation,
  gatewayContentAttestationViolation,
} from "./content-attestation.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeCompletionError,
  ClaudeRateLimitError,
  ClaudeSdkCompletionRunner,
} from "./claude-completion.js";
import { FairHarnessQueue, QueueCapacityError } from "./fair-queue.js";
import {
  LogicalRequestAllocator,
  type LogicalRequest,
} from "./logical-request.js";
import { ReplayJournal, ReplayMismatchError } from "./replay-journal.js";
import type {
  ClaudeCompletionResult,
  CompletionFinishReason,
  CompletionRunner,
  GatewayAuditRecord,
  GatewayContentAttestation,
  GatewayContentContract,
  GatewayProvenance,
  JsonObject,
} from "./types.js";

const DEFAULT_HARNESSES = ["eliza", "hermes", "openclaw"] as const;
const SUBSCRIPTION_MODEL_CATALOG = Object.freeze([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-8",
  "claude-sonnet-4-20250514",
  "claude-opus-4-1-20250805",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const SAFE_HARNESS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIN_TOKEN_LENGTH = 32;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface GatewayLogger {
  error(
    message: string,
    context: Record<string, string | number | boolean | null>,
  ): void;
}

export interface StartClaudeSubscriptionGatewayOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  harnesses?: readonly string[];
  harnessTokens?: Readonly<Record<string, string>>;
  fallbackToken?: string;
  completionRunner?: CompletionRunner;
  queue?: FairHarnessQueue;
  auditStore?: InMemoryAuditStore;
  auditSink?: AuditSink;
  maxBodyBytes?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  requestIdFactory?: () => string;
  benchmarkNamespace?: string;
  replayJournal?: ReplayJournal;
  storageGuard?: GatewayStorageGuard;
  logger?: GatewayLogger;
  contentContract?: GatewayContentContract;
}

export interface GatewayStorageGuard {
  assertReady(): void | Promise<void>;
}

export class GatewayStorageError extends Error {
  readonly code = "insufficient_storage";
  readonly statusCode = 507;

  constructor() {
    super("The benchmark storage reserve is below its required threshold.");
    this.name = "GatewayStorageError";
  }
}

export interface GatewayHarnessEnvironment {
  CLAUDE_SUBSCRIPTION_GATEWAY_URL: string;
  CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN: string;
  BENCHMARK_BASE_URL: string;
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  BENCHMARK_MODEL_PROVIDER: "claude-subscription";
  BENCHMARK_HARNESS: string;
  ELIZA_BENCH_HARNESS: string;
}

export interface ClaudeSubscriptionGatewayHandle {
  readonly origin: string;
  readonly baseUrl: string;
  readonly healthUrl: string;
  readonly harnessTokens: Readonly<Record<string, string>>;
  readonly auditStore: InMemoryAuditStore;
  envForHarness(harness: string): GatewayHarnessEnvironment;
  close(): Promise<void>;
}

interface GatewayRuntime {
  host: "127.0.0.1" | "::1";
  completionRunner: CompletionRunner;
  queue: FairHarnessQueue;
  auditStore: InMemoryAuditStore;
  auditSink: AuditSink;
  tokenToHarness: ReadonlyMap<string, string>;
  harnessTokens: Readonly<Record<string, string>>;
  fallbackToken: string | null;
  maxBodyBytes: number;
  now: () => Date;
  monotonicNow: () => number;
  logicalAllocator: LogicalRequestAllocator;
  replayJournal: ReplayJournal | null;
  storageGuard: GatewayStorageGuard | null;
  pauseLatch: ClaudeRateLimitError | GatewayStorageError | null;
  logger: GatewayLogger;
  contentContract: GatewayContentContract | null;
}

class PayloadTooLargeError extends Error {
  readonly code = "request_body_too_large";
  readonly statusCode = 413;

  constructor() {
    super("Request body exceeds the gateway limit.");
    this.name = "PayloadTooLargeError";
  }
}

class AuthenticationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function startClaudeSubscriptionGateway(
  options: StartClaudeSubscriptionGatewayOptions = {},
): Promise<ClaudeSubscriptionGatewayHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "[ClaudeSubscriptionGateway] only loopback bind addresses are allowed",
    );
  }
  const harnessTokens = resolveHarnessTokens(options);
  const tokenToHarness = new Map<string, string>();
  for (const [harness, token] of Object.entries(harnessTokens)) {
    if (
      [...tokenToHarness.keys()].some((candidate) =>
        secureEquals(candidate, token),
      )
    ) {
      throw new Error(
        "[ClaudeSubscriptionGateway] harness bearer tokens must be unique",
      );
    }
    tokenToHarness.set(token, harness);
  }
  const fallbackToken = options.fallbackToken ?? null;
  if (fallbackToken !== null) validateToken(fallbackToken, "fallbackToken");
  const auditStore = options.auditStore ?? new InMemoryAuditStore();
  const runtime: GatewayRuntime = {
    host,
    completionRunner:
      options.completionRunner ?? new ClaudeSdkCompletionRunner(),
    queue: options.queue ?? new FairHarnessQueue(),
    auditStore,
    auditSink: options.auditSink ?? auditStore,
    tokenToHarness,
    harnessTokens,
    fallbackToken,
    maxBodyBytes: positiveInteger(
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      "maxBodyBytes",
    ),
    now: options.now ?? (() => new Date()),
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
    logicalAllocator: new LogicalRequestAllocator(
      options.benchmarkNamespace ?? "default",
    ),
    replayJournal: options.replayJournal ?? null,
    storageGuard: options.storageGuard ?? null,
    pauseLatch: null,
    logger: options.logger ?? { error: () => undefined },
    contentContract: options.contentContract ?? null,
  };
  const server = createServer((request, response) => {
    void handleRequest(runtime, request, response).catch((error: unknown) => {
      // error-policy:J1 HTTP is the process boundary; translate every uncaught
      // failure into a redacted OpenAI error without leaking request/provider data.
      runtime.logger.error(
        "[ClaudeSubscriptionGateway] request boundary failed",
        {
          code: safeErrorCode(error),
          statusCode: safeStatusCode(error),
        },
      );
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.end();
      }
    });
  });
  const port = options.port ?? 0;
  await listen(server, port, host);
  const address = server.address();
  if (typeof address === "string" || address === null) {
    await closeServer(server);
    throw new Error(
      "[ClaudeSubscriptionGateway] server did not expose a TCP address",
    );
  }
  const originHost = host === "::1" ? "[::1]" : host;
  const origin = `http://${originHost}:${(address as AddressInfo).port}`;
  return {
    origin,
    baseUrl: `${origin}/v1`,
    healthUrl: `${origin}/health`,
    harnessTokens,
    auditStore,
    envForHarness(harness: string): GatewayHarnessEnvironment {
      const normalized = normalizeHarness(harness);
      const token = harnessTokens[normalized];
      if (!token) {
        throw new Error(
          `[ClaudeSubscriptionGateway] no bearer token exists for harness ${normalized}`,
        );
      }
      return {
        CLAUDE_SUBSCRIPTION_GATEWAY_URL: origin,
        CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN: token,
        BENCHMARK_BASE_URL: `${origin}/v1`,
        OPENAI_BASE_URL: `${origin}/v1`,
        OPENAI_API_KEY: token,
        BENCHMARK_MODEL_PROVIDER: "claude-subscription",
        BENCHMARK_HARNESS: normalized,
        ELIZA_BENCH_HARNESS: normalized,
      };
    },
    close: () => closeServer(server),
  };
}

async function handleRequest(
  runtime: GatewayRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://loopback.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      readiness: "transport-only",
      service: "claude-subscription-gateway",
      version: "0.1.0",
      bind: { host: runtime.host, loopback: true },
      auth: {
        scheme: "bearer",
        harness_tokens: Object.keys(runtime.harnessTokens).length,
        harness_header_fallback: runtime.fallbackToken !== null,
      },
      transport: {
        provider: "claude-agent-sdk",
        sdk_version: CLAUDE_AGENT_SDK_VERSION,
        fresh_session_per_request: true,
        tool_execution: "capture-only",
        credential_policy: "claude-code-oauth-only",
        serializer: "openai-full-history-v1",
        response_modes: ["json", "sse"],
        streaming_source: "single-buffered-sdk-result",
      },
      queue: runtime.queue.snapshot(),
      audit: runtime.auditSink.stats?.() ?? runtime.auditStore.stats(),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    authenticateHarness(runtime, request);
    sendJson(response, 200, {
      object: "list",
      data: SUBSCRIPTION_MODEL_CATALOG.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "anthropic",
      })),
    });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    sendError(
      response,
      new GatewayRequestError("Route not found.", {
        code: "not_found",
        statusCode: 404,
      }),
    );
    return;
  }
  const harness = authenticateHarness(runtime, request);
  const body = await readJsonBody(request, runtime.maxBodyBytes);
  const canonical = canonicalizeChatCompletion(body);
  const logical = runtime.logicalAllocator.allocate(harness, canonical);
  const contentAttestation =
    runtime.contentContract === null
      ? null
      : buildGatewayContentAttestation(
          runtime.contentContract,
          canonical.request.messages,
        );
  const requestId = logical.requestId;
  const enqueuedAt = runtime.monotonicNow();
  let serviceStartedAt: number | null = null;
  try {
    if (contentAttestation !== null) {
      const violation = gatewayContentAttestationViolation(contentAttestation);
      if (violation !== null) {
        throw new GatewayRequestError(
          "The request does not match the reviewed benchmark content contract.",
          { code: violation },
        );
      }
    }
    const queued = await runtime.queue.enqueue(harness, async (queueWaitMs) => {
      serviceStartedAt = runtime.monotonicNow();
      const latched = activePause(runtime);
      if (latched !== null) throw latched;
      const replay = await runtime.replayJournal?.lookup(logical);
      if (replay) {
        return {
          result: replay.result,
          created: replay.created,
          responseQueueWaitMs: replay.queueWaitMs,
          executionOrigin: "replay" as const,
          serviceMs: Math.max(
            0,
            runtime.monotonicNow() - (serviceStartedAt ?? enqueuedAt),
          ),
        };
      }
      let result: ClaudeCompletionResult;
      try {
        await runtime.storageGuard?.assertReady();
        result = await runtime.completionRunner.complete({
          requestId,
          harness,
          canonical,
        });
      } catch (error: unknown) {
        if (
          error instanceof ClaudeRateLimitError ||
          error instanceof GatewayStorageError
        ) {
          runtime.pauseLatch = error;
        }
        throw error;
      }
      const created = Math.floor(runtime.now().getTime() / 1_000);
      await runtime.replayJournal?.commitSuccess(logical, {
        requestId,
        created,
        queueWaitMs,
        result,
      });
      return {
        result,
        created,
        responseQueueWaitMs: queueWaitMs,
        executionOrigin: "original" as const,
        serviceMs: Math.max(
          0,
          runtime.monotonicNow() - (serviceStartedAt ?? enqueuedAt),
        ),
      };
    });
    const {
      result,
      serviceMs,
      created,
      executionOrigin,
      responseQueueWaitMs,
    } = queued.value;
    const finishReason: CompletionFinishReason =
      result.toolCalls.length > 0 ? "tool_calls" : "stop";
    const completionAlreadyAudited =
      executionOrigin === "replay" && runtime.auditSink.hasLogicalCompletion
        ? await runtime.auditSink.hasLogicalCompletion(
            harness,
            logical.ordinal,
            logical.logicalKeySha256,
          )
        : false;
    const auditEvent = completionAlreadyAudited
      ? "replay_delivery"
      : "logical_completion";
    const audit = makeAuditRecord({
      runtime,
      requestId,
      harness,
      canonical,
      result,
      queueWaitMs: queued.queueWaitMs,
      serviceMs,
      status: "succeeded",
      finishReason,
      errorCode: null,
      contentAttestation,
      logical,
      executionOrigin,
      auditEvent,
      deliveryAttempt: auditEvent === "logical_completion" ? 1 : null,
    });
    await runtime.auditSink.append(audit);
    const provenance = makeProvenance(
      requestId,
      harness,
      canonical,
      result,
      responseQueueWaitMs,
      logical,
    );
    const headers = responseHeaders(requestId, harness, responseQueueWaitMs);
    if (canonical.request.stream) {
      sendSseCompletion(
        response,
        requestId,
        created,
        result,
        finishReason,
        provenance,
        headers,
      );
    } else {
      sendJson(
        response,
        200,
        makeChatCompletionResponse(
          requestId,
          created,
          result,
          finishReason,
          provenance,
        ),
        headers,
      );
    }
  } catch (error: unknown) {
    // error-policy:J1 the HTTP completion boundary records only controlled
    // metadata before translating the failure to the OpenAI error envelope.
    const queueWaitMs =
      serviceStartedAt === null
        ? 0
        : Math.max(0, serviceStartedAt - enqueuedAt);
    const serviceMs =
      serviceStartedAt === null
        ? 0
        : Math.max(0, runtime.monotonicNow() - serviceStartedAt);
    const rateLimited = error instanceof ClaudeRateLimitError;
    const storagePaused = error instanceof GatewayStorageError;
    const paused = rateLimited || storagePaused;
    await runtime.auditSink.append(
      makeAuditRecord({
        runtime,
        requestId,
        harness,
        canonical,
        result: null,
        queueWaitMs,
        serviceMs,
        status: paused ? "paused" : "failed",
        finishReason: null,
        errorCode: safeErrorCode(error),
        contentAttestation,
        logical,
        executionOrigin: "original",
        auditEvent: paused ? "pause_control" : "failure",
        deliveryAttempt: null,
        retryAt:
          rateLimited && error.retryAtMs !== null
            ? new Date(error.retryAtMs).toISOString()
            : null,
        pauseReason:
          rateLimited && error.retryAtMs !== null
            ? "rate_limit"
            : rateLimited
              ? "rate_limit_unknown"
              : storagePaused
                ? "storage_reserve"
                : null,
      }),
    );
    sendError(
      response,
      error,
      responseHeaders(requestId, harness, queueWaitMs),
    );
  }
}

function makeChatCompletionResponse(
  requestId: string,
  created: number,
  result: ClaudeCompletionResult,
  finishReason: CompletionFinishReason,
  provenance: GatewayProvenance,
): JsonObject {
  const assistantMessage: JsonObject = {
    role: "assistant",
    content: result.text || null,
  };
  if (result.toolCalls.length > 0) {
    assistantMessage.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: stableJson(call.arguments),
      },
    }));
  }
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion",
    created,
    model: result.model,
    choices: [
      {
        index: 0,
        message: assistantMessage,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: makeOpenAiUsage(result),
    system_fingerprint: "claude-subscription-gateway-v1",
    gateway: { ...provenance },
  };
}

function sendSseCompletion(
  response: ServerResponse,
  requestId: string,
  created: number,
  result: ClaudeCompletionResult,
  finishReason: CompletionFinishReason,
  provenance: GatewayProvenance,
  headers: Record<string, string>,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...headers,
  });
  const base = {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion.chunk",
    created,
    model: result.model,
    system_fingerprint: "claude-subscription-gateway-v1",
    gateway: { ...provenance },
  };
  const initialDelta: JsonObject = { role: "assistant" };
  if (result.text) initialDelta.content = result.text;
  writeSseData(response, {
    ...base,
    choices: [
      {
        index: 0,
        delta: initialDelta,
        finish_reason: null,
        logprobs: null,
      },
    ],
    usage: null,
  });
  result.toolCalls.forEach((call, index) => {
    writeSseData(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: stableJson(call.arguments),
                },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    });
  });
  writeSseData(response, {
    ...base,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: null,
  });
  writeSseData(response, {
    ...base,
    choices: [],
    usage: makeOpenAiUsage(result),
  });
  response.end("data: [DONE]\n\n");
}

function writeSseData(response: ServerResponse, value: JsonObject): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function makeOpenAiUsage(result: ClaudeCompletionResult): JsonObject {
  const promptTokens =
    result.usage.inputTokens +
    result.usage.cacheReadInputTokens +
    result.usage.cacheCreationInputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: result.usage.outputTokens,
    total_tokens: promptTokens + result.usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: result.usage.cacheReadInputTokens,
    },
  };
}

function makeProvenance(
  requestId: string,
  harness: string,
  canonical: ReturnType<typeof canonicalizeChatCompletion>,
  result: ClaudeCompletionResult,
  queueWaitMs: number,
  logical: LogicalRequest,
): GatewayProvenance {
  return {
    request_id: requestId,
    harness,
    transport: "claude-agent-sdk",
    credential_source: "claude-code-managed",
    sdk_version: CLAUDE_AGENT_SDK_VERSION,
    sdk_api_key_source: result.sdkApiKeySource,
    claude_code_version: result.claudeCodeVersion,
    fresh_session: true,
    tool_execution: "capture-only",
    serializer: canonical.serializerVersion,
    queue_wait_ms: queueWaitMs,
    prompt_sha256: canonical.promptSha256,
    system_prompt_sha256: canonical.systemPromptSha256,
    tool_schema_sha256: canonical.toolSchemaSha256,
    request_sha256: canonical.requestSha256,
    parallel_tool_calls: canonical.request.parallelToolCalls,
    unapplied_parameters: canonical.unappliedParameters,
    result_subtype: result.resultSubtype,
    terminal_reason: result.terminalReason,
    logical_namespace_sha256: logical.namespaceSha256,
    logical_ordinal: logical.ordinal,
    logical_key_sha256: logical.logicalKeySha256,
  };
}

interface AuditRecordInput {
  runtime: GatewayRuntime;
  requestId: string;
  harness: string;
  canonical: ReturnType<typeof canonicalizeChatCompletion>;
  result: ClaudeCompletionResult | null;
  queueWaitMs: number;
  serviceMs: number;
  status: "succeeded" | "failed" | "paused";
  finishReason: CompletionFinishReason | null;
  errorCode: string | null;
  contentAttestation: GatewayContentAttestation | null;
  logical: LogicalRequest;
  executionOrigin: "original" | "replay";
  auditEvent:
    | "logical_completion"
    | "replay_delivery"
    | "failure"
    | "pause_control";
  deliveryAttempt: number | null;
  retryAt?: string | null;
  pauseReason?:
    | "rate_limit"
    | "rate_limit_unknown"
    | "storage_reserve"
    | null;
}

function makeAuditRecord(input: AuditRecordInput): GatewayAuditRecord {
  return {
    requestId: input.requestId,
    recordedAt: input.runtime.now().toISOString(),
    harness: input.harness,
    transport: "claude-agent-sdk",
    credentialSource: "claude-code-managed",
    sdkVersion: CLAUDE_AGENT_SDK_VERSION,
    sdkApiKeySource: "none",
    freshSession: true,
    toolExecution: "capture-only",
    serializer: input.canonical.serializerVersion,
    responseMode: input.canonical.request.stream ? "sse" : "json",
    modelRequested: input.canonical.request.model,
    modelEffective: input.result?.model ?? null,
    reasoningEffort: input.canonical.request.reasoningEffort ?? null,
    claudeCodeVersion: input.result?.claudeCodeVersion ?? null,
    messageCount: input.canonical.request.messages.length,
    messageRoles: input.canonical.request.messages.map(
      (message) => message.role,
    ),
    toolNames: input.canonical.request.tools.map((tool) => tool.function.name),
    toolChoice: normalizedToolChoiceLabel(input.canonical.request.toolChoice),
    parallelToolCalls: input.canonical.request.parallelToolCalls,
    toolCallNames:
      input.result === null
        ? []
        : input.result.toolCalls.map((call) => call.name),
    promptSha256: input.canonical.promptSha256,
    systemPromptSha256: input.canonical.systemPromptSha256,
    toolSchemaSha256: input.canonical.toolSchemaSha256,
    toolSchemaSha256ByName: input.canonical.toolSchemaSha256ByName,
    requestSha256: input.canonical.requestSha256,
    contentAttestation: input.contentAttestation,
    queueWaitMs: input.queueWaitMs,
    serviceMs: input.serviceMs,
    status: input.status,
    finishReason: input.finishReason,
    resultSubtype: input.result?.resultSubtype ?? null,
    terminalReason: input.result?.terminalReason ?? null,
    unappliedParameters: input.canonical.unappliedParameters,
    errorCode: input.errorCode,
    logicalNamespaceSha256: input.logical.namespaceSha256,
    logicalOrdinal: input.logical.ordinal,
    logicalKeySha256: input.logical.logicalKeySha256,
    deliveryAttempt: input.deliveryAttempt ?? undefined,
    executionOrigin: input.executionOrigin,
    auditEvent: input.auditEvent,
    credentialEpochHmacSha256:
      input.result?.credentialEpochHmacSha256 ?? null,
    credentialTierHmacSha256:
      input.result?.credentialTierHmacSha256 ?? null,
    credentialCapabilityHmacSha256:
      input.result?.credentialCapabilityHmacSha256 ?? null,
    retryAt: input.retryAt ?? null,
    pauseReason: input.pauseReason ?? null,
  };
}

function authenticateHarness(
  runtime: GatewayRuntime,
  request: IncomingMessage,
): string {
  const authorization = firstHeader(request.headers.authorization);
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  if (!bearer) {
    throw new AuthenticationError(
      "missing_bearer_token",
      "Bearer authentication is required.",
      401,
    );
  }
  let mappedHarness: string | null = null;
  for (const [candidate, harness] of runtime.tokenToHarness.entries()) {
    if (secureEquals(candidate, bearer)) {
      mappedHarness = harness;
      break;
    }
  }
  const headerValue = firstHeader(request.headers["x-benchmark-harness"]);
  const headerHarness = headerValue ? normalizeHarness(headerValue) : null;
  if (mappedHarness) {
    if (headerHarness && headerHarness !== mappedHarness) {
      throw new AuthenticationError(
        "harness_identity_mismatch",
        "Bearer token and X-Benchmark-Harness identify different harnesses.",
        403,
      );
    }
    return mappedHarness;
  }
  if (runtime.fallbackToken && secureEquals(runtime.fallbackToken, bearer)) {
    if (!headerHarness) {
      throw new AuthenticationError(
        "missing_harness_identity",
        "X-Benchmark-Harness is required with the fallback bearer token.",
        401,
      );
    }
    return headerHarness;
  }
  throw new AuthenticationError(
    "invalid_bearer_token",
    "Bearer token is invalid.",
    401,
  );
}

function resolveHarnessTokens(
  options: StartClaudeSubscriptionGatewayOptions,
): Readonly<Record<string, string>> {
  const entries = options.harnessTokens
    ? Object.entries(options.harnessTokens)
    : (options.harnesses ?? DEFAULT_HARNESSES).map(
        (harness) => [harness, generateToken()] as const,
      );
  if (entries.length === 0) {
    throw new Error(
      "[ClaudeSubscriptionGateway] at least one harness credential is required",
    );
  }
  const resolved: Record<string, string> = {};
  for (const [rawHarness, token] of entries) {
    const harness = normalizeHarness(rawHarness);
    if (resolved[harness]) {
      throw new Error(
        `[ClaudeSubscriptionGateway] duplicate harness credential: ${harness}`,
      );
    }
    validateToken(token, `harnessTokens.${harness}`);
    resolved[harness] = token;
  }
  return Object.freeze(resolved);
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function validateToken(token: string, label: string): void {
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `[ClaudeSubscriptionGateway] ${label} must contain at least 256 bits of opaque text`,
    );
  }
}

function normalizeHarness(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SAFE_HARNESS_PATTERN.test(normalized)) {
    throw new AuthenticationError(
      "invalid_harness_identity",
      "Harness identity has an unsupported format.",
      400,
    );
  }
  return normalized;
}

function normalizeRequestId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
  if (!normalized)
    throw new Error(
      "[ClaudeSubscriptionGateway] request id factory returned no safe text",
    );
  return normalized;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new GatewayRequestError("Request body is required.", {
      code: "missing_request_body",
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    // error-policy:J3 HTTP JSON is untrusted input; surface an explicit invalid
    // request instead of defaulting to an empty body.
    throw new GatewayRequestError("Request body is not valid JSON.", {
      code: "invalid_json",
    });
  }
}

function responseHeaders(
  requestId: string,
  harness: string,
  queueWaitMs: number,
): Record<string, string> {
  return {
    "x-eliza-benchmark-request-id": requestId,
    "x-eliza-benchmark-harness": harness,
    "x-eliza-benchmark-transport": "claude-agent-sdk",
    "x-eliza-benchmark-queue-wait-ms": String(queueWaitMs),
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: JsonObject,
  headers: Record<string, string> = {},
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(serialized)),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(serialized);
}

function sendError(
  response: ServerResponse,
  error: unknown,
  headers: Record<string, string> = {},
): void {
  const statusCode = safeStatusCode(error);
  const code = safeErrorCode(error);
  const message = safeErrorMessage(error);
  const isRateLimit = error instanceof ClaudeRateLimitError;
  const retryAt =
    isRateLimit && error.retryAtMs !== null
      ? new Date(error.retryAtMs).toISOString()
      : null;
  const retryHeaders: Record<string, string> = {};
  if (isRateLimit && error.retryAtMs !== null) {
    retryHeaders["retry-after"] = String(
      Math.max(1, Math.ceil((error.retryAtMs - Date.now()) / 1_000)),
    );
  }
  sendJson(
    response,
    statusCode,
    {
      error: {
        message,
        type: isRateLimit
          ? "rate_limit_error"
          : statusCode >= 500
            ? "server_error"
            : "invalid_request_error",
        param: error instanceof GatewayRequestError ? error.parameter : null,
        code,
        ...(isRateLimit
          ? {
              retry_at: retryAt,
              pause_reason:
                retryAt === null ? "rate_limit_unknown" : "rate_limit",
            }
          : {}),
      },
    },
    statusCode === 401
      ? { ...headers, ...retryHeaders, "www-authenticate": "Bearer" }
      : { ...headers, ...retryHeaders },
  );
}

function safeStatusCode(error: unknown): number {
  if (
    error instanceof GatewayRequestError ||
    error instanceof ClaudeCompletionError ||
    error instanceof PayloadTooLargeError ||
    error instanceof AuthenticationError ||
    error instanceof ReplayMismatchError ||
    error instanceof GatewayStorageError
  ) {
    return error.statusCode;
  }
  if (error instanceof QueueCapacityError) return 429;
  return 500;
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof GatewayRequestError ||
    error instanceof ClaudeCompletionError ||
    error instanceof PayloadTooLargeError ||
    error instanceof AuthenticationError ||
    error instanceof QueueCapacityError ||
    error instanceof ReplayMismatchError ||
    error instanceof GatewayStorageError
  ) {
    return error.code;
  }
  return "internal_gateway_error";
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof GatewayRequestError ||
    error instanceof ClaudeCompletionError ||
    error instanceof PayloadTooLargeError ||
    error instanceof AuthenticationError ||
    error instanceof QueueCapacityError ||
    error instanceof ReplayMismatchError ||
    error instanceof GatewayStorageError
  ) {
    return error.message;
  }
  return "The Claude subscription gateway failed to complete the request.";
}

function activePause(
  runtime: GatewayRuntime,
): ClaudeRateLimitError | GatewayStorageError | null {
  return runtime.pauseLatch;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `[ClaudeSubscriptionGateway] ${label} must be a positive integer`,
    );
  }
  return value;
}
