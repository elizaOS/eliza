/**
 * Parses the UI-smoke lane's shard selector so CI can split the suite across
 * machines. The lane pins Playwright to one worker because each process owns a
 * live app stack, so wall clock only falls when separate runners each take a
 * slice.
 *
 * Rejecting a malformed selector is the point: a shard that silently degrades
 * to "run everything" reports a full suite as one slice of the work, and the
 * lane reads green while five sixths of it never ran anywhere.
 */

export const UI_SMOKE_SHARD_ENV = "ELIZA_UI_SMOKE_SHARD";

/**
 * Turn a `<current>/<total>` selector into Playwright's shard option.
 *
 * Returns undefined when the value is absent or empty, which runs the whole
 * suite. Throws on anything present but unusable.
 */
export function parseUiSmokeShard(rawValue) {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (raw.length === 0) return undefined;

  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      `${UI_SMOKE_SHARD_ENV} must be "<current>/<total>", got "${raw}"`,
    );
  }

  const current = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || current < 1 || current > total) {
    throw new Error(
      `${UI_SMOKE_SHARD_ENV} needs 1 <= current <= total, got "${raw}"`,
    );
  }

  return { current, total };
}
