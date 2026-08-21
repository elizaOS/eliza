/**
 * Collects bounded, per-turn Shared runtime latency without retaining content.
 * Phase durations and turn-relative offsets are separate fields so consumers
 * cannot accidentally compare unlike measurements.
 */

export const MAX_SHARED_PROVIDER_TIMING_MS = 10 * 60 * 1_000;
export const MAX_SHARED_PROVIDER_TIMING_CALL_COUNT = 1_000;
export const MAX_SHARED_PROVIDER_TIMING_RECORDED_CALLS = 16;

export type SharedRuntimeTimingOutcome = "success" | "aborted" | "error";
export type SharedRuntimeRoutingDecision = "respond" | "silent" | "unknown";

export interface SharedRuntimeInferenceSpan {
  name: string;
  durationMs: number;
}

/**
 * Provider that actually served a model call. `other` is deliberately coarse:
 * it means a pooled credential, Groq, or Vast model, none of which the Shared
 * turn needs to attribute individually.
 */
export type SharedModelProvider = "cerebras" | "openrouter" | "openai" | "anthropic" | "other";

/**
 * `unobserved` marks a call whose provider selection never fired — the model
 * threw before any provider succeeded, or provider resolution itself failed.
 * It is never a `selectedProvider`, so a failed turn can never be read as a
 * healthy call against a real provider.
 */
export type SharedModelCallProvider = SharedModelProvider | "unobserved";

const SHARED_MODEL_PROVIDERS: readonly SharedModelProvider[] = [
  "cerebras",
  "openrouter",
  "openai",
  "anthropic",
  "other",
];

function isSharedModelProvider(value: unknown): value is SharedModelProvider {
  return SHARED_MODEL_PROVIDERS.includes(value as SharedModelProvider);
}

function isSharedModelCallProvider(value: unknown): value is SharedModelCallProvider {
  return value === "unobserved" || isSharedModelProvider(value);
}

function summarizeSelectedProviders(
  providers: ReadonlySet<SharedModelProvider>,
): SharedModelProvider | "mixed" | "none" {
  let selected: SharedModelProvider | "none" = "none";
  for (const provider of providers) {
    if (selected !== "none") return "mixed";
    selected = provider;
  }
  return selected;
}

/** Provider attribution supplied by the AI SDK wrapper once a call succeeds. */
export interface SharedModelCallSelection {
  provider: SharedModelProvider;
  fallback: boolean;
}

export interface SharedModelCallTiming {
  provider: SharedModelCallProvider;
  durationMs: number;
  fallback: boolean;
}

/**
 * Privacy-bounded model timing safe for Shared REST and SSE clients.
 * `callCount` and `fallbackCount` describe every call. `calls` contains the
 * first 16 calls only, and `callsTruncated` is true exactly when later calls
 * were omitted. `clamped` is true when a single call or the running total
 * exceeded `MAX_SHARED_PROVIDER_TIMING_MS`, in which case `durationMs` is the
 * bound rather than the measured value — a pathologically slow turn must stay
 * visible instead of collapsing to zero or being discarded.
 */
export interface SharedProviderTimingReceipt {
  replayed: boolean;
  durationMs: number;
  clamped: boolean;
  callCount: number;
  fallbackCount: number;
  selectedProvider: SharedModelProvider | "mixed" | "none";
  callsTruncated: boolean;
  calls: SharedModelCallTiming[];
}

/**
 * Validate and canonicalize an untrusted provider receipt at a transport
 * boundary. Every aggregate is re-derived from `calls` and rejected when it
 * cannot describe any real turn, and the returned object is rebuilt field by
 * field so undeclared keys never reach a public response.
 */
