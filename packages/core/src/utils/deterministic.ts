/**
 * Seeded deterministic helpers: an FNV-1a string hash, a reproducible PRNG, and
 * seed-driven shuffle/sample/pick plus example-name generation, all keyed by a
 * string or number seed so the same seed always yields the same result. Also
 * provides stableStringify — key-order-independent JSON for stable hashing/IDs.
 */

import { ElizaError } from "../errors.ts";
import { EXAMPLE_NAMES } from "./example-names";

export const MAX_STABLE_STRINGIFY_DEPTH = 64;
export const MAX_STABLE_STRINGIFY_NODES = 2048;
export const MAX_STABLE_STRINGIFY_EDGES = 2048;
export const MAX_STABLE_STRINGIFY_BYTES = 1_048_576; // 1 MiB serialized cap

export const STABLE_STRINGIFY_UNBOUNDED = "STABLE_STRINGIFY_UNBOUNDED";

export type StableStringifyReason =
	| "accessor"
	| "keys"
	| "utf8-length"
	| "date-brand"
	| "spread-budget"
	| "depth"
	| "nodes"
	| "edges"
	| "cycle"
	| "prototype"
	| "bytes";

type WalkCtx = {
	visits: number;
	edges: number;
	ancestors: WeakSet<object>;
};

function failUnbounded(
	reason: StableStringifyReason,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(`stableStringify: unbounded ${reason}`, {
		code: STABLE_STRINGIFY_UNBOUNDED,
		context: { reason, ...context },
		severity: "fatal",
	});
}

function failUnsafeAccessor(key: string): never {
	throw new ElizaError(
		`stableStringify: accessor property ${key} cannot be serialized safely`,
		{
			code: STABLE_STRINGIFY_UNBOUNDED,
			context: { reason: "accessor" as StableStringifyReason, key },
			severity: "fatal",
		},
	);
}

function reserveVisit(ctx: WalkCtx): void {
	ctx.visits += 1;
	if (ctx.visits > MAX_STABLE_STRINGIFY_NODES) {
		failUnbounded("nodes", {
			visits: ctx.visits,
			max: MAX_STABLE_STRINGIFY_NODES,
		});
	}
}

function reserveEdge(ctx: WalkCtx): void {
	ctx.edges += 1;
	if (ctx.edges > MAX_STABLE_STRINGIFY_EDGES) {
		failUnbounded("edges", {
			edges: ctx.edges,
			max: MAX_STABLE_STRINGIFY_EDGES,
		});
	}
}

function getOwnDataValue(
	source: Record<PropertyKey, unknown>,
	key: PropertyKey,
): unknown {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(source, key);
	} catch (error) {
		throw new ElizaError("stableStringify: cannot inspect property", {
			code: STABLE_STRINGIFY_UNBOUNDED,
			cause: error,
			context: {
				reason: "accessor" as StableStringifyReason,
				key: String(key),
			},
			severity: "fatal",
		});
	}
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) {
		failUnsafeAccessor(String(key));
	}
	return descriptor.value;
}

function getDateTimestamp(value: object): number | undefined {
	try {
		let tag: string;
		try {
			tag = Object.prototype.toString.call(value);
		} catch (error) {
			throw new ElizaError("stableStringify: date brand check failed", {
				code: STABLE_STRINGIFY_UNBOUNDED,
				cause: error,
				context: { reason: "date-brand" as StableStringifyReason },
				severity: "fatal",
			});
		}
		if (tag !== "[object Date]") return undefined;
		// Also guard Symbol.toStringTag poisoning path explicitly
		try {
			// Accessing Symbol.toStringTag may invoke accessor
			const maybeTag = (value as Record<symbol, unknown>)[Symbol.toStringTag];
			// We don't use maybeTag; just ensure access doesn't throw leaked error
			void maybeTag;
		} catch (error) {
			throw new ElizaError("stableStringify: date brand check failed", {
				code: STABLE_STRINGIFY_UNBOUNDED,
				cause: error,
				context: { reason: "date-brand" as StableStringifyReason },
				severity: "fatal",
			});
		}
		return Date.prototype.getTime.call(value);
	} catch (error) {
		if (error instanceof ElizaError) throw error;
		throw new ElizaError("stableStringify: date brand check failed", {
			code: STABLE_STRINGIFY_UNBOUNDED,
			cause: error,
			context: { reason: "date-brand" as StableStringifyReason },
			severity: "fatal",
		});
	}
}

