/**
 * Safe rendering of user- or planner-supplied reference text (queries, names,
 * targets) in output. A reference that fell back to `message.content.text` can
 * be an entire rendered prompt — including the external-content security
 * envelope — and a planner-filled param can be an arbitrary blob; quoting
 * either verbatim re-broadcasts untrusted scaffolding to chat (live leak
 * 2026-08-02, tj-2dc95f75456876) or bloats planner context. The gate is a
 * shape property, not content sniffing: real names and queries are short
 * single-line strings, a rendered prompt never is.
 */

import { toWellFormedUnicode, truncateWellFormed } from "./well-formed.ts";

/**
 * Render a reference for user-facing text: quoted only when it is name-shaped
 * (non-empty, single line, ≤64 chars), otherwise the neutral `fallback` noun.
 */
export function describeUserReference(
	reference: string,
	fallback: string,
): string {
	const safeRef = typeof reference === "string" ? reference : "";
	const safeFallback = typeof fallback === "string" ? fallback : "target";
	const trimmed = safeRef.trim();
	const nameShaped =
		trimmed.length > 0 && trimmed.length <= 64 && !/[\r\n]/.test(trimmed);
	return nameShaped ? `"${trimmed}"` : safeFallback;
}

/**
 * Render a reference for logs and machine-facing text/data, where the actual
 * value matters but a blob must never travel whole: whitespace collapsed to
 * one line, clamped to 120 chars with a trailing ellipsis.
 */
export function userReferenceLogView(reference: string): string {
	const safeRef = typeof reference === "string" ? reference : "";
	const collapsed = toWellFormedUnicode(safeRef.replace(/\s+/g, " ").trim());
	if (collapsed.length <= 120) {
		return collapsed;
	}
	return `${truncateWellFormed(collapsed, 119).trimEnd()}…`;
}
