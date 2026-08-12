/**
 * Boundary validation for approval-request path ids. Callers must reject
 * malformed ids with 400 before any repository lookup so Postgres UUID casts
 * never surface as internal 500s on public or authenticated approval routes.
 */

import { isValidUUID } from "@/lib/utils/validation";

export type ApprovalRequestIdParseResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Parses a route `:id` param as a UUID. Empty and non-UUID values are typed
 * client errors; well-formed UUIDs that miss the store remain a separate 404.
 */
export function parseApprovalRequestIdParam(
  id: string | undefined,
): ApprovalRequestIdParseResult {
  if (!id) {
    return { ok: false, error: "Missing approval request id" };
  }
  if (!isValidUUID(id)) {
    return { ok: false, error: "Invalid approval request id" };
  }
  return { ok: true, id };
}
