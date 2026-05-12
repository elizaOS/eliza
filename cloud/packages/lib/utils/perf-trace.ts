/**
 * Performance Trace Utility
 *
 * Lightweight instrumentation for measuring latency of each phase
 * in the message processing pipeline.
 *
 * **Opt-in:** Set `ENABLE_PERF_TRACE=true` in your environment to activate.
 * When disabled, `createPerfTrace()` returns a zero-cost no-op object so
 * call-sites don't need conditional guards.
 *
 * Usage:
 *   const trace = createPerfTrace("stream-route");
 *   trace.mark("auth");
 *   await authenticate();
 *   trace.mark("room-lookup");
 *   await findRoom();
 *   trace.mark("llm-call");
 *   await callLLM();
 *   trace.end();
 *   // When enabled, logs:
 *   // [PerfTrace:stream-route] auth=301ms room-lookup=29ms llm-call=1683ms total=2013ms
 */

import { logger } from "./logger";

export interface PerfTrace {
  /** Mark the start of a new phase. Ends the previous phase timer. */
  mark(phase: string): void;
  /** End the trace and log all phase timings. */
  end(): PerfTraceResult;
  /** Get elapsed time since trace creation (ms). */
  elapsed(): number;
}

export interface PerfPhase {
  name: string;
  startMs: number;
  durationMs: number;
}

export interface PerfTraceResult {
  traceId: string;
  totalMs: number;
  phases: PerfPhase[];
}

/** Check once at module load whether tracing is enabled. */
function isPerfTraceEnabled(): boolean {
  const val = process.env.ENABLE_PERF_TRACE;
  return val === "true" || val === "1";
}

/** Cached result so we don't read env on every request. */
let _enabled: boolean | null = null;
function isEnabled(): boolean {
  if (_enabled === null) {
    _enabled = isPerfTraceEnabled();
  }
  return _enabled;
}

/** Singleton no-op trace -- returned when tracing is disabled. */
const NOOP_RESULT: PerfTraceResult = Object.freeze({
  traceId: "",
  totalMs: 0,
  phases: [],
});
const NOOP_TRACE: PerfTrace = Object.freeze({
  mark() {},
  end() {
    return NOOP_RESULT;
  },
  elapsed() {
    return 0;
  },
});

/**
 * Create a new performance trace.
 *
 * Returns a no-op when `ENABLE_PERF_TRACE` is not set, so call-sites
 * don't need `if (enabled)` guards and there is zero overhead in production.
 *
 * @param traceId - Identifier for this trace (e.g., "stream-route", "telegram-webhook")
 * @param options - Optional configuration
 * @returns PerfTrace instance (or no-op when disabled)
 */
export function createPerfTrace(
  traceId: string,
  options?: {
    /** Minimum total duration (ms) to log. Below this, trace is suppressed. Default: 0 (always log) */
    minDurationMs?: number;
    /** Log level. Default: "info" */
    logLevel?: "info" | "debug" | "warn";
  },
): PerfTrace {
  if (!isEnabled()) {
    return NOOP_TRACE;
  }

  const startTime = Date.now();
  const phases: PerfPhase[] = [];
  let currentPhaseStart = startTime;
  let currentPhaseName: string | null = null;
  let cachedResult: PerfTraceResult | null = null;

  const minDuration = options?.minDurationMs ?? 0;
  const logLevel = options?.logLevel ?? "info";

  return {
    mark(phase: string): void {
      if (cachedResult) return;

      const now = Date.now();

      if (currentPhaseName !== null) {
        phases.push({
          name: currentPhaseName,
          startMs: currentPhaseStart - startTime,
          durationMs: now - currentPhaseStart,
        });
      }

      currentPhaseName = phase;
      currentPhaseStart = now;
    },

    end(): PerfTraceResult {
      if (cachedResult) return cachedResult;

      const now = Date.now();

      if (currentPhaseName !== null) {
        phases.push({
          name: currentPhaseName,
          startMs: currentPhaseStart - startTime,
          durationMs: now - currentPhaseStart,
        });
      }

      const totalMs = now - startTime;
      cachedResult = { traceId, totalMs, phases };

      if (totalMs >= minDuration) {
        const phasesSummary = phases.map((p) => `${p.name}=${p.durationMs}ms`).join(" ");
        const logMsg = `[PerfTrace:${traceId}] ${phasesSummary} total=${totalMs}ms`;

        if (logLevel === "debug") {
          logger.debug(logMsg);
        } else if (logLevel === "warn") {
          logger.warn(logMsg);
        } else {
          logger.info(logMsg);
        }
      }

      return cachedResult;
    },

    elapsed(): number {
      return Date.now() - startTime;
    },
  };
}
