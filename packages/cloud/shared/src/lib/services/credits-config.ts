/** Validates operator configuration used to size credit reservations. */

import { ElizaError } from "@elizaos/core";

const DEFAULT_COST_BUFFER = 1.5;
/** 1 = no buffer at all. Anything below underflows `estimatedCost * COST_BUFFER`
 * back toward `MIN_RESERVATION`, the same floor-collapse a negative value caused. */
const MIN_COST_BUFFER = 1;
/** Generous ceiling that keeps `estimatedCost * COST_BUFFER` far from any
 * finite-precision or overflow concern for realistic dollar-scale estimates. */
const MAX_COST_BUFFER = 1000;
const CANONICAL_DECIMAL_PATTERN = /^[1-9]\d*(\.\d+)?$/;

export function resolveCostBuffer(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREDIT_COST_BUFFER;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COST_BUFFER;

  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (
    !CANONICAL_DECIMAL_PATTERN.test(trimmed) ||
    !Number.isFinite(value) ||
    value < MIN_COST_BUFFER ||
    value > MAX_COST_BUFFER
  ) {
    throw new ElizaError(
      `CREDIT_COST_BUFFER must be a canonical decimal number from ${MIN_COST_BUFFER} through ${MAX_COST_BUFFER} (1 means no buffer)`,
      {
        code: "INVALID_CREDIT_COST_BUFFER",
        context: {
          configured: raw,
          minimum: MIN_COST_BUFFER,
          maximum: MAX_COST_BUFFER,
        },
        severity: "fatal",
      },
    );
  }
  return value;
}
