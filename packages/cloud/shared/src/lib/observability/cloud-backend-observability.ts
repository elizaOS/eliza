/**
 * Records Cloud request, database and inference timing for admin diagnostics.
 * Dependency telemetry retains admission results and errors unchanged and never
 * includes request bodies, response bodies or private exception messages.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../utils/logger";

const MAX_EVENTS = 1_000;
const DEFAULT_SLOW_REQUEST_MS = 1_000;
const DEFAULT_SLOW_DB_MS = 250;
const DEFAULT_DB_BURST_COUNT = 20;

export interface CloudRequestTelemetry {
  id: string;
  traceId?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  organizationId?: string | null;
  authMethod?: string | null;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  duplicateReadKeys: Array<{ key: string; count: number }>;
  slowDbCalls: CloudDbTelemetry[];
  createdAt: string;
}

export interface CloudDbTelemetry {
  requestId?: string;
  operation: "read" | "write" | "transaction";
  label: string;
  durationMs: number;
  duplicateReadCount?: number;
  createdAt: string;
}

/**
 * One inference stream's milestone boundaries (#16079), correlated by the
 * shared trace id. All `*Ms` values are elapsed from the provider fetch
 * start; `null` means that boundary was never observed. Deliberately
 * privacy-bounded: model, path kind, provider request id echo, and timings
 * only — no prompts, outputs, token counts, or client identifiers.
 */
export interface CloudStreamMilestoneTelemetry {
  traceId: string;
  requestId?: string;
  /** Gateway routing path that produced the stream (`passthrough` today). */
  path: string;
  model: string;
  /** Bounded echo of the provider's own request id header, when present. */
  providerRequestId?: string;
  /** Upstream fetch start → upstream response headers, from the Worker. */
  upstreamHeadersMs?: number | null;
  /** Observer installation before SDK invocation → first native fetch dispatch. */
  sdkToProviderDispatchMs?: number | null;
  firstToolArgumentsMs?: number | null;
  firstEnqueueMs?: number | null;
  providerAttempts?: Array<{
    dispatchMs: number | null;
    headersMs: number | null;
    status: number | null;
  }>;
  providerAttemptsOverflow?: boolean;
  providerTimeInfoMs?: Record<string, number | null>;
  firstEventMs: number | null;
  firstReasoningMs: number | null;
  firstContentMs: number | null;
  completionMs: number | null;
  /**
   * Stream ended via client abort, read failure, or an in-stream provider
   * error frame — observed during the stream or its teardown. NOT mutually
   * exclusive with `completionMs`: a provider that emitted `[DONE]` before a
   * client disconnect completed, and both facts are recorded (#16079).
   */
  aborted: boolean;
  createdAt: string;
}

export interface CloudTelemetrySnapshot {
  generatedAt: string;
  thresholds: {
    slowRequestMs: number;
    slowDbMs: number;
    dbBurstCount: number;
  };
  requests: CloudRequestTelemetry[];
  slowRequests: CloudRequestTelemetry[];
  db: CloudDbTelemetry[];
  slowDb: CloudDbTelemetry[];
  burstyRequests: CloudRequestTelemetry[];
  duplicateReadRequests: CloudRequestTelemetry[];
  /** Inference stream milestones (#16079), newest first. */
  streamMilestones: CloudStreamMilestoneTelemetry[];
}

interface RequestContext {
  id: string;
  traceId?: string;
  method: string;
  path: string;
  startedAt: number;
  dbCalls: number;
  dbReadCalls: number;
  dbWriteCalls: number;
  duplicateDbReadCalls: number;
  readKeys: Map<string, number>;
  slowDbCalls: CloudDbTelemetry[];
}

const requestAls = new AsyncLocalStorage<RequestContext>();
const sdkStreamAls = new AsyncLocalStorage<SdkStreamTiming>();
const requests: CloudRequestTelemetry[] = [];
const dbEvents: CloudDbTelemetry[] = [];
const streamMilestones: CloudStreamMilestoneTelemetry[] = [];

function numberEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  // `Number.parseInt` stops at the first non-digit, so "500junk" parsed to a
  // positive 500 and was accepted as a deliberate threshold. The snapshot
  // publishes the threshold it used, so a typo made the report describe — and
  // classify against — a boundary nobody configured.
  const trimmed = raw?.trim();
  // The optional leading plus is kept deliberately: `Number.parseInt` accepted
  // "+500", so rejecting it here would be a compatibility regression rather
  // than a fix.
  const parsed = trimmed && /^\+?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function thresholds() {
  return {
    slowRequestMs: numberEnv("CLOUD_SLOW_REQUEST_MS", DEFAULT_SLOW_REQUEST_MS),
    slowDbMs: numberEnv("CLOUD_SLOW_DB_MS", DEFAULT_SLOW_DB_MS),
    dbBurstCount: numberEnv("CLOUD_DB_BURST_COUNT", DEFAULT_DB_BURST_COUNT),
  };
}

function pushBounded<T>(list: T[], value: T): void {
  list.unshift(value);
  if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function readKey(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, 500) || "unlabeled-read";
}

/** Log slow inference dependencies in the same invocation as its auth trace. */
export async function observeInferenceDependency<T>(
  dependency: "policy_lock" | "policy_read" | "transaction" | "durable_object",
  operation: string,
  fn: () => Promise<T>,
  handlerTiming?: (result: T) => number | undefined,
): Promise<T> {
  const context = requestAls.getStore();
  if (
    !context?.traceId ||
    !["/api/v1/embeddings", "/api/v1/chat/completions"].includes(context.path)
  ) {
    return fn();
  }
  const startedAt = performance.now();
  let completion: { outcome: "threw" } | { outcome: "returned"; result: T } = {
    outcome: "threw",
  };
  try {
    const result = await fn();
    completion = { outcome: "returned", result };
    return result;
  } finally {
    const durationMs = elapsedMs(startedAt);
    if (durationMs >= DEFAULT_SLOW_DB_MS) {
      // Operations are static caller labels, never SQL, credentials, prompts,
      // responses, or error messages. Nested spans overlap; do not add them.
      try {
        const handlerMs =
          completion.outcome === "returned" && handlerTiming
            ? handlerTiming(completion.result)
            : undefined;
        logger.audit("[InferenceAdmission] dependency timing", {
          traceId: context.traceId,
          dependency,
          operation,
          durationMs,
          outcome: completion.outcome,
          ...(typeof handlerMs === "number" &&
            Number.isFinite(handlerMs) &&
            handlerMs >= 0 &&
            handlerMs <= durationMs && { handlerMs }),
        });
      } catch {
        // error-policy:J7 this Cloud boundary has no AgentRuntime. Warn without
        // exposing extractor errors or allowing telemetry to retry admission.
        try {
          logger.warn("[InferenceAdmission] dependency timing unavailable", {
            traceId: context.traceId,
            dependency,
            operation,
          });
        } catch {
          // error-policy:J7 both diagnostic sinks failed; preserve the exact
          // admission result or error because this boundary cannot report further.
        }
      }
    }
  }
}

export async function observeCloudRequest<T>(
  input: { id: string; traceId?: string; method: string; path: string },
  fn: () => Promise<{
    result: T;
    status: number;
    userId?: string | null;
    organizationId?: string | null;
    authMethod?: string | null;
  }>,
): Promise<T> {
  const context: RequestContext = {
    ...input,
    startedAt: performance.now(),
    dbCalls: 0,
    dbReadCalls: 0,
    dbWriteCalls: 0,
    duplicateDbReadCalls: 0,
    readKeys: new Map(),
    slowDbCalls: [],
  };

  return requestAls.run(context, async () => {
    let response:
      | {
          result: T;
          status: number;
          userId?: string | null;
          organizationId?: string | null;
          authMethod?: string | null;
        }
      | undefined;

    try {
      response = await fn();
      return response.result;
    } finally {
      const duplicateReadKeys = [...context.readKeys]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);
      pushBounded(requests, {
        id: input.id,
        traceId: input.traceId,
        method: input.method,
        path: input.path,
        status: response?.status ?? 500,
        durationMs: elapsedMs(context.startedAt),
        userId: response?.userId,
        organizationId: response?.organizationId,
        authMethod: response?.authMethod,
        dbCalls: context.dbCalls,
        dbReadCalls: context.dbReadCalls,
        dbWriteCalls: context.dbWriteCalls,
        duplicateDbReadCalls: context.duplicateDbReadCalls,
        duplicateReadKeys,
        slowDbCalls: context.slowDbCalls.slice(0, 20),
        createdAt: nowIso(),
      });
    }
  });
}

