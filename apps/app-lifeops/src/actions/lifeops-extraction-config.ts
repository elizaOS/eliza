/**
 * Shared configuration for LifeOps LLM extraction context windows.
 *
 * All extractors (life, calendar, gmail) use this to determine how many
 * recent conversation lines to include in the LLM prompt. Override at
 * runtime via `ELIZA_LIFEOPS_CONTEXT_WINDOW`.
 */

const DEFAULT_CONTEXT_WINDOW = 16;

/**
 * Resolve the number of recent conversation lines to include in
 * LifeOps extraction prompts.
 *
 * Reads `ELIZA_LIFEOPS_CONTEXT_WINDOW` from the environment. Falls
 * back to {@link DEFAULT_CONTEXT_WINDOW} (16) when unset or invalid.
 */
export function resolveContextWindow(): number {
  const envValue = process.env.ELIZA_LIFEOPS_CONTEXT_WINDOW;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}
