import { parseClampedInteger } from "../utils/number-parsing";

const TERMINAL_RUN_MAX_CONCURRENT_DEFAULT = 2;
const TERMINAL_RUN_MAX_CONCURRENT_CAP = 16;
const TERMINAL_RUN_MAX_DURATION_MS_DEFAULT = 5 * 60 * 1000;
const TERMINAL_RUN_MAX_DURATION_MS_CAP = 60 * 60 * 1000;

export function resolveTerminalRunLimits(): {
  maxConcurrent: number;
  maxDurationMs: number;
} {
  const maxConcurrentRaw =
    process.env.MILADY_TERMINAL_MAX_CONCURRENT ??
    process.env.MILAIDY_TERMINAL_MAX_CONCURRENT;
  const maxConcurrent = parseClampedInteger(maxConcurrentRaw, {
    fallback: TERMINAL_RUN_MAX_CONCURRENT_DEFAULT,
    min: 1,
    max: TERMINAL_RUN_MAX_CONCURRENT_CAP,
  });

  const maxDurationMsRaw =
    process.env.MILADY_TERMINAL_MAX_DURATION_MS ??
    process.env.MILAIDY_TERMINAL_MAX_DURATION_MS;
  const maxDurationMs = parseClampedInteger(maxDurationMsRaw, {
    fallback: TERMINAL_RUN_MAX_DURATION_MS_DEFAULT,
    min: 1_000,
    max: TERMINAL_RUN_MAX_DURATION_MS_CAP,
  });

  return { maxConcurrent, maxDurationMs };
}
