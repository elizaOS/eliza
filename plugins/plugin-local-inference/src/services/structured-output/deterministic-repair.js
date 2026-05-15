function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isWhitespace(ch) {
	return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}
function skipWs(text, start) {
	let i = start;
	while (i < text.length && isWhitespace(text[i])) i += 1;
	return i;
}
function scanJsonStringEnd(text, start) {
	if (text[start] !== '"') return null;
	let escaped = false;
	for (let i = start + 1; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') return i + 1;
	}
	return null;
}
function scanJsonValueEnd(text, start) {
	let i = skipWs(text, start);
	if (i >= text.length) return null;
	const first = text[i];
	if (first === '"') return scanJsonStringEnd(text, i);
	if (first === "{" || first === "[") {
		const stack = [first];
		let inString = false;
		let escaped = false;
		for (i += 1; i < text.length; i += 1) {
			const ch = text[i];
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (ch === "\\") {
					escaped = true;
				} else if (ch === '"') {
					inString = false;
				}
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === "{" || ch === "[") {
				stack.push(ch);
				continue;
			}
			if (ch === "}" || ch === "]") {
				const open = stack.pop();
				if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
					return null;
				}
				if (stack.length === 0) return i + 1;
			}
		}
		return null;
	}
	const literal = text.slice(i);
	for (const value of ["true", "false", "null"]) {
		if (literal.startsWith(value)) return i + value.length;
	}
	const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(
		literal,
	);
	return numberMatch ? i + numberMatch[0].length : null;
}
function enumOutputs(span, prev, next) {
	const values =
		Array.isArray(span.enumValues) && span.enumValues.length > 0
			? span.enumValues
			: span.value !== undefined
				? [span.value]
				: [];
	const prevLiteral = prev?.kind === "literal" ? (prev.value ?? "") : "";
	const nextLiteral = next?.kind === "literal" ? (next.value ?? "") : "";
	const rawInsideQuotes =
		prevLiteral.endsWith('"') && nextLiteral.startsWith('"');
	return values.map((value) =>
		rawInsideQuotes ? String(value) : JSON.stringify(String(value)),
	);
}
function uniquePrefixCompletion(remainder, candidates) {
	const matches = candidates.filter((candidate) =>
		candidate.startsWith(remainder),
	);
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		if (matches.every((candidate) => candidate === remainder)) {
			return { value: remainder, complete: true };
		}
		return "ambiguous";
	}
	return { value: matches[0], complete: matches[0] === remainder };
}
function analyzeObjectPrefix(text) {
	let i = skipWs(text, 0);
	if (text[i] !== "{")
		return { closed: false, keys: new Set(), invalid: "not-object" };
	i += 1;
	const keys = new Set();
	for (;;) {
		i = skipWs(text, i);
		if (i >= text.length) return { closed: false, keys };
		if (text[i] === "}") {
			return { closed: true, keys };
		}
		const keyStart = i;
		const keyEnd = scanJsonStringEnd(text, keyStart);
		if (keyEnd === null) return { closed: false, keys };
		let key;
		try {
			key = JSON.parse(text.slice(keyStart, keyEnd));
		} catch {
			return { closed: false, keys, invalid: "bad-key" };
		}
		i = skipWs(text, keyEnd);
		if (text[i] !== ":") {
			return i >= text.length
				? { closed: false, keys }
				: { closed: false, keys, invalid: "missing-colon" };
		}
		i = skipWs(text, i + 1);
		const valueEnd = scanJsonValueEnd(text, i);
		if (valueEnd === null) return { closed: false, keys };
		keys.add(key);
		i = skipWs(text, valueEnd);
		if (i >= text.length) {
			return { closed: false, keys, valueCompleteAtEnd: true };
		}
		if (text[i] === ",") {
			i += 1;
			continue;
		}
		if (text[i] === "}") {
			return { closed: true, keys };
		}
		if (text[i] === '"') {
			return { closed: false, keys, insertCommaAt: valueEnd };
		}
		if (text[i] === ";" && text[skipWs(text, i + 1)] === '"') {
			return { closed: false, keys, replaceSeparatorAt: i };
		}
		return { closed: false, keys, invalid: "bad-separator" };
	}
}
function schemaEnumSingleValue(schema) {
	const values = isRecord(schema) ? schema.enum : undefined;
	return Array.isArray(values) && values.length === 1
		? String(values[0])
		: null;
}
function deterministicValueForSchema(schema) {
	const singleEnum = schemaEnumSingleValue(schema);
	if (singleEnum !== null) return JSON.stringify(singleEnum);
	if (!isRecord(schema)) return null;
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	return null;
}
function repairJsonObjectAgainstSchema(text, schema) {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required)
		? schema.required.filter((key) => typeof key === "string")
		: [];
	if (required.length === 0) return { text, status: "unchanged" };
	let repaired = text;
	for (;;) {
		const analysis = analyzeObjectPrefix(repaired);
		if (analysis.insertCommaAt !== undefined) {
			repaired =
				repaired.slice(0, analysis.insertCommaAt) +
				"," +
				repaired.slice(analysis.insertCommaAt);
			continue;
		}
		if (analysis.replaceSeparatorAt !== undefined) {
			repaired =
				repaired.slice(0, analysis.replaceSeparatorAt) +
				"," +
				repaired.slice(analysis.replaceSeparatorAt + 1);
			continue;
		}
		break;
	}
	repaired = repaired.replace(/,([ \t\r\n]+)(?=")/g, ",");
	const analysis = analyzeObjectPrefix(repaired);
	if (analysis.invalid) {
		return { text, status: "invalid", reason: analysis.invalid };
	}
	const missing = required.filter((key) => !analysis.keys.has(key));
	if (missing.length === 0) {
		if (analysis.closed) {
			return {
				text: repaired,
				status: repaired === text ? "unchanged" : "repaired",
			};
		}
		if (analysis.valueCompleteAtEnd) {
			return { text: `${repaired}}`, status: "repaired" };
		}
		return {
			text: repaired,
			status: repaired === text ? "unchanged" : "repaired",
		};
	}
	const nextKey = missing[0];
	const value = deterministicValueForSchema(properties[nextKey]);
	if (value === null) {
		return repaired === text
			? {
					text,
					status: "unchanged",
					reason: "missing-required-value-ambiguous",
				}
			: { text: repaired, status: "repaired" };
	}
	const needsComma = analysis.keys.size > 0;
	const member = `${needsComma ? "," : ""}${JSON.stringify(nextKey)}:${value}`;
	if (analysis.closed) {
		const close = repaired.lastIndexOf("}");
		const next = `${repaired.slice(0, close)}${member}${repaired.slice(close)}`;
		return repairJsonObjectAgainstSchema(next, schema);
	}
	if (analysis.valueCompleteAtEnd || repaired.trimEnd().endsWith("{")) {
		return repairJsonObjectAgainstSchema(`${repaired}${member}`, schema);
	}
	return {
		text: repaired,
		status: repaired === text ? "ambiguous" : "repaired",
	};
}
function completeSkeleton(text, skeleton, schemasByKey) {
	let out = text;
	let pos = 0;
	const spans = skeleton.spans;
	for (let i = 0; i < spans.length; i += 1) {
		const span = spans[i];
		if (span.kind === "literal") {
			const literal = span.value ?? "";
			const remainder = out.slice(pos);
			if (remainder.length >= literal.length) {
				if (remainder.startsWith(literal)) {
					pos += literal.length;
					continue;
				}
				return { text, status: "invalid", reason: "literal-mismatch" };
			}
			if (literal.startsWith(remainder)) {
				out += literal.slice(remainder.length);
				pos += literal.length;
				continue;
			}
			return { text, status: "invalid", reason: "literal-prefix-mismatch" };
		}
		if (span.kind === "enum") {
			const candidates = enumOutputs(span, spans[i - 1], spans[i + 1]);
			const remainder = out.slice(pos);
			const match = uniquePrefixCompletion(remainder, candidates);
			if (match === "ambiguous") {
				return { text, status: "ambiguous", reason: "enum-prefix-ambiguous" };
			}
			if (!match) {
				const exact = candidates.find((candidate) =>
					remainder.startsWith(candidate),
				);
				if (!exact) return { text, status: "invalid", reason: "enum-mismatch" };
				pos += exact.length;
				continue;
			}
			if (!match.complete) out = out.slice(0, pos) + match.value;
			pos += match.value.length;
			continue;
		}
		const valueEnd = scanJsonValueEnd(out, pos);
		if (valueEnd !== null) {
			pos = valueEnd;
			continue;
		}
		if (span.kind === "free-json" && span.key && schemasByKey?.[span.key]) {
			const repaired = repairJsonObjectAgainstSchema(
				out.slice(pos),
				schemasByKey[span.key],
			);
			if (
				repaired.text !== out.slice(pos) &&
				repaired.text.startsWith(out.slice(pos))
			) {
				out = out.slice(0, pos) + repaired.text;
				const repairedEnd = scanJsonValueEnd(out, pos);
				if (repairedEnd !== null) {
					pos = repairedEnd;
					continue;
				}
			}
		}
		return {
			text: out,
			status: out === text ? "unchanged" : "repaired",
			reason: "free-span-incomplete",
		};
	}
	return { text: out, status: out === text ? "unchanged" : "repaired" };
}
export function repairStructuredOutput(text, options) {
	let result = { text, status: "unchanged" };
	if (options.jsonSchema) {
		result = repairJsonObjectAgainstSchema(result.text, options.jsonSchema);
	}
	if (options.skeleton) {
		result = completeSkeleton(
			result.text,
			options.skeleton,
			options.jsonSchemasByKey,
		);
	}
	return result;
}
function commonPrefixLength(a, b) {
	const max = Math.min(a.length, b.length);
	let i = 0;
	while (i < max && a[i] === b[i]) i += 1;
	return i;
}
export class StructuredOutputRepairStream {
	options;
	text = "";
	syntheticTail = "";
	constructor(options) {
		this.options = options;
	}
	push(chunk) {
		if (!chunk) return "";
		let incoming = chunk;
		if (this.syntheticTail.length > 0) {
			const shared = commonPrefixLength(this.syntheticTail, incoming);
			this.syntheticTail = this.syntheticTail.slice(shared);
			incoming = incoming.slice(shared);
		}
		if (!incoming) return "";
		this.text += incoming;
		const repaired = repairStructuredOutput(this.text, this.options);
		if (!repaired.text.startsWith(this.text)) return incoming;
		const addition = repaired.text.slice(this.text.length);
		this.text = repaired.text;
		this.syntheticTail += addition;
		return incoming + addition;
	}
	flush() {
		const repaired = repairStructuredOutput(this.text, this.options);
		if (!repaired.text.startsWith(this.text)) return "";
		const addition = repaired.text.slice(this.text.length);
		this.text = repaired.text;
		this.syntheticTail += addition;
		return addition;
	}
	currentText() {
		return this.text;
	}
}
//# sourceMappingURL=deterministic-repair.js.map