export async function observeDbOperation<T>(
  operation: CloudDbTelemetry["operation"],
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const context = requestAls.getStore();
  let duplicateReadCount: number | undefined;

  if (context) {
    context.dbCalls += 1;
    if (operation === "read") {
      context.dbReadCalls += 1;
      const key = readKey(label);
      const count = (context.readKeys.get(key) ?? 0) + 1;
      context.readKeys.set(key, count);
      if (count > 1) {
        duplicateReadCount = count;
        context.duplicateDbReadCalls += 1;
      }
    } else {
      context.dbWriteCalls += 1;
    }
  }

  try {
    return await fn();
  } finally {
    const event: CloudDbTelemetry = {
      requestId: context?.id,
      operation,
      label: readKey(label),
      durationMs: elapsedMs(startedAt),
      duplicateReadCount,
      createdAt: nowIso(),
    };
    pushBounded(dbEvents, event);
    if (event.durationMs >= thresholds().slowDbMs && context) {
      context.slowDbCalls.push(event);
    }
  }
}

export function getCloudTelemetrySnapshot(limit = 200): CloudTelemetrySnapshot {
  const t = thresholds();
  const req = requests.slice(0, limit);
  const db = dbEvents.slice(0, limit);
  return {
    generatedAt: nowIso(),
    thresholds: t,
    requests: req,
    slowRequests: req.filter((r) => r.durationMs >= t.slowRequestMs),
    db,
    slowDb: db.filter((r) => r.durationMs >= t.slowDbMs),
    burstyRequests: req.filter((r) => r.dbCalls >= t.dbBurstCount),
    duplicateReadRequests: req.filter((r) => r.duplicateDbReadCalls > 0),
    streamMilestones: streamMilestones.slice(0, limit),
  };
}

/**
 * Record one inference stream's milestone boundaries (#16079). Called from the
 * gateway's off-response-path meter, so it must stay synchronous and cheap:
 * the event is bounded, pre-shaped by the caller, and pushed to the same
 * isolate ring buffer as request/db telemetry, where the admin
 * cloud-observability endpoint reads it back.
 */
export function recordCloudStreamMilestones(event: CloudStreamMilestoneTelemetry): void {
  pushBounded(streamMilestones, event);
}

export function clearCloudTelemetry(): void {
  requests.length = 0;
  dbEvents.length = 0;
  streamMilestones.length = 0;
}

const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_PROVIDER_SECONDS = 3_600;
const PROVIDER_TIME_FIELDS = [
  ["queue_time", "queueMs"],
  ["prompt_time", "promptMs"],
  ["completion_time", "generationMs"],
  ["total_time", "totalMs"],
] as const;

interface SdkProviderAttemptTiming {
  startedAt: number;
  headersAt: number | null;
  status: number | null;
}

/** Request-scoped diagnostics only; never reads or retains provider body bytes. */
class SdkStreamTiming {
  private readonly attempts: SdkProviderAttemptTiming[] = [];
  private overflow = false;
  private firstPartAt: number | null = null;
  private firstTextAt: number | null = null;
  private firstArgumentsAt: number | null = null;
  private firstEnqueueAt: number | null = null;
  private completionAt: number | null = null;
  private readonly providerMs: Record<string, number | null> = {
    queueMs: null,
    promptMs: null,
    generationMs: null,
    totalMs: null,
  };
  private finished = false;
  private readonly sdkStartedAt: number | null;

  constructor(
    private readonly traceId: string,
    private readonly model: string,
  ) {
    try {
      this.sdkStartedAt = performance.now();
    } catch {
      // error-policy:J7 missing clock data remains unknown, not a stream failure.
      this.sdkStartedAt = null;
    }
  }

