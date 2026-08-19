/**
 * Well-formed Unicode guarantees for text that is truncated at an arbitrary
 * UTF-16 index or serialized into a provider request body. A `.slice()` that
 * lands mid-emoji leaves a lone surrogate; `JSON.stringify` emits it as a
 * `\uD8xx` escape that strict JSON parsers (Cerebras/serde: "lone leading
 * surrogate in hex escape", code `wrong_api_format`) reject with HTTP 400.
 * Truncation helpers here never create a lone surrogate, and the sanitizers
 * replace any pre-existing lone surrogate with U+FFFD so a wire request is
 * always well-formed regardless of upstream text handling.
 *
 * `deepToWellFormedUnicode` is depth-, visit-, and cycle-bounded. OpenAI and
 * Anthropic text handlers call it on every request body; on origin a cyclic
 * object and a 20k-deep array both threw `RangeError: Maximum call stack`
 * and hung the turn. Over-budget input throws `ElizaError` `WELL_FORMED_UNBOUNDED`.
 */

import { ElizaError } from "../errors.ts";

/** Nesting ceiling. Honest provider bodies are a handful of objects deep. */
export const MAX_WELL_FORMED_DEPTH = 64;
/** Node visit ceiling so a wide hostile tree cannot pin a model call. */
export const MAX_WELL_FORMED_VISITS = 65_536;

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
	if (!Number.isFinite(maxLength) || maxLength <= 0) {
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
	if (!Number.isFinite(maxLength) || maxLength <= 0) {
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

type WalkCtx = {
	visits: number;
	visiting: WeakSet<object>;
};

function failUnbounded(
	reason: "depth" | "cycle" | "visits",
	context: Record<string, unknown>,
): never {
	const message =
		reason === "cycle"
			? "deepToWellFormedUnicode: cyclic object"
			: reason === "depth"
				? "deepToWellFormedUnicode: nesting exceeds cap"
				: "deepToWellFormedUnicode: visit budget exceeded";
	throw new ElizaError(message, {
		code: "WELL_FORMED_UNBOUNDED",
		context: { reason, ...context },
		severity: "fatal",
	});
}

function enterContainer(value: object, depth: number, ctx: WalkCtx): void {
	if (depth >= MAX_WELL_FORMED_DEPTH) {
		failUnbounded("depth", { depth, max: MAX_WELL_FORMED_DEPTH });
	}
	if (ctx.visiting.has(value)) {
		failUnbounded("cycle", { depth });
	}
	ctx.visiting.add(value);
}

/**
 * Copy-on-write sanitizer for objects that carry SDK-identifying symbols or
 * function-valued or accessor properties (AI SDK tool schemas and execute
 * callbacks).
 *
 * Unlike the plain-object path in {@link walkDeep}, this builds a NEW object so
 * the caller's input is never mutated — even if frozen. String enumerable
 * string keys AND values are sanitized; non-enumerable and symbol properties
 * retain their original descriptors; nested enumerable values are routed
 * through {@link walkDeep}. Returns the same reference when nothing needed
 * sanitizing.
 *
 * Key-safety policy mirrors the plain-object branch: the clone is built on a
 * null-prototype staging object with `Object.defineProperty` so an own
 * `__proto__` key is preserved as data. The source prototype is restored only
 * after all keys are defined, and a first-write-wins collision policy prevents
 * distinct keys from collapsing onto the same sanitized form.
 */
function sanitizeObjectPreservingDescriptors<T>(
	value: T,
	depth: number,
	ctx: WalkCtx,
): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const sanitized = walkDeep(item, depth + 1, ctx);
			if (sanitized !== item) {
				changed = true;
			}
			return sanitized;
		});
		return (changed ? next : value) as T;
	}
	const source = value as Record<PropertyKey, unknown>;
	const clone = Object.create(null) as Record<PropertyKey, unknown>;
	let changed = false;
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (!descriptor) {
			continue;
		}

		// Symbols and non-enumerable string members do not enter a JSON body.
		// Preserve them byte-for-byte because SDK identity markers, callbacks,
		// and lazy metadata commonly live there.
		if (typeof key === "symbol" || !descriptor.enumerable) {
			Object.defineProperty(clone, key, descriptor);
			continue;
		}

		const sanitizedKey = toWellFormedUnicode(key);
		const entry = "value" in descriptor ? descriptor.value : source[key];
		const sanitizedValue = walkDeep(entry, depth + 1, ctx);
		if (sanitizedKey !== key || sanitizedValue !== entry) {
			changed = true;
		}
		if (!Object.hasOwn(clone, sanitizedKey)) {
			const sanitizedDescriptor: PropertyDescriptor =
				"value" in descriptor
					? { ...descriptor, value: sanitizedValue }
					: sanitizedValue === entry
						? descriptor
						: {
								value: sanitizedValue,
								writable: true,
								enumerable: descriptor.enumerable,
								configurable: descriptor.configurable,
							};
			Object.defineProperty(clone, sanitizedKey, {
				...sanitizedDescriptor,
			});
		}
	}
	Object.setPrototypeOf(clone, Object.getPrototypeOf(source));
	return (changed ? clone : value) as T;
}