function isPlainArray(value: unknown): boolean {
	try {
		return Array.isArray(value);
	} catch (error) {
		throw new ElizaError("stableStringify: array brand check failed", {
			code: STABLE_STRINGIFY_UNBOUNDED,
			cause: error,
			context: { reason: "prototype" as StableStringifyReason },
			severity: "fatal",
		});
	}
}

function sortStableBoundedInner(
	value: unknown,
	depth: number,
	ctx: WalkCtx,
): unknown {
	if (depth > MAX_STABLE_STRINGIFY_DEPTH) {
		failUnbounded("depth", { depth, max: MAX_STABLE_STRINGIFY_DEPTH });
	}
	reserveVisit(ctx);

	if (value === null || typeof value !== "object") {
		if (typeof value === "string") {
			// UTF-16 length precheck before any encoder allocation
			if (value.length * 3 > MAX_STABLE_STRINGIFY_BYTES) {
				failUnbounded("utf8-length", {
					length: value.length,
					estimatedBytes: value.length * 3,
					max: MAX_STABLE_STRINGIFY_BYTES,
				});
			}
			// Exact byte accounting via TextEncoder (bounded sink)
			const encoded = new TextEncoder().encode(value);
			if (encoded.byteLength > MAX_STABLE_STRINGIFY_BYTES) {
				failUnbounded("bytes", {
					bytes: encoded.byteLength,
					max: MAX_STABLE_STRINGIFY_BYTES,
				});
			}
			// Also check key budget for strings is not needed; nodes already counted
		}
		if (typeof value === "bigint") {
			// JSON.stringify would throw; keep same observable but bounded
			throw new TypeError("Do not know how to serialize a BigInt");
		}
		return value;
	}

	// Guarded Date check
	const ts = getDateTimestamp(value as object);
	if (ts !== undefined) {
		// Keep native Date#toJSON behavior via returning Date instance for JSON.stringify
		return value;
	}

	if (ctx.ancestors.has(value as object)) {
		failUnbounded("cycle", { depth });
	}

	if (isPlainArray(value)) {
		const arr = value as unknown[];
		ctx.ancestors.add(value as object);
		try {
			// Reserve edges for holes too
			for (let i = 0; i < arr.length; i += 1) {
				reserveEdge(ctx);
			}
			// Map preserving holes as null per JSON semantics is done via JSON.stringify later;
			// here we produce array with null for holes to keep deterministic
			const out: unknown[] = new Array(arr.length);
			for (let i = 0; i < arr.length; i += 1) {
				if (!(i in arr)) {
					out[i] = null;
					continue;
				}
				// Descriptor-safe read for index
				const v = getOwnDataValue(
					arr as unknown as Record<PropertyKey, unknown>,
					i,
				);
				out[i] = sortStableBoundedInner(v, depth + 1, ctx);
			}
			// Handle non-index own enumerable string props on arrays (rare) via descriptor walk
			let ownKeys: (string | symbol)[];
			try {
				ownKeys = Reflect.ownKeys(arr);
			} catch (error) {
				throw new ElizaError("stableStringify: cannot enumerate array keys", {
					code: STABLE_STRINGIFY_UNBOUNDED,
					cause: error,
					context: { reason: "keys" as StableStringifyReason },
					severity: "fatal",
				});
			}
			// If array has extra enumerable string keys beyond indices, merge them as object-like?
			// JSON.stringify ignores non-index props on arrays, so we ignore them too for compat.
			// But count them for budget.
			if (ownKeys.length > arr.length) {
				// Count extra edges for non-index keys
				for (const k of ownKeys) {
					if (typeof k === "string" && !/^\d+$/.test(k)) {
						reserveEdge(ctx);
					}
				}
			}
			return out;
		} finally {
			ctx.ancestors.delete(value as object);
		}
	}

	// Plain object path - stage on null prototype
	const proto = (() => {
		try {
			return Object.getPrototypeOf(value);
		} catch (error) {
			throw new ElizaError("stableStringify: cannot get prototype", {
				code: STABLE_STRINGIFY_UNBOUNDED,
				cause: error,
				context: { reason: "prototype" as StableStringifyReason },
				severity: "fatal",
			});
		}
	})();
	// For determinism, we canonicalize only plain objects; other protos pass through as-is? For bounded safety, treat non-plain as empty? Keep historical: sort any object.
	// But guard prototype pollution: stage on null prototype then restore.

	ctx.ancestors.add(value as object);
	try {
		let ownKeys: (string | symbol)[];
		try {
			ownKeys = Reflect.ownKeys(value as object);
		} catch (error) {
			throw new ElizaError("stableStringify: cannot enumerate keys", {
				code: STABLE_STRINGIFY_UNBOUNDED,
				cause: error,
				context: { reason: "keys" as StableStringifyReason },
				severity: "fatal",
			});
		}
		// Incremental budget before sort/alloc
		if (ownKeys.length > MAX_STABLE_STRINGIFY_NODES) {
			failUnbounded("keys", {
				keys: ownKeys.length,
				max: MAX_STABLE_STRINGIFY_NODES,
			});
		}
		// Reserve edges for each own key
		for (let i = 0; i < ownKeys.length; i += 1) reserveEdge(ctx);

		// Filter to own enumerable string keys via descriptor-only
		const stringKeys: string[] = [];
		for (const k of ownKeys) {
			if (typeof k !== "string") continue;
			let desc: PropertyDescriptor | undefined;
			try {
				desc = Object.getOwnPropertyDescriptor(value as object, k);
			} catch (error) {
				throw new ElizaError("stableStringify: cannot inspect descriptor", {
					code: STABLE_STRINGIFY_UNBOUNDED,
					cause: error,
					context: { reason: "accessor" as StableStringifyReason, key: k },
					severity: "fatal",
				});
			}
			if (!desc) continue;
			if (!desc.enumerable) continue;
			if (!("value" in desc)) {
				failUnsafeAccessor(k);
			}
			// String key bytes precheck
			if (k.length * 3 > MAX_STABLE_STRINGIFY_BYTES) {
				failUnbounded("utf8-length", {
					key: k,
					length: k.length,
					max: MAX_STABLE_STRINGIFY_BYTES,
				});
			}
			stringKeys.push(k);
		}

		// Code-unit order sort (historical)
		stringKeys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

		const staged = Object.create(null) as Record<string, unknown>;
		for (const key of stringKeys) {
			const rawVal = getOwnDataValue(
				value as Record<PropertyKey, unknown>,
				key,
			);
			const sorted = sortStableBoundedInner(rawVal, depth + 1, ctx);
			// Guard defineProperty failure
			try {
				Object.defineProperty(staged, key, {
					value: sorted,
					writable: true,
					enumerable: true,
					configurable: true,
				});
			} catch (error) {
				throw new ElizaError("stableStringify: cannot define property", {
					code: STABLE_STRINGIFY_UNBOUNDED,
					cause: error,
					context: { reason: "prototype" as StableStringifyReason, key },
					severity: "fatal",
				});
			}
		}
		// Restore prototype for JSON.stringify semantics? Null-prototype object stringifies same; keep null-proto to avoid __proto__ pollution.
		// Preserve historical proto for plain objects: set back to original proto after staging so instanceof checks downstream not needed (we already returned Date)
		try {
			Object.setPrototypeOf(staged, proto);
		} catch {
			// ignore
		}
		return staged;
	} finally {
		ctx.ancestors.delete(value as object);
	}
}

