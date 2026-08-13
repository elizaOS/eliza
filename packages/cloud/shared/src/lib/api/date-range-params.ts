/**
 * Parses the optional `start_date`/`end_date` query bounds shared by the app
 * analytics routes. An unparseable value must be rejected at the request
 * boundary: an Invalid Date flows into Drizzle's timestamp serializer, whose
 * `toISOString()` throws, so a caller typo surfaces as a 500 instead of a 400.
 *
 * Returns `undefined` when the parameter is absent and `null` when it was
 * supplied but unparseable, so callers can tell "no bound" from "bad bound".
 */
export function parseDateParam(raw: string | null): Date | undefined | null {
  if (raw === null) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
