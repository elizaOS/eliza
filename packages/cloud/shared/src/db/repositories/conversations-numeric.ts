/**
 * Numeric parsing boundary for the conversation `total_cost` accumulator.
 *
 * Postgres NUMERIC fields arrive as strings, and the per-message cost supplied
 * by callers is an untrusted numeric. `addMessageWithSequence` advances the
 * accumulator with a JS-side read-modify-write:
 *
 *   total_cost = String(Number(conversation.total_cost) + Number(data.cost || 0))
 *
 * Both operands feed a value written straight back into the notNull
 * NUMERIC(10,2) `total_cost` column. Without a guard:
 *
 *   - a corrupt stored `total_cost` (driver quirk, migration artifact, or a
 *     prior poisoned write) → `Number(...)` = `NaN` → `String(NaN + cost)` =
 *     `"NaN"` is written back, PERMANENTLY poisoning the accumulator: every
 *     later add cascades `NaN`, and there is no DB check-constraint backstop on
 *     this analytics/accounting column.
 *   - a non-numeric / non-finite caller `cost` (e.g. `"abc"`, `Infinity`, an
 *     object) → same `NaN`/`Infinity` poison.
 *
 * The write silently "succeeds" (no thrown error, no `NaN` rejection by the
 * driver), so the corruption is invisible until a downstream reader trips over
 * it. Failing closed here surfaces the bad value inside the enclosing
 * transaction, which rolls back the message insert + stats update atomically
 * instead of committing a poisoned total.
 *
 * An explicit domain zero (`"0"`, `"0.00"`, `0`) is a legitimate value and is
 * allowed; only empty/missing/non-finite inputs throw.
 */

export function parseConversationCostNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`Unable to read conversation ${fieldName}: value is empty or missing`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read conversation ${fieldName}: value is not a finite number`);
  }
  return parsed;
}
