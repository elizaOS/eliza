/**
 * Linear structural email helpers for security/redaction paths.
 *
 * This intentionally preserves the common lightweight shape used in the old
 * regexes: one non-empty local part, one `@`, and a domain with an interior dot.
 * It is not an RFC validator.
 */
export function basicEmailValid(value: string): boolean {
	const at = value.indexOf("@");
	if (at <= 0 || at !== value.lastIndexOf("@")) return false;
	if (containsAsciiWhitespace(value)) return false;
	const domain = value.slice(at + 1);
	return domain.length >= 3 && domain.slice(1, -1).includes(".");
}

export function findBasicEmailSpans(
	text: string,
): ReadonlyArray<{ value: string; start: number; end: number }> {
	const spans: Array<{ value: string; start: number; end: number }> = [];
	let i = 0;

	while (i < text.length) {
		const at = text.indexOf("@", i);
		if (at === -1) break;

		let start = at - 1;
		while (start >= 0 && isEmailAtomChar(text.charCodeAt(start))) start -= 1;
		start += 1;

		let end = at + 1;
		while (end < text.length && isDomainChar(text.charCodeAt(end))) end += 1;
		while (end > at + 1) {
			const last = text.charCodeAt(end - 1);
			if (last !== 45 && last !== 46) break;
			end -= 1;
		}

		if (start < at && end > at + 1) {
			const value = text.slice(start, end);
			if (basicEmailValid(value)) {
				spans.push({ value, start, end });
			}
		}

		i = Math.max(end, at + 1);
	}

	return spans;
}

export function redactBasicEmails(
	text: string,
	replacement: string | ((value: string) => string) = "[EMAIL]",
): string {
	const spans = findBasicEmailSpans(text);
	if (spans.length === 0) return text;

	let out = "";
	let last = 0;
	for (const span of spans) {
		out += text.slice(last, span.start);
		out +=
			typeof replacement === "function" ? replacement(span.value) : replacement;
		last = span.end;
	}
	out += text.slice(last);
	return out;
}

function containsAsciiWhitespace(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (
			code === 9 ||
			code === 10 ||
			code === 11 ||
			code === 12 ||
			code === 13 ||
			code === 32
		) {
			return true;
		}
	}
	return false;
}

function isEmailAtomChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 33 ||
		code === 35 ||
		code === 36 ||
		code === 37 ||
		code === 38 ||
		code === 39 ||
		code === 42 ||
		code === 43 ||
		code === 45 ||
		code === 47 ||
		code === 63 ||
		code === 94 ||
		code === 95 ||
		code === 96 ||
		code === 123 ||
		code === 124 ||
		code === 125 ||
		code === 126 ||
		code === 46
	);
}

function isDomainChar(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 45 ||
		code === 46
	);
}
