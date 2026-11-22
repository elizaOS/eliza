/**
 * A host's output cap for one stage of a turn, read from the environment.
 *
 * Measured on a hosted provider (Cerebras, 2026-11-20), a request holds its
 * output cap against the per-minute token limit from the moment it is
 * admitted, but only up to 16,384 tokens: a request that sends no cap holds
 * 16,384, and so does one that sends the model's 40,960 maximum. A smaller
 * cap lowers that hold, so a stage whose answers are a few hundred tokens can
 * start with less headroom; a completed call is charged its uncached input and
 * actual output either way. Unset or blank means no cap from the host. A
 * value that is not a positive integer throws: silently lifting a cap the host
 * asked for would hide the mistake.
 */
export function hostOutputCap(envName: string): number | undefined {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${envName} must be a positive integer, got "${raw}"`);
  return value;
}

/** Stage 1 carries the whole reply of a direct answer. */
export const STAGE1_MAX_TOKENS_ENV = "ELIZA_STAGE1_MAX_TOKENS";
/** The evaluator returns a verdict and, at most, the turn's final reply. */
export const EVALUATOR_MAX_TOKENS_ENV = "ELIZA_EVALUATOR_MAX_TOKENS";
