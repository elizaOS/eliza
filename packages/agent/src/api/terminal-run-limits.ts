/**
 * Resolves the guardrails for agent terminal runs — max concurrent runs and max
 * wall-clock duration — from `ELIZA_TERMINAL_MAX_CONCURRENT` and
 * `ELIZA_TERMINAL_MAX_DURATION_MS`, each clamped to a default and a hard ceiling.
 */
import { randomUUID } from "node:crypto";
import { parseClampedInteger } from "@elizaos/shared";

const TERMINAL_RUN_MAX_CONCURRENT_DEFAULT = 2;
const TERMINAL_RUN_MAX_CONCURRENT_CAP = 16;
const TERMINAL_RUN_MAX_DURATION_MS_DEFAULT = 5 * 60 * 1000;
const TERMINAL_RUN_MAX_DURATION_MS_CAP = 60 * 60 * 1000;

const TERMINAL_RUN_ID_PATTERN =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Resolve a caller-selected run identity, or generate one for legacy callers. */
export function resolveRequestedTerminalRunId(
  value: string | string[] | undefined,
): string | null {
  if (value === undefined) return `run-${randomUUID()}`;
  return typeof value === "string" && TERMINAL_RUN_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

export function resolveTerminalRunLimits(): {
  maxConcurrent: number;
  maxDurationMs: number;
} {
  const maxConcurrentRaw = process.env.ELIZA_TERMINAL_MAX_CONCURRENT;
  const maxConcurrent = parseClampedInteger(maxConcurrentRaw, {
    fallback: TERMINAL_RUN_MAX_CONCURRENT_DEFAULT,
    min: 1,
    max: TERMINAL_RUN_MAX_CONCURRENT_CAP,
  });

  const maxDurationMsRaw = process.env.ELIZA_TERMINAL_MAX_DURATION_MS;
  const maxDurationMs = parseClampedInteger(maxDurationMsRaw, {
    fallback: TERMINAL_RUN_MAX_DURATION_MS_DEFAULT,
    min: 1_000,
    max: TERMINAL_RUN_MAX_DURATION_MS_CAP,
  });

  return { maxConcurrent, maxDurationMs };
}
