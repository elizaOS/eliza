/** Validates operator configuration used to size credit reservations. */

import { ElizaError } from "@elizaos/core/edge";

const DEFAULT_COST_BUFFER = 1.5;
/** 1 = no buffer at all. Anything below underflows `estimatedCost * COST_BUFFER`
 * back toward `MIN_RESERVATION`, the same floor-collapse a negative value caused. */
const MIN_COST_BUFFER = 1;
/** Generous ceiling that keeps `estimatedCost * COST_BUFFER` far from any
 * finite-precision or overflow concern for realistic dollar-scale estimates. */
const MAX_COST_BUFFER = 1000;
const CANONICAL_DECIMAL_PATTERN = /^([1-9]\d*)(?:\.(\d+))?$/;

export function resolveCostBuffer(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREDIT_COST_BUFFER;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COST_BUFFER;

  const trimmed = raw.trim();
  const decimalMatch = CANONICAL_DECIMAL_PATTERN.exec(trimmed);
  const integerPart = decimalMatch?.[1];
  const fractionalPart = decimalMatch?.[2];
  const exceedsExactMaximum =
    integerPart !== undefined &&
    (integerPart.length > 4 ||
      (integerPart.length === 4 &&
        (integerPart > String(MAX_COST_BUFFER) ||
          (integerPart === String(MAX_COST_BUFFER) &&
            fractionalPart !== undefined &&
            /[1-9]/.test(fractionalPart)))));
  const value = Number(trimmed);
  if (
    decimalMatch === null ||
    exceedsExactMaximum ||
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