function walkDeep<T>(value: T, depth: number, ctx: WalkCtx): T {
	ctx.visits += 1;
	if (ctx.visits > MAX_WELL_FORMED_VISITS) {
		failUnbounded("visits", {
			visits: ctx.visits,
			max: MAX_WELL_FORMED_VISITS,
		});
	}
	if (typeof value === "string") {
		return toWellFormedUnicode(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		enterContainer(value, depth, ctx);
		try {
			let changed = false;
			const next = value.map((item) => {
				const sanitized = walkDeep(item, depth + 1, ctx);
				if (sanitized !== item) {
					changed = true;
				}
				return sanitized;
			});
			return (changed ? next : value) as T;
		} finally {
			ctx.visiting.delete(value);
		}
	}
	if (value !== null && typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			return value;
		}
		// Objects that carry SDK-identifying symbols, function-valued
		// properties, or accessors (e.g. AI SDK jsonSchema wrappers and tool
		// execute callbacks)
		// must not be cloned onto a null-prototype object — cloning drops
		// non-enumerable symbol properties and breaks SDK contract checks
		// (asSchema throws "schema is not a function"). Sanitize their
		// string-valued own properties in-place instead (#18081).
		const needsDescriptorPreservingClone = Reflect.ownKeys(value).some(
			(key) => {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				return (
					typeof key === "symbol" ||
					Boolean(descriptor && !("value" in descriptor)) ||
					typeof descriptor?.value === "function"
				);
			},
		);
		enterContainer(value, depth, ctx);
		try {
			if (needsDescriptorPreservingClone) {
				return sanitizeObjectPreservingDescriptors(value, depth, ctx);
			}
			let changed = false;
			const next = Object.create(null) as Record<string, unknown>;
			for (const [key, entry] of Object.entries(value)) {
				const sanitizedKey = toWellFormedUnicode(key);
				const sanitized = walkDeep(entry, depth + 1, ctx);
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
			// Restore the source prototype after defining every own key. Staging on
			// a null prototype makes `__proto__` safe; restoring afterward preserves
			// the caller's Object.prototype/null-prototype contract.
			Object.setPrototypeOf(next, proto);
			return (changed ? next : value) as T;
		} finally {
			ctx.visiting.delete(value);
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
 *
 * Depth, visit count, and cycles fail closed with {@link ElizaError}
 * `WELL_FORMED_UNBOUNDED` so a hostile nest cannot hang the model call.
 */
export function deepToWellFormedUnicode<T>(value: T): T {
	return walkDeep(value, 0, { visits: 0, visiting: new WeakSet<object>() });
}
