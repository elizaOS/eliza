/**
 * Renderer diagnostic formatting and secret redaction.
 *
 * Extracted from rpc-handlers.ts so these functions can be unit-tested
 * without pulling in Electrobun native bindings.
 */

/**
 * Redact sensitive tokens from a URL string so API keys, auth tokens, and
 * secrets in query parameters never reach the log file.
 *
 * Patterns matched:
 *  - `?key=<value>&...` or `&key=<value>` for known param names
 *  - `sk-*`, `ghp_*`, `xox*` tokens anywhere in the string
 */
export function redactDiagnosticUrl(url: string): string {
	let redacted = url.replace(
		/([?&])(api[_-]?key|key|token|secret|access[_-]?token|authorization|auth|password|credential|client[_-]?secret)=([^&#]+)/gi,
		"$1$2=[redacted]",
	);
	redacted = redacted.replace(
		/\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|xox[bsrp]-[A-Za-z0-9-]+)\b/g,
		"[redacted-token]",
	);
	return redacted;
}

/**
 * Deep-walk a details object and redact any string value that looks like a URL
 * containing sensitive query params or token patterns. Returns a new object
 * (original is never mutated).
 */
export function redactDetailsSecrets(details: unknown): unknown {
	if (typeof details === "string") {
		return redactDiagnosticUrl(details);
	}
	if (Array.isArray(details)) {
		return details.map(redactDetailsSecrets);
	}
	if (details && typeof details === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(details)) {
			out[key] = typeof value === "string" ? redactDiagnosticUrl(value) : value;
		}
		return out;
	}
	return details;
}

export function formatRendererDiagnosticLine(
	params?: {
		source?: string;
		message?: string;
		details?: unknown;
	} | null,
): string {
	const source = params?.source ?? "renderer";
	const message = params?.message?.trim() || "(no message)";
	const redactedDetails = redactDetailsSecrets(params?.details);
	const details =
		typeof redactedDetails === "undefined"
			? ""
			: ` ${JSON.stringify(redactedDetails)}`;
	return `[Renderer:${source}] ${message}${details}`;
}