export function stableStringifyBounded(value: unknown): string {
	let sorted: unknown;
	try {
		sorted = sortStableBoundedInner(value, 0, {
			visits: 0,
			edges: 0,
			ancestors: new WeakSet(),
		});
	} catch (error) {
		if (error instanceof ElizaError) throw error;
		// Reflection trap leakage
		throw new ElizaError("stableStringify: reflection failed", {
			code: STABLE_STRINGIFY_UNBOUNDED,
			cause: error,
			context: { reason: "prototype" as StableStringifyReason },
			severity: "fatal",
		});
	}
	const json = JSON.stringify(sorted);
	// JSON.stringify returns undefined for top-level undefined/function/symbol; mirror historical
	if (json === undefined) return undefined as unknown as string;
	// Byte budget on final output
	if (json.length * 3 > MAX_STABLE_STRINGIFY_BYTES) {
		// Precheck before encoder
		failUnbounded("utf8-length", {
			length: json.length,
			max: MAX_STABLE_STRINGIFY_BYTES,
		});
	}
	const bytes = new TextEncoder().encode(json).byteLength;
	if (bytes > MAX_STABLE_STRINGIFY_BYTES) {
		failUnbounded("bytes", { bytes, max: MAX_STABLE_STRINGIFY_BYTES });
	}
	return json;
}

