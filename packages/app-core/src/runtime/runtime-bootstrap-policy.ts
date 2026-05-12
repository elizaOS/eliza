import { getErrorMessage } from "./embedding-manager-support.js";

const FATAL_PGLITE_CODES = new Set([
  "ELIZA_PGLITE_DATA_DIR_IN_USE",
  "ELIZA_PGLITE_CORRUPT_DATA",
  "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
]);

export const RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD = 3;
export const RUNTIME_BOOT_ERROR_DURATION_MS = 2 * 60_000;

export function nextRuntimeBootRetryDelayMs(attempt: number): number {
  const raw = 1000 * 2 ** Math.max(0, Math.min(attempt - 1, 5));
  return Math.min(30_000, raw);
}

export function resolveRuntimeBootstrapFailure(params: {
  attempt: number;
  err: unknown;
  firstFailureAt: number;
  now: number;
}): {
  delayMs?: number;
  lastError: string;
  nextRetryAt?: number;
  phase: "runtime-error" | "runtime-retry";
  shouldRetry: boolean;
  state: "error" | "starting";
} {
  const lastError = getErrorMessage(params.err);
  if (
    typeof params.err === "object" &&
    params.err !== null &&
    "code" in params.err &&
    FATAL_PGLITE_CODES.has(String((params.err as { code?: unknown }).code))
  ) {
    return {
      lastError,
      phase: "runtime-error",
      shouldRetry: false,
      state: "error",
    };
  }

  const delayMs = nextRuntimeBootRetryDelayMs(params.attempt);
  const shouldMarkError =
    params.attempt >= RUNTIME_BOOT_ERROR_ATTEMPT_THRESHOLD ||
    params.now - params.firstFailureAt >= RUNTIME_BOOT_ERROR_DURATION_MS;

  return {
    delayMs,
    lastError,
    nextRetryAt: params.now + delayMs,
    phase: shouldMarkError ? "runtime-error" : "runtime-retry",
    shouldRetry: true,
    state: shouldMarkError ? "error" : "starting",
  };
}
