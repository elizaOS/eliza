/**
 * Resolves bounded native-planner loop and model-retry limits from runtime
 * settings, with an optional per-message iteration override.
 */

import { parseClampedInteger } from "@elizaos/shared";

export type NativePlannerLimitSetting =
  | "NATIVE_PLANNER_MAX_ITERATIONS"
  | "NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES"
  | "NATIVE_PLANNER_PARSE_RETRIES"
  | "NATIVE_RESPONSE_PARSE_RETRIES";

export type NativePlannerSettingReader = (name: NativePlannerLimitSetting) => unknown;

export interface NativePlannerLimits {
  maxIterations: number;
  maxConsecutiveFailures: number;
  maxParseRetries: number;
  maxSummaryRetries: number;
}

// Permit deliberate tuning above the defaults while bounding per-message model
// and action fanout. Parse retries retain the service's historical ceiling of 5.
const ITERATION_BOUNDS = { min: 1, max: 20, fallback: 6 } as const;
const FAILURE_BOUNDS = { min: 1, max: 10, fallback: 2 } as const;
const PARSE_RETRY_BOUNDS = { min: 1, max: 5, fallback: 2 } as const;

function boundedInteger(
  value: unknown,
  bounds: { min: number; max: number; fallback: number },
): number {
  return parseClampedInteger(value == null ? undefined : String(value), bounds);
}

export function resolveNativePlannerLimits(
  getSetting: NativePlannerSettingReader,
  maxIterationsOverride?: number,
): NativePlannerLimits {
  return {
    maxIterations: boundedInteger(
      maxIterationsOverride ?? getSetting("NATIVE_PLANNER_MAX_ITERATIONS"),
      ITERATION_BOUNDS,
    ),
    maxConsecutiveFailures: boundedInteger(
      getSetting("NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES"),
      FAILURE_BOUNDS,
    ),
    maxParseRetries: boundedInteger(getSetting("NATIVE_PLANNER_PARSE_RETRIES"), PARSE_RETRY_BOUNDS),
    maxSummaryRetries: boundedInteger(
      getSetting("NATIVE_RESPONSE_PARSE_RETRIES"),
      PARSE_RETRY_BOUNDS,
    ),
  };
}
