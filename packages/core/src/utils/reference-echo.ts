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

/**
 * Render a reference for user-facing text: quoted only when it is name-shaped
 * (non-empty, single line, ≤64 chars), otherwise the neutral `fallback` noun.
 */
export function describeUserReference(
	reference: string,
	fallback: string,
): string {
	const trimmed = reference.trim();
	const nameShaped =
		trimmed.length > 0 && trimmed.length <= 64 && !/[\r\n]/.test(trimmed);
	return nameShaped ? `"${trimmed}"` : fallback;
}

/**
 * Render a reference for logs and machine-facing text/data, where the actual
 * value matters but a blob must never travel whole: whitespace collapsed to
 * one line, clamped to 120 chars with a trailing ellipsis.
 */
export function userReferenceLogView(reference: string): string {
	const collapsed = reference.replace(/\s+/g, " ").trim();
	return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
}
