/**
 * Display clamps for user-supplied music queries. The content.text fallback in
 * the playback actions can hold a multi-KB blob — the external-content
 * security envelope, or a planner-echoed tool text — and several handlers
 * quote the query back to chat (live Discord envelope leak 2026-08-02,
 * tj-2dc95f75456876). Mirrors plugin-cloud-apps' describeAppReference pattern
 * locally: user-facing echoes are quoted only when query-shaped, machine/log
 * renders are one-line and length-clamped.
 */

/**
 * User-facing echo of a music query. Only query-shaped values (single line,
 * <=64 chars) are quoted back verbatim; anything else renders as the neutral
 * fallback so an oversized or hostile value never ships to chat.
 */
export function describeMusicQuery(
  query: string,
  fallback = "that request",
): string {
  const trimmed = query.trim();
  const queryShaped =
    trimmed.length > 0 && trimmed.length <= 64 && !/[\r\n]/.test(trimmed);
  return queryShaped ? `"${trimmed}"` : fallback;
}

/**
 * Log/machine-facing render of a music query. A blob must still never travel
 * whole — a weak planner echoes tool text verbatim and a multi-KB blob bloats
 * context — so collapse whitespace to one line and clamp to 120 chars.
 */
export function musicQueryLogView(query: string): string {
  const collapsed = query.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}