/** Hoisted spread budget: count Reflect.ownKeys of each arg before materializing spread. */
export function budgetSpreadBudget(...sources: unknown[]): void {
	let totalKeys = 0;
	for (const src of sources) {
		if (src == null || typeof src !== "object") continue;
		let keys: (string | symbol)[];
		try {
			keys = Reflect.ownKeys(src as object);
		} catch (error) {
			throw new ElizaError("stableStringify: cannot enumerate spread source", {
				code: STABLE_STRINGIFY_UNBOUNDED,
				cause: error,
				context: { reason: "spread-budget" as StableStringifyReason },
				severity: "fatal",
			});
		}
		totalKeys += keys.length;
		if (totalKeys > MAX_STABLE_STRINGIFY_NODES) {
			failUnbounded("keys", {
				keys: totalKeys,
				max: MAX_STABLE_STRINGIFY_NODES,
				reason: "spread-budget" as StableStringifyReason,
			});
		}
		// Also check descriptors for accessors without invoking
		for (const k of keys) {
			let desc: PropertyDescriptor | undefined;
			try {
				desc = Object.getOwnPropertyDescriptor(src as object, k);
			} catch (error) {
				throw new ElizaError("stableStringify: cannot inspect spread source", {
					code: STABLE_STRINGIFY_UNBOUNDED,
					cause: error,
					context: {
						reason: "spread-budget" as StableStringifyReason,
						key: String(k),
					},
					severity: "fatal",
				});
			}
			if (desc && !("value" in desc)) {
				failUnsafeAccessor(String(k));
			}
		}
	}
}

// ---- Unchanged deterministic helpers below ----

const UINT32_MAX = 0x100000000;

export function buildDeterministicSeed(
	...parts: Array<string | number | null | undefined>
): string {
	const filtered = parts
		.map((part) =>
			part === undefined || part === null ? "" : String(part).trim(),
		)
		.filter((part) => part.length > 0);
	return filtered.length > 0 ? filtered.join("::") : "default";
}

export function hashStringToUint32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Produce the compact non-cryptographic fingerprint used for trace keys. */
export function shortStringHash(value: string): string {
	let hash = 5381;
	for (let index = 0; index < value.length; index += 1) {
		hash = ((hash * 31) ^ value.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16);
}

export function createDeterministicRandom(seed: string | number): () => number {
	let state =
		typeof seed === "number" ? seed >>> 0 : hashStringToUint32(String(seed));

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / UINT32_MAX;
	};
}

export function deterministicShuffle<T>(
	items: readonly T[],
	seed: string | number,
): T[] {
	const random = createDeterministicRandom(seed);
	const shuffled = [...items];
	for (let i = shuffled.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

export function deterministicSample<T>(
	items: readonly T[],
	count: number,
	seed: string | number,
): T[] {
	if (count <= 0 || items.length === 0) {
		return [];
	}

	return deterministicShuffle(items, seed).slice(
		0,
		Math.min(count, items.length),
	);
}

export function deterministicPick<T>(
	items: readonly T[],
	seed: string | number,
): T | undefined {
	return deterministicSample(items, 1, seed)[0];
}

export function getDeterministicNames(
	count: number,
	seed: string | number,
): string[] {
	if (count <= 0) {
		return [];
	}

	const ordered = deterministicShuffle(
		EXAMPLE_NAMES,
		buildDeterministicSeed(seed, "names"),
	);
	return Array.from({ length: count }, (_, index) => {
		const name = ordered[index % ordered.length];
		return typeof name === "string" && name.length > 0
			? name
			: `user${index + 1}`;
	});
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortStable(entry));
	}

	if (value instanceof Date) {
		// Keep native Date#toJSON behavior, including null for an invalid date.
		return value;
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				// Code-unit order, not localeCompare: ICU collation is
				// environment-dependent, so hashes derived from this output
				// must not vary with the host locale.
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nestedValue]) => [key, sortStable(nestedValue)]),
		);
	}

	return value;
}
