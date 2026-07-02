/**
 * Small client-side helpers for the applications domain.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether `id` is a syntactically valid v1–v5 UUID. */
export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}
