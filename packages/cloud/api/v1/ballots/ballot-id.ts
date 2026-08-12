/**
 * Boundary validation for secret-ballot path ids. Callers must reject
 * malformed ids with 400 before any repository lookup so Postgres UUID casts
 * never surface as internal 500s on public or authenticated ballot routes.
 */

import { isValidUUID } from "@/lib/utils/validation";

export type BallotIdParseResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Parses a route `:id` param as a UUID. Empty and non-UUID values are typed
 * client errors; well-formed UUIDs that miss the store remain a separate 404.
 */
export function parseBallotIdParam(
  id: string | undefined,
): BallotIdParseResult {
  if (!id) {
    return { ok: false, error: "Missing ballot id" };
  }
  if (!isValidUUID(id)) {
    return { ok: false, error: "Invalid ballot id" };
  }
  return { ok: true, id };
}