export function parseSharedProviderTimingReceipt(
  value: unknown,
): SharedProviderTimingReceipt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  const callCount = receipt.callCount;
  const calls = receipt.calls;
  if (
    typeof callCount !== "number" ||
    !Number.isInteger(callCount) ||
    callCount < 0 ||
    callCount > MAX_SHARED_PROVIDER_TIMING_CALL_COUNT ||
    typeof receipt.callsTruncated !== "boolean" ||
    typeof receipt.clamped !== "boolean" ||
    !Array.isArray(calls) ||
    calls.length !== Math.min(callCount, MAX_SHARED_PROVIDER_TIMING_RECORDED_CALLS) ||
    receipt.callsTruncated !== callCount > calls.length
  ) {
    return undefined;
  }
  const clamped = receipt.clamped;
  const safeCalls = calls.every((call) => {
    if (!call || typeof call !== "object") return false;
    const entry = call as Record<string, unknown>;
    return (
      isSharedModelCallProvider(entry.provider) &&
      typeof entry.durationMs === "number" &&
      Number.isFinite(entry.durationMs) &&
      entry.durationMs >= 0 &&
      entry.durationMs <= MAX_SHARED_PROVIDER_TIMING_MS &&
      typeof entry.fallback === "boolean" &&
      (!entry.fallback || entry.provider === "openrouter")
    );
  });
  if (!safeCalls) return undefined;
  const modelCalls = calls as SharedModelCallTiming[];
  const selectedProvider = receipt.selectedProvider;
  if (
    !isSharedModelProvider(selectedProvider) &&
    selectedProvider !== "mixed" &&
    selectedProvider !== "none"
  ) {
    return undefined;
  }
  const recordedFallbacks = modelCalls.filter((call) => call.fallback).length;
  const fallbackCount = receipt.fallbackCount;
  const hiddenCalls = callCount - calls.length;
  // Unobserved calls carry duration but never attribution, so they must not
  // decide `selectedProvider` nor force `mixed`.
  const observedProviders = new Set(
    modelCalls
      .map((call) => call.provider)
      .filter((provider): provider is SharedModelProvider => provider !== "unobserved"),
  );
  const providerIsPossible =
    callCount === 0
      ? selectedProvider === "none"
      : hiddenCalls > 0
        ? selectedProvider === "mixed" ||
          observedProviders.size === 0 ||
          (observedProviders.size === 1 &&
            isSharedModelProvider(selectedProvider) &&
            observedProviders.has(selectedProvider))
        : observedProviders.size === 0
          ? selectedProvider === "none"
          : observedProviders.size > 1
            ? selectedProvider === "mixed"
            : isSharedModelProvider(selectedProvider) && observedProviders.has(selectedProvider);
  const fallbackCountIsPossible =
    typeof fallbackCount === "number" &&
    Number.isInteger(fallbackCount) &&
    fallbackCount >= recordedFallbacks &&
    fallbackCount <= recordedFallbacks + hiddenCalls &&
    (selectedProvider === "openrouter" || selectedProvider === "mixed" || fallbackCount === 0);
  const recordedDurationMs =
    Math.round(modelCalls.reduce((total, call) => total + call.durationMs, 0) * 10) / 10;
  const durationMs = receipt.durationMs;
  const durationIsConsistent =
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= 0 &&
    durationMs <= MAX_SHARED_PROVIDER_TIMING_MS &&
    (clamped
      ? durationMs === MAX_SHARED_PROVIDER_TIMING_MS
      : receipt.callsTruncated
        ? durationMs >= recordedDurationMs
        : durationMs === recordedDurationMs);
  const replayed = receipt.replayed;
  const emptyReceiptIsConsistent =
    callCount !== 0 ||
    (durationMs === 0 &&
      fallbackCount === 0 &&
      selectedProvider === "none" &&
      receipt.callsTruncated === false &&
      clamped === false);
  const replayIsConsistent =
    replayed === false ||
    (durationMs === 0 &&
      callCount === 0 &&
      fallbackCount === 0 &&
      selectedProvider === "none" &&
      receipt.callsTruncated === false &&
      clamped === false);
  if (
    !(
      typeof replayed === "boolean" &&
      providerIsPossible &&
      fallbackCountIsPossible &&
      durationIsConsistent &&
      emptyReceiptIsConsistent &&
      replayIsConsistent
    )
  ) {
    return undefined;
  }
  return {
    replayed,
    durationMs,
    clamped,
    callCount,
    fallbackCount,
    selectedProvider,
    callsTruncated: receipt.callsTruncated,
    calls: modelCalls.map((call) => ({
      provider: call.provider,
      durationMs: call.durationMs,
      fallback: call.fallback,
    })),
  };
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
    completedOffsetMs: number | null;
  };
  inference: {
    composeStateDurationMs: number | null;
    shouldRespondAndContextDurationMs: number | null;
    responseHandlerFieldsDurationMs: number | null;
    providerTotalDurationMs: number | null;
    slowestProviderDurationMs: number | null;
  };
  model: SharedProviderTimingReceipt;
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
  if (value > MAX_SHARED_PROVIDER_TIMING_MS) return null;
  return Math.round(value * 10) / 10;
}

