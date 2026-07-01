/**
 * Per-generation throughput differencing for the on-device inference path.
 *
 * The device bridge carries the raw counters for every on-device generation
 * (`promptTokens`, `outputTokens`, `durationMs`, and — when the device measured
 * it — `ttftMs`, the time to the first decoded token). This module turns those
 * counters into the two throughput numbers a profiling harness actually wants:
 *
 *   - **prefill tokens/sec** — prompt-processing throughput. The model reads the
 *     whole prompt before emitting the first token, so `ttftMs` *is* the prefill
 *     wall-clock; prefill tok/s = `promptTokens / (ttftMs / 1000)`.
 *   - **decode tokens/sec** — generation throughput. The decode phase runs from
 *     the first token to completion, so decode tok/s =
 *     `outputTokens / ((durationMs - ttftMs) / 1000)`.
 *
 * When the device could not measure `ttftMs` (the non-streaming Capacitor llama
 * path before per-token timing lands), prefill and decode cannot be separated —
 * those fields are reported as `null` and only the combined throughput
 * (`outputTokens / durationMs`) is filled. Per the repo architecture rules
 * (AGENTS.md §3/§7) a quantity that could not be measured is recorded as `null`,
 * never as a fabricated `0`.
 *
 * Shared between the agent-side device bridge
 * (`@elizaos/plugin-local-inference/services/device-bridge`) and the UI client
 * (`@elizaos/ui/services/local-inference/device-bridge`) — both hand-synced
 * copies import this single source rather than re-implementing the math.
 */

/** Raw per-generation counters as carried by the device-bridge wire. */
export interface GenerationCounters {
  /** Prompt tokens the device processed during prefill. */
  promptTokens: number;
  /** Tokens the device decoded (generated). */
  outputTokens: number;
  /** Total wall-clock for the generation, in milliseconds. */
  durationMs: number;
  /**
   * Time to first decoded token, in milliseconds, when the device measured it.
   * Equals the prefill wall-clock. Absent on the non-streaming path.
   */
  ttftMs?: number | null;
}

/** Differenced throughput for a single on-device generation. */
export interface GenerationThroughput {
  /** Prefill (prompt-processing) throughput, tok/s, or null when unmeasurable. */
  prefillTokensPerSecond: number | null;
  /** Decode (generation) throughput, tok/s, or null when unmeasurable. */
  decodeTokensPerSecond: number | null;
  /**
   * Whole-generation throughput, tok/s = outputTokens / durationMs. Always
   * filled when at least one token was decoded in a positive duration, even
   * when `ttftMs` is missing — this is the fallback signal for the
   * non-streaming path.
   */
  combinedTokensPerSecond: number | null;
  /** Echoed TTFT, ms, or null when the device did not measure it. */
  ttftMs: number | null;
  /** Derived decode wall-clock (durationMs − ttftMs), ms, or null. */
  decodeMs: number | null;
}

const MS_PER_SECOND = 1000;

function isPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Difference raw generation counters into prefill / decode / combined tok/s.
 *
 * Pure and synchronous. Every output field is `null` unless the inputs make it
 * genuinely computable — never a fabricated zero.
 */
export function computeGenerationThroughput(
  counters: GenerationCounters,
): GenerationThroughput {
  const { promptTokens, outputTokens, durationMs } = counters;
  const ttftMs =
    isPositive(counters.ttftMs) && counters.ttftMs < durationMs
      ? counters.ttftMs
      : null;

  // Combined throughput needs a positive duration and ≥1 decoded token. Zero
  // decoded tokens means there was no decode to measure — report null, not 0.
  const combinedTokensPerSecond =
    isPositive(durationMs) && isPositive(outputTokens)
      ? outputTokens / (durationMs / MS_PER_SECOND)
      : null;

  // Prefill throughput needs a measured TTFT and ≥1 prompt token.
  const prefillTokensPerSecond =
    ttftMs !== null && isPositive(promptTokens)
      ? promptTokens / (ttftMs / MS_PER_SECOND)
      : null;

  // Decode throughput needs a measured TTFT (so we can subtract prefill) and a
  // positive remaining window with ≥1 decoded token.
  const decodeMs = ttftMs !== null ? durationMs - ttftMs : null;
  const decodeTokensPerSecond =
    decodeMs !== null && isPositive(decodeMs) && isPositive(outputTokens)
      ? outputTokens / (decodeMs / MS_PER_SECOND)
      : null;

  return {
    prefillTokensPerSecond,
    decodeTokensPerSecond,
    combinedTokensPerSecond,
    ttftMs,
    decodeMs: decodeMs !== null && isPositive(decodeMs) ? decodeMs : null,
  };
}

/**
 * Validate the raw counter shape before differencing. The wire is hand-synced
 * between the agent and the device client, so a malformed frame should be
 * rejected at the boundary (and the metric dropped) rather than silently
 * producing garbage throughput.
 */
export function isGenerationCounters(
  value: unknown,
): value is GenerationCounters {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isNonNegativeCount(v.promptTokens as number) &&
    isNonNegativeCount(v.outputTokens as number) &&
    isNonNegativeCount(v.durationMs as number) &&
    (v.ttftMs == null || isNonNegativeCount(v.ttftMs as number))
  );
}
