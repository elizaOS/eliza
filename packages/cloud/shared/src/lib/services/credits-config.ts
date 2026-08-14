/** Validates operator configuration used to size credit reservations. */

export function resolveCostBuffer(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREDIT_COST_BUFFER;
  if (raw === undefined || raw.trim() === "") return 1.5;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("CREDIT_COST_BUFFER must be a positive finite number");
  }
  return value;
}
