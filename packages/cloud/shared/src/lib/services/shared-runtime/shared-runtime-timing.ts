/**
 * Collects bounded, per-turn Shared runtime latency without retaining content.
 * Phase durations and turn-relative offsets are separate fields so consumers
 * cannot accidentally compare unlike measurements.
 */

const MAX_RUNTIME_TIMING_MS = 10 * 60 * 1_000;

export type SharedRuntimeTimingOutcome = "success" | "aborted" | "error";
export type SharedRuntimeRoutingDecision = "respond" | "silent" | "unknown";

export interface SharedRuntimeInferenceSpan {
  name: string;
  durationMs: number;
}

export interface SharedRuntimeTimingReceipt {
  traceId: string;
  outcome: SharedRuntimeTimingOutcome;
  historyMessageCount: number;
  phases: {
    edgeContextDurationMs: number | null;
    runtimeInitializeDurationMs: number | null;
    connectionDurationMs: number | null;
    historyProjectionDurationMs: number | null;
  };
  offsets: {
    providerDispatchOffsetMs: number | null;
    providerFirstTextOffsetMs: number | null;
    completedOffsetMs: number;
  };
  inference: {
    composeStateDurationMs: number | null;
    shouldRespondAndContextDurationMs: number | null;
    responseHandlerFieldsDurationMs: number | null;
    providerTotalDurationMs: number;
    slowestProviderDurationMs: number | null;
  };
  routing: {
    decision: SharedRuntimeRoutingDecision;
    contextIds: string[];
  };
}

type Clock = () => number;

function boundedDuration(startedAt: number | null, completedAt: number | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const value = completedAt - startedAt;
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(value, MAX_RUNTIME_TIMING_MS) * 10) / 10;
}

function boundedMeasuredDuration(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(value, MAX_RUNTIME_TIMING_MS) * 10) / 10;
}

/** Mutable timestamps are private to one invocation and produce an immutable receipt. */
export class SharedRuntimeTimingCollector {
  readonly #startedAt: number;
  readonly #now: Clock;
  #edgeContextReadyAt: number | null = null;
  #runtimeInitializeStartedAt: number | null = null;
  #runtimeReadyAt: number | null = null;
  #connectionStartedAt: number | null = null;
  #connectionReadyAt: number | null = null;
  #historyStartedAt: number | null = null;
  #historyReadyAt: number | null = null;
  #providerDispatchedAt: number | null = null;
  #providerFirstTextAt: number | null = null;
  #composeStateDurationMs: number | null = null;
  #shouldRespondAndContextDurationMs: number | null = null;
  #responseHandlerFieldsDurationMs: number | null = null;
  #providerTotalDurationMs = 0;
  #slowestProviderDurationMs: number | null = null;
  #routingDecision: SharedRuntimeRoutingDecision = "unknown";
  #contextIds: string[] = [];

  constructor(
    readonly traceId: string,
    readonly historyMessageCount: number,
    now: Clock = performance.now.bind(performance),
  ) {
    this.#now = now;
    this.#startedAt = now();
  }

  markEdgeContextReady(): void {
    this.#edgeContextReadyAt ??= this.#now();
  }
  markRuntimeInitializeStarted(): void {
    this.#runtimeInitializeStartedAt ??= this.#now();
  }
  markRuntimeReady(): void {
    this.#runtimeReadyAt ??= this.#now();
  }
  markConnectionStarted(): void {
    this.#connectionStartedAt ??= this.#now();
  }
  markConnectionReady(): void {
    this.#connectionReadyAt ??= this.#now();
  }
  markHistoryStarted(): void {
    this.#historyStartedAt ??= this.#now();
  }
  markHistoryReady(): void {
    this.#historyReadyAt ??= this.#now();
  }
  markProviderDispatched(): void {
    this.#providerDispatchedAt ??= this.#now();
  }
  markProviderFirstText(): void {
    this.#providerFirstTextAt ??= this.#now();
  }

  markInferenceSpans(spans: readonly SharedRuntimeInferenceSpan[]): void {
    const providerDurations: number[] = [];
    for (const span of spans) {
      const durationMs = boundedMeasuredDuration(span.durationMs);
      if (durationMs === null) continue;
      if (span.name === "composeState") {
        this.#composeStateDurationMs = durationMs;
      } else if (span.name === "message:planner") {
        this.#shouldRespondAndContextDurationMs = durationMs;
      } else if (span.name === "evaluators:response-handler-fields") {
        this.#responseHandlerFieldsDurationMs = durationMs;
      }
      if (span.name.startsWith("provider:")) providerDurations.push(durationMs);
    }
    this.#providerTotalDurationMs =
      Math.round(
        Math.min(
          providerDurations.reduce((total, durationMs) => total + durationMs, 0),
          MAX_RUNTIME_TIMING_MS,
        ) * 10,
      ) / 10;
    this.#slowestProviderDurationMs =
      providerDurations.length > 0 ? Math.max(...providerDurations) : null;
  }

  markRoutingDecision(decision: SharedRuntimeRoutingDecision, contextIds: readonly string[]): void {
    this.#routingDecision = decision;
    this.#contextIds = Array.from(
      new Set(
        contextIds
          .map((contextId) => contextId.trim().toLowerCase())
          .filter((contextId) => /^[a-z0-9_-]{1,64}$/.test(contextId)),
      ),
    ).slice(0, 16);
  }

  receipt(outcome: SharedRuntimeTimingOutcome): SharedRuntimeTimingReceipt {
    const completedAt = this.#now();
    return {
      traceId: this.traceId,
      outcome,
      historyMessageCount: this.historyMessageCount,
      phases: {
        edgeContextDurationMs: boundedDuration(this.#startedAt, this.#edgeContextReadyAt),
        runtimeInitializeDurationMs: boundedDuration(
          this.#runtimeInitializeStartedAt,
          this.#runtimeReadyAt,
        ),
        connectionDurationMs: boundedDuration(this.#connectionStartedAt, this.#connectionReadyAt),
        historyProjectionDurationMs: boundedDuration(this.#historyStartedAt, this.#historyReadyAt),
      },
      offsets: {
        providerDispatchOffsetMs: boundedDuration(this.#startedAt, this.#providerDispatchedAt),
        providerFirstTextOffsetMs: boundedDuration(this.#startedAt, this.#providerFirstTextAt),
        completedOffsetMs: boundedDuration(this.#startedAt, completedAt) ?? 0,
      },
      inference: {
        composeStateDurationMs: this.#composeStateDurationMs,
        shouldRespondAndContextDurationMs: this.#shouldRespondAndContextDurationMs,
        responseHandlerFieldsDurationMs: this.#responseHandlerFieldsDurationMs,
        providerTotalDurationMs: this.#providerTotalDurationMs,
        slowestProviderDurationMs: this.#slowestProviderDurationMs,
      },
      routing: {
        decision: this.#routingDecision,
        contextIds: [...this.#contextIds],
      },
    };
  }
}