/**
 * Bound a single model-call duration without losing the pathological case: an
 * over-bound call reports the bound and marks the receipt clamped rather than
 * collapsing to zero, because a call slower than the bound is exactly what the
 * receipt exists to expose.
 */
function clampedCallDuration(measured: number): { value: number; clamped: boolean } | null {
  if (!Number.isFinite(measured) || measured < 0) return null;
  if (measured > MAX_SHARED_PROVIDER_TIMING_MS) {
    return { value: MAX_SHARED_PROVIDER_TIMING_MS, clamped: true };
  }
  return { value: Math.round(measured * 10) / 10, clamped: false };
}

function boundedMeasuredDuration(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value > MAX_SHARED_PROVIDER_TIMING_MS) return null;
  return Math.round(value * 10) / 10;
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
  #providerTotalDurationMs: number | null = 0;
  #slowestProviderDurationMs: number | null = null;
  #routingDecision: SharedRuntimeRoutingDecision = "unknown";
  #contextIds: string[] = [];
  #modelDurationMs = 0;
  #modelCallCount = 0;
  #modelFallbackCount = 0;
  #modelProviders = new Set<SharedModelProvider>();
  #modelCalls: SharedModelCallTiming[] = [];
  #modelClamped = false;

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

  /**
   * Track one model call. `select` is invoked by the provider wrapper only when
   * a provider actually served the call; a call that finishes without it is
   * recorded as `unobserved` so a failed or unattributed call is never reported
   * as a healthy call against a real provider.
   */
  prepareModelCall(): {
    select: (selection: SharedModelCallSelection) => void;
    begin: () => void;
    finish: () => void;
  } {
    let selection: SharedModelCallSelection | null = null;
    let startedAt: number | null = null;
    let finished = false;
    return {
      select: (selected) => {
        selection = selected;
      },
      begin: () => {
        startedAt ??= this.#now();
      },
      finish: () => {
        if (finished || startedAt === null) return;
        finished = true;
        const measured = clampedCallDuration(this.#now() - startedAt);
        if (measured === null) return;
        if (measured.clamped) this.#modelClamped = true;
        this.#modelCallCount += 1;
        const call: SharedModelCallTiming = selection
          ? { ...selection, durationMs: measured.value }
          : { provider: "unobserved", fallback: false, durationMs: measured.value };
        if (call.fallback) {
          this.#modelFallbackCount += 1;
        }
        const total = Math.round((this.#modelDurationMs + measured.value) * 10) / 10;
        if (total > MAX_SHARED_PROVIDER_TIMING_MS) this.#modelClamped = true;
        this.#modelDurationMs = Math.min(total, MAX_SHARED_PROVIDER_TIMING_MS);
        if (call.provider !== "unobserved") this.#modelProviders.add(call.provider);
        if (this.#modelCalls.length < MAX_SHARED_PROVIDER_TIMING_RECORDED_CALLS) {
          this.#modelCalls.push(call);
        }
      },
    };
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
    this.#providerTotalDurationMs = boundedMeasuredDuration(
      providerDurations.reduce((total, durationMs) => total + durationMs, 0),
    );
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
        completedOffsetMs: boundedDuration(this.#startedAt, completedAt),
      },
      inference: {
        composeStateDurationMs: this.#composeStateDurationMs,
        shouldRespondAndContextDurationMs: this.#shouldRespondAndContextDurationMs,
        responseHandlerFieldsDurationMs: this.#responseHandlerFieldsDurationMs,
        providerTotalDurationMs: this.#providerTotalDurationMs,
        slowestProviderDurationMs: this.#slowestProviderDurationMs,
      },
      model: {
        replayed: false,
        durationMs: this.#modelDurationMs,
        clamped: this.#modelClamped,
        callCount: this.#modelCallCount,
        fallbackCount: this.#modelFallbackCount,
        selectedProvider: summarizeSelectedProviders(this.#modelProviders),
        callsTruncated: this.#modelCallCount > this.#modelCalls.length,
        calls: this.#modelCalls.map((call) => ({ ...call })),
      },
      routing: {
        decision: this.#routingDecision,
        contextIds: [...this.#contextIds],
      },
    };
  }
}

/** A replay performed no fresh provider work. */
export function replayedSharedProviderTiming(): SharedProviderTimingReceipt {
  return {
    replayed: true,
    durationMs: 0,
    clamped: false,
    callCount: 0,
    fallbackCount: 0,
    selectedProvider: "none",
    callsTruncated: false,
    calls: [],
  };
}
