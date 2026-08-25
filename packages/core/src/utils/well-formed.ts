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
/**
 * Node/slot ceiling. Text length does not consume visits, so this still permits
 * very large transcripts while rejecting pathological object graphs and sparse
 * arrays before provider serialization must walk them.
 */
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

function reserveVisits(ctx: WalkCtx, count: number): void {
	if (count > MAX_WELL_FORMED_VISITS - ctx.visits) {
		failUnbounded("visits", {
			visits: ctx.visits + count,
			max: MAX_WELL_FORMED_VISITS,
		});
	}
	ctx.visits += count;
}

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

function failUnsafeValue(
	operation: "accessor" | "reflection",
	cause?: unknown,
	key?: string,
): never {
	throw new ElizaError(
		operation === "accessor"
			? "deepToWellFormedUnicode: enumerable accessor cannot be serialized safely"
			: "deepToWellFormedUnicode: value cannot be inspected safely",
		{
			code: "WELL_FORMED_UNSAFE_VALUE",
			cause,
			// The key name is load-bearing diagnosis: without it the producer of
			// the accessor property is unfindable from the error alone.
			context: {
				operation,
				...(key !== undefined ? { propertyName: key } : {}),
			},
			severity: "fatal",
		},
	);
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
	ownKeys: readonly (string | symbol)[],
): T {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const sanitized = walkDeep(item, depth + 1, ctx, true);
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
	for (const key of ownKeys) {
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
		// JSON.stringify would execute an enumerable accessor. Reject it without
		// observation so a provider request can never run caller-controlled code.
		if (!("value" in descriptor)) {
			failUnsafeValue("accessor", undefined, String(key));
		}
		const entry = descriptor.value;
		const sanitizedValue = walkDeep(entry, depth + 1, ctx, true);
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

function walkDeep<T>(
	value: T,
	depth: number,
	ctx: WalkCtx,
	visitAlreadyReserved = false,
): T {
	if (!visitAlreadyReserved) reserveVisits(ctx, 1);
	if (typeof value === "string") {
		return toWellFormedUnicode(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		enterContainer(value, depth, ctx);
		try {
			// JSON serialization visits every array index, including holes. Reserve
			// the whole logical length before mapping so a huge sparse array cannot
			// bypass the budget or reach the provider serializer.
			reserveVisits(ctx, value.length);
			let changed = false;
			const next = value.map((item) => {
				const sanitized = walkDeep(item, depth + 1, ctx, true);
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
		enterContainer(value, depth, ctx);
		try {
			const ownKeys = Reflect.ownKeys(value);
			// Reserve before reading getters or walking children. Descriptor-bearing
			// objects also copy symbols/non-enumerables, so every own key counts.
			reserveVisits(ctx, ownKeys.length);
			const needsDescriptorPreservingClone = ownKeys.some((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				return (
					typeof key === "symbol" ||
					Boolean(descriptor && !("value" in descriptor)) ||
					typeof descriptor?.value === "function"
				);
			});
			if (needsDescriptorPreservingClone) {
				return sanitizeObjectPreservingDescriptors(value, depth, ctx, ownKeys);
			}
			let changed = false;
			const next = Object.create(null) as Record<string, unknown>;
			for (const key of ownKeys) {
				if (typeof key !== "string") continue;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) continue;
				const entry = descriptor.value;
				const sanitizedKey = toWellFormedUnicode(key);
				const sanitized = walkDeep(entry, depth + 1, ctx, true);
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
	try {
		return walkDeep(value, 0, { visits: 0, visiting: new WeakSet<object>() });
	} catch (error) {
		// error-policy:J2 Reflection on a revoked or hostile Proxy is translated
		// into the same typed provider-boundary failure contract.
		if (error instanceof ElizaError) throw error;
		return failUnsafeValue("reflection", error);
	}
}

/**
 * JSON-schema keywords whose values are arbitrary caller JSON data rather than
 * sub-schemas. The Cerebras normalizer and `sanitizeJsonSchema` both leave
 * these untouched, so the schema-shaped Unicode walk below carries them by
 * reference as well: annotation getters are never observed, and annotation
 * depth never consumes the schema walk budget.
 */
const SCHEMA_ANNOTATION_KEYS = new Set(["default", "examples", "const"]);
function isAnnotationKey(key: string): boolean {
	return SCHEMA_ANNOTATION_KEYS.has(key) || key.startsWith("x-");
}

type SchemaWalkCtx = WalkCtx & { maxDepth: number };

/**
 * Well-formed-Unicode pass that follows ONLY the JSON-schema keyword structure.
 *
 * `deepToWellFormedUnicode` counts every intermediate container (`properties`
 * maps, array wrappers) toward its depth budget, so a legal schema at the
 * Cerebras walk boundary (~64 nested schema nodes) exceeds it long before the
 * provider contract does. This walker instead uses the SAME accounting as the
 * Cerebras normalizer: one depth unit per schema node reached through a
 * schema-bearing keyword, annotation subtrees skipped entirely (carried by
 * reference), string keys and values sanitized along the walked structure.
 *
 * Cycles, accessor properties on walked nodes, reflection failures on revoked
 * proxies, and exceeding `maxDepth` fail closed with the same typed errors as
 * {@link deepToWellFormedUnicode} (`WELL_FORMED_UNBOUNDED` /
 * `WELL_FORMED_UNSAFE_VALUE`) so callers keep one failure contract.
 */
export function wellFormedUnicodeSchemaStructure<T>(
	value: T,
	options: { maxDepth?: number } = {},
): T {
	const ctx: SchemaWalkCtx = {
		visits: 0,
		visiting: new WeakSet<object>(),
		maxDepth: options.maxDepth ?? MAX_WELL_FORMED_DEPTH,
	};
	try {
		return walkSchemaStrings(value, 0, ctx);
	} catch (error) {
		if (error instanceof ElizaError) throw error;
		return failUnsafeValue("reflection", error);
	}
}

function failSchemaDepth(depth: number, ctx: SchemaWalkCtx): never {
	throw new ElizaError("deepToWellFormedUnicode: nesting exceeds cap", {
		code: "WELL_FORMED_UNBOUNDED",
		context: { reason: "depth", depth, max: ctx.maxDepth },
		severity: "fatal",
	});
}

const SCHEMA_MAP_KEYWORDS = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
	"dependencies",
]);
const SCHEMA_ARRAY_WRAPPER_KEYWORDS = new Set([
	"anyOf",
	"oneOf",
	"allOf",
	"prefixItems",
]);

function walkSchemaStrings<T>(value: T, depth: number, ctx: SchemaWalkCtx): T {
	reserveVisits(ctx, 1);
	if (typeof value === "string") {
		return toWellFormedUnicode(value) as unknown as T;
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	if (depth > ctx.maxDepth) {
		failSchemaDepth(depth, ctx);
	}
	if (ctx.visiting.has(value)) {
		failUnbounded("cycle", { depth });
	}
	ctx.visiting.add(value);
	try {
		if (Array.isArray(value)) {
			let changed = false;
			const next = new Array<unknown>(value.length);
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (!descriptor || !("value" in descriptor)) continue;
				const walked = walkSchemaStrings(descriptor.value, depth + 1, ctx);
				if (walked !== descriptor.value) changed = true;
				next[index] = walked;
			}
			return (changed ? next : value) as unknown as T;
		}
		let changed = false;
		const next = Object.create(Object.getPrototypeOf(value)) as Record<
			string,
			unknown
		>;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) {
				failUnsafeValue("accessor", undefined, key);
			}
			const sanitizedKey = toWellFormedUnicode(key);
			// Annotation data is opaque caller JSON: carried by reference, never
			// descended into, never observed.
			if (isAnnotationKey(sanitizedKey)) {
				next[sanitizedKey] = descriptor.value;
				continue;
			}
			// Mirror the Cerebras normalizer depth accounting: a MAP keyword's
			// container and an ARRAY keyword wrapper consume no level; their
			// member schemas get depth + 1 directly.
			let walked: unknown;
			if (
				SCHEMA_MAP_KEYWORDS.has(sanitizedKey) &&
				descriptor.value &&
				typeof descriptor.value === "object" &&
				!Array.isArray(descriptor.value)
			) {
				walked = walkSchemaMapEntry(descriptor.value as object, depth, ctx);
			} else if (
				(SCHEMA_ARRAY_WRAPPER_KEYWORDS.has(sanitizedKey) ||
					sanitizedKey === "items" ||
					sanitizedKey === "prefixItems") &&
				Array.isArray(descriptor.value)
			) {
				walked = walkSchemaArrayEntry(descriptor.value, depth, ctx);
			} else {
				walked = walkSchemaStrings(descriptor.value, depth + 1, ctx);
			}
			if (sanitizedKey !== key || walked !== descriptor.value) changed = true;
			next[sanitizedKey] = walked;
		}
		return (changed ? next : value) as unknown as T;
	} finally {
		ctx.visiting.delete(value);
	}
}

/**
 * Typed wire-boundary check for schema annotation data. Descriptor-only:
 * accessors are detected through `Object.getOwnPropertyDescriptor` and rejected
 * WITHOUT invocation, cycles are detected through path-local ancestry, and
 * depth beyond `maxDepth` fails closed — so a hostile annotation cannot run
 * caller-controlled code during a mere admissibility check. Reflection on a
 * revoked proxy is translated into the same typed contract.
 */
export function assertSchemaAnnotationsSerializable(
	value: unknown,
	options: { maxDepth?: number } = {},
): void {
	const ctx: SchemaWalkCtx = {
		visits: 0,
		visiting: new WeakSet<object>(),
		maxDepth: options.maxDepth ?? MAX_WELL_FORMED_DEPTH,
	};
	try {
		assertAnnotationsWalk(value, 0, ctx);
	} catch (error) {
		if (error instanceof ElizaError) throw error;
		failUnsafeValue("reflection", error);
	}
}

function walkSchemaMapEntry(
	map: object,
	depth: number,
	ctx: SchemaWalkCtx,
): Record<string, unknown> {
	if (depth > ctx.maxDepth) failSchemaDepth(depth, ctx);
	reserveVisits(ctx, 1);
	let changed = false;
	const next: Record<string, unknown> = Object.create(
		Object.getPrototypeOf(map),
	) as Record<string, unknown>;
	for (const key of Reflect.ownKeys(map)) {
		if (typeof key !== "string") continue;
		const descriptor = Object.getOwnPropertyDescriptor(map, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) continue;
		const sanitizedKey = toWellFormedUnicode(key);
		const walked = walkSchemaStrings(descriptor.value, depth + 1, ctx);
		if (sanitizedKey !== key || walked !== descriptor.value) changed = true;
		next[sanitizedKey] = walked;
	}
	return (changed ? next : map) as Record<string, unknown>;
}

function walkSchemaArrayEntry(
	arr: unknown[],
	depth: number,
	ctx: SchemaWalkCtx,
): unknown[] {
	if (depth > ctx.maxDepth) failSchemaDepth(depth, ctx);
	reserveVisits(ctx, arr.length || 1);
	let changed = false;
	const next = new Array<unknown>(arr.length);
	for (let index = 0; index < arr.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(arr, index);
		if (!descriptor || !("value" in descriptor)) continue;
		const walked = walkSchemaStrings(descriptor.value, depth + 1, ctx);
		if (walked !== descriptor.value) changed = true;
		next[index] = walked;
	}
	return changed ? next : arr;
}
function assertAnnotationsWalk(
	value: unknown,
	depth: number,
	ctx: SchemaWalkCtx,
): void {
	reserveVisits(ctx, 1);
	if (!value || typeof value !== "object") return;
	if (depth > ctx.maxDepth) {
		failSchemaDepth(depth, ctx);
	}
	if (ctx.visiting.has(value)) {
		failUnbounded("cycle", { depth });
	}
	ctx.visiting.add(value);
	try {
		let keys: PropertyKey[] = [];
		try {
			keys = Reflect.ownKeys(value);
		} catch (cause) {
			failUnsafeValue("reflection", cause);
		}
		for (const key of keys) {
			if (typeof key !== "string") continue;
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(value, key);
			} catch (cause) {
				failUnsafeValue("reflection", cause, key);
			}
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) {
				failUnsafeValue("accessor", undefined, key);
			}
			assertAnnotationsWalk(descriptor.value, depth + 1, ctx);
		}
	} finally {
		ctx.visiting.delete(value);
	}
}
