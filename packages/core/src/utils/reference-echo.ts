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

import { toWellFormedUnicode, truncateWellFormed } from "./unicode.ts";

/**
 * Render a reference for user-facing text: quoted only when it is name-shaped
 * (non-empty, single line, ≤64 chars, and free of double quotes and control
 * characters), otherwise the neutral `fallback` noun. A `"` inside the
 * reference would close the quote early, and a control character (such as an
 * ANSI escape) would ride along verbatim into chat or logs, so neither is
 * name-shaped.
 */
export function describeUserReference(
	reference: string,
	fallback: string,
): string {
	const safeRef = typeof reference === "string" ? reference : "";
	const safeFallback = typeof fallback === "string" ? fallback : "target";
	const trimmed = toWellFormedUnicode(safeRef.trim());
	const nameShaped =
		trimmed.length > 0 &&
		trimmed.length <= 64 &&
		!/[\r\n\u2028\u2029]/.test(trimmed) &&
		!/["\p{Cc}]/u.test(trimmed);
	return nameShaped ? `"${trimmed}"` : safeFallback;
}

/** Renders a bounded reference for diagnostics and containment-sensitive machine data. Never use this where the complete semantic value is required. */
export function userReferenceLogView(reference: string): string {
	const safeRef = typeof reference === "string" ? reference : "";
	const collapsed = toWellFormedUnicode(safeRef.replace(/\s+/g, " ").trim());
	if (collapsed.length <= 120) {
		return collapsed;
	}
	return `${truncateWellFormed(collapsed, 119).trimEnd()}…`;
}

/**
 * Normalize a complete audited reference without semantic shortening. Use only
 * when the caller has already separated trusted/user payload from hardened
 * wrapper text or explicitly intends to retain the supplied model value.
 */
export function completeUserReferenceView(reference: string): string {
	const safeRef = typeof reference === "string" ? reference : "";
	return toWellFormedUnicode(safeRef.replace(/\s+/g, " ").trim());
}
