/**
 * Well-formed Unicode guarantees for text that is truncated at an arbitrary
 * UTF-16 index or serialized into a provider request body. A `.slice()` that
 * lands mid-emoji leaves a lone surrogate; `JSON.stringify` emits it as a
 * `\uD8xx` escape that strict JSON parsers (Cerebras/serde: "lone leading
 * surrogate in hex escape", code `wrong_api_format`) reject with HTTP 400.
 * Truncation helpers here never create a lone surrogate, and the sanitizers
 * replace any pre-existing lone surrogate with U+FFFD so a wire request is
 * always well-formed regardless of upstream text handling.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const REPLACEMENT_CHARACTER = "�";

function isHighSurrogate(code: number): boolean {
	return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
	return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

// ES2024 natives; typed locally because some package tsconfigs pin lib < ES2024.
const nativeToWellFormed = (
	String.prototype as { toWellFormed?: (this: string) => string }
).toWellFormed;
const nativeIsWellFormed = (
	String.prototype as { isWellFormed?: (this: string) => boolean }
).isWellFormed;

function replaceLoneSurrogates(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (isHighSurrogate(code)) {
			if (i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
				out += text[i] + text[i + 1];
				i++;
			} else {
				out += REPLACEMENT_CHARACTER;
			}
		} else if (isLowSurrogate(code)) {
			out += REPLACEMENT_CHARACTER;
		} else {
			out += text[i];
		}
	}
	return out;
}

/**
 * Returns `text` with every lone surrogate replaced by U+FFFD. Well-formed
 * input is returned as the same string instance (the native fast path scans
 * without allocating).
 */
export function toWellFormedUnicode(text: string): string {
	if (nativeToWellFormed) {
		return nativeToWellFormed.call(text);
	}
	if (nativeIsWellFormed?.call(text)) {
		return text;
	}
	return replaceLoneSurrogates(text);
}

/**
 * `text.slice(0, maxLength)` that never splits a surrogate pair: when the cut
 * would end on a high surrogate (the lead half of an emoji), the boundary
 * backs off by one code unit. Pre-existing lone surrogates are preserved —
 * sanitizing malformed input is {@link toWellFormedUnicode}'s job.
 */
export function truncateWellFormed(text: string, maxLength: number): string {
	if (maxLength <= 0) {
		return "";
	}
	if (text.length <= maxLength) {
		return text;
	}
	const end =
		isHighSurrogate(text.charCodeAt(maxLength - 1)) &&
		isLowSurrogate(text.charCodeAt(maxLength))
			? maxLength - 1
			: maxLength;
	return text.slice(0, end);
}

/**
 * Keeps the LAST `maxLength` code units of `text` without starting on the low
 * half of a split surrogate pair (the tail-side dual of
 * {@link truncateWellFormed}).
 */
export function tailWellFormed(text: string, maxLength: number): string {
	if (maxLength <= 0) {
		return "";
	}
	if (text.length <= maxLength) {
		return text;
	}
	let start = text.length - maxLength;
	if (
		isLowSurrogate(text.charCodeAt(start)) &&
		isHighSurrogate(text.charCodeAt(start - 1))
	) {
		start++;
	}
	return text.slice(start);
}

/**
 * Sanitizes string-valued own properties of an object **in-place**, recursing
 * into nested plain objects and arrays. Used for objects that carry behavior
 * (function-valued properties such as AI SDK tool schemas or execute callbacks)
 * and must not be cloned onto a null-prototype object. Returns the same
 * reference.
 */
function sanitizeStringsInPlace<T>(value: T): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (typeof item === "string") {
				value[i] = toWellFormedUnicode(item) as typeof item;
			} else {
				sanitizeStringsInPlace(item);
			}
		}
		return value;
	}
	const obj = value as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		const entry = obj[key];
		if (typeof entry === "string") {
			obj[key] = toWellFormedUnicode(entry);
		} else {
			sanitizeStringsInPlace(entry);
		}
	}
	return value;
}

/**
 * Recursively applies {@link toWellFormedUnicode} to every string in a
 * JSON-shaped value — including **object keys**, which `Object.entries`
 * skips by default. A key containing a lone surrogate (e.g.
 * `{"bad\uD83D": "ok"}`) serializes to the same `\\uD8xx` escape that strict
 * provider JSON parsers reject.
 *
 * The clone is built on a null-prototype object with `Object.defineProperty`
 * so an own `__proto__` key from a JSON-parsed input is preserved as a data
 * member instead of mutating the clone's prototype chain. A collision policy
 * (first-write-wins) prevents two distinct keys from collapsing onto the same
 * sanitized form. Non-plain objects (typed arrays, URLs, class instances such
 * as AI SDK model handles) pass through untouched, and untouched subtrees keep
 * their original references so a clean input returns the same instance.
 * Intended for provider request bodies right before serialization.
 */
export function deepToWellFormedUnicode<T>(value: T): T {
	if (typeof value === "string") {
		return toWellFormedUnicode(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const sanitized = deepToWellFormedUnicode(item);
			if (sanitized !== item) {
				changed = true;
			}
			return sanitized;
		});
		return (changed ? next : value) as T;
	}
	if (value !== null && typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			return value;
		}
		// Objects that carry SDK-identifying symbols or function-valued
		// properties (e.g. AI SDK jsonSchema wrappers, tool execute callbacks)
		// must not be cloned onto a null-prototype object — cloning drops
		// non-enumerable symbol properties and breaks SDK contract checks
		// (asSchema throws "schema is not a function"). Sanitize their
		// string-valued own properties in-place instead (#18081).
		if (
			Object.getOwnPropertySymbols(value).length > 0 ||
			Object.values(value).some((v) => typeof v === "function")
		) {
			return sanitizeStringsInPlace(value);
		}
		let changed = false;
		const next = Object.create(null) as Record<string, unknown>;
		for (const [key, entry] of Object.entries(value)) {
			const sanitizedKey = toWellFormedUnicode(key);
			const sanitized = deepToWellFormedUnicode(entry);
			if (sanitizedKey !== key || sanitized !== entry) {
				changed = true;
			}
			if (!(sanitizedKey in next)) {
				Object.defineProperty(next, sanitizedKey, {
					value: sanitized,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
		}
		// Re-attach Object.prototype so downstream code that relies on
		// hasOwnProperty/toString still works — but only if the original
		// input didn't define an own `__proto__` key. Note: `"__proto__" in
		// value` is always true for Object.prototype-backed objects (the
		// property is inherited), so use Object.hasOwn to detect a genuine
		// own data key.
		if (!Object.hasOwn(value, "__proto__")) {
			Object.setPrototypeOf(next, Object.prototype);
		}
		return (changed ? next : value) as T;
	}
	return value;
}