  async fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    let attempt: SdkProviderAttemptTiming | undefined;
    try {
      attempt = { startedAt: performance.now(), headersAt: null, status: null };
      if (this.attempts.length < MAX_PROVIDER_ATTEMPTS) this.attempts.push(attempt);
      else this.overflow = true;
    } catch {
      /* error-policy:J7 a timing failure must not prevent the original fetch. */
    }
    const response = await fetch(input, init);
    try {
      if (attempt) {
        attempt.headersAt = performance.now();
        attempt.status = response.status;
      }
    } catch {
      /* error-policy:J7 preserve the exact successful Response. */
    }
    return response;
  }

  part(part: { type: string; text?: unknown; delta?: unknown; rawValue?: unknown }): void {
    try {
      const now = performance.now();
      if (part.type === "finish") this.completionAt ??= now;
      if (
        part.type === "raw" ||
        part.type === "text-delta" ||
        part.type === "reasoning-delta" ||
        part.type === "tool-input-start" ||
        part.type === "tool-input-delta" ||
        part.type === "tool-call"
      ) {
        this.firstPartAt ??= now;
      }
      if (part.type === "text-delta" && typeof part.text === "string" && part.text.length)
        this.firstTextAt ??= now;
      if (part.type === "tool-input-delta" && typeof part.delta === "string" && part.delta.length)
        this.firstArgumentsAt ??= now;
      if (part.type !== "raw" || !part.rawValue || typeof part.rawValue !== "object") return;
      const info = (part.rawValue as Record<string, unknown>).time_info;
      if (!info || typeof info !== "object" || Array.isArray(info)) return;
      for (const [source, target] of PROVIDER_TIME_FIELDS) {
        const seconds = (info as Record<string, unknown>)[source];
        if (
          typeof seconds === "number" &&
          Number.isFinite(seconds) &&
          seconds >= 0 &&
          seconds <= MAX_PROVIDER_SECONDS
        ) {
          this.providerMs[target] = Math.round(seconds * 100_000) / 100;
        }
      }
    } catch {
      /* error-policy:J7 provider diagnostics never alter stream delivery. */
    }
  }
  enqueue(): void {
    try {
      this.firstEnqueueAt ??= performance.now();
    } catch {
      /* error-policy:J7 preserve stream delivery when timing is unavailable. */
    }
  }

  finish(aborted: boolean): void {
    if (this.finished) return;
    this.finished = true;
    try {
      const origin = this.attempts[0]?.startedAt;
      const elapsed = (at: number | null) =>
        origin !== undefined && at !== null && at >= origin
          ? Math.round((at - origin) * 100) / 100
          : null;
      const event: CloudStreamMilestoneTelemetry = {
        traceId: this.traceId,
        path: "sdk",
        model: this.model,
        sdkToProviderDispatchMs:
          this.sdkStartedAt !== null && origin !== undefined
            ? Math.round((origin - this.sdkStartedAt) * 100) / 100
            : null,
        upstreamHeadersMs: elapsed(this.attempts[0]?.headersAt ?? null),
        firstEventMs: elapsed(this.firstPartAt),
        firstReasoningMs: null,
        firstContentMs: elapsed(this.firstTextAt),
        completionMs: elapsed(this.completionAt),
        firstToolArgumentsMs: elapsed(this.firstArgumentsAt),
        firstEnqueueMs: elapsed(this.firstEnqueueAt),
        providerAttempts: this.attempts.map((attempt) => ({
          dispatchMs: elapsed(attempt.startedAt),
          headersMs:
            attempt.headersAt === null
              ? null
              : Math.round((attempt.headersAt - attempt.startedAt) * 100) / 100,
          status: attempt.status,
        })),
        providerAttemptsOverflow: this.overflow,
        providerTimeInfoMs: { ...this.providerMs },
        aborted,
        createdAt: nowIso(),
      };
      recordCloudStreamMilestones(event);
      logger.audit("[InferenceStream] SDK provider timing", event);
    } catch {
      /* error-policy:J7 diagnostics must not change stream delivery or settlement. */
    }
  }
}

/** The trace comes from the request; the observer stays in its own child scope. */
export function beginSdkStreamTiming(traceId: string, model: string): SdkStreamTiming {
  return new SdkStreamTiming(traceId, model);
}

export function bindSdkStreamTiming<Args extends unknown[], Result>(
  timing: SdkStreamTiming | undefined,
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  return timing ? (...args) => sdkStreamAls.run(timing, () => operation(...args)) : operation;
}

/** Native Cerebras fetch hook; all other provider clients remain unchanged. */
export function observeCerebrasFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const timing = sdkStreamAls.getStore();
  return timing ? timing.fetch(input, init) : fetch(input, init);
}
