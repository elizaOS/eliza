const LOOPBACK_BIND_RE =
	/^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0:0:0:0:0:0:0:1|::ffff:127(?:\.\d{1,3}){3})$/i;
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/i;

export function stripOptionalHostPort(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";

	const lower = trimmed.toLowerCase();
	if (lower.startsWith("http://") || lower.startsWith("https://")) {
		try {
			return new URL(lower).hostname.toLowerCase();
		} catch {
			// error-policy:J3 malformed host input remains untrusted and is rejected.
			return lower;
		}
	}

	if (lower.startsWith("[")) {
		const close = lower.indexOf("]");
		return close > 0 ? lower.slice(1, close) : lower.slice(1);
	}

	if ((lower.match(/:/g) || []).length >= 2) {
		return lower;
	}

	return lower.replace(/:\d+$/, "");
}

export function isLoopbackBindHost(host: string): boolean {
	const normalized = stripOptionalHostPort(host);
	if (!normalized) return true;
	if (!LOOPBACK_BIND_RE.test(normalized)) return false;
	const ipv4 = normalized.startsWith("::ffff:")
		? normalized.slice("::ffff:".length)
		: normalized;
	if (/^127(?:\.\d{1,3}){3}$/.test(ipv4)) {
		return ipv4
			.split(".")
			.every(
				(octet) => Number.isInteger(Number(octet)) && Number(octet) <= 255,
			);
	}
	return true;
}

export function isWildcardBindHost(host: string): boolean {
	const normalized = stripOptionalHostPort(host);
	return WILDCARD_BIND_RE.test(normalized);
}
