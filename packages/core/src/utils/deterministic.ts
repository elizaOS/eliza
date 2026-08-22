/**
 * Seeded deterministic helpers: an FNV-1a string hash, a reproducible PRNG, and
 * seed-driven shuffle/sample/pick plus example-name generation, all keyed by a
 * string or number seed so the same seed always yields the same result. Also
 * provides stableStringify — key-order-independent JSON for stable hashing/IDs.
 *
 * stableStringify contract + bounds
 * - Intended for validated plain JSON (plain objects, arrays, primitives, Dates)
 *   plus the historic undefined/function/symbol dropping handled by
 *   JSON.stringify. Hosted metadata (entity/metadata, payload, scheduled-task
 *   digests) is JSON-derived after JSON.parse, so data-only descriptors are the
 *   expected shape. Map/Set/class instances with no enumerable own string keys
 *   serialize as {} (same as the pre-bound implementation); accessor getters are
 *   invoked once via normal property read, preserving historic output.
 * - Not a hostile-Proxy sandbox: Object.keys / Object.getOwnPropertyDescriptor /
 *   Object.getPrototypeOf and property reads can invoke Proxy traps before any
 *   budget check can run. Hosted data is plain JSON, not a trap-bearing Proxy.
 * - OwnKeys/allocation limitation: Object.keys enumerates and allocates the
 *   full key list before keys.length can be charged against the node budget.
 *   A wide object (e.g. 10k keys) will allocate that array even though the walk
 *   then throws StableStringifyUnboundedError. Bounding before materialization
 *   would require capping at the JSON/materialization boundary instead of inside
 *   the walk.
 */

import { ElizaError } from "../errors";
import { EXAMPLE_NAMES } from "./example-names";

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

export const STABLE_STRINGIFY_UNBOUNDED = "STABLE_STRINGIFY_UNBOUNDED";
export const MAX_STABLE_STRINGIFY_DEPTH = 32;
export const MAX_STABLE_STRINGIFY_NODES = 2_048;
export const MAX_STABLE_STRINGIFY_STRING_BYTES = 64 * 1024;

export class StableStringifyUnboundedError extends ElizaError {
	override readonly name = "StableStringifyUnboundedError";
	constructor(
		reason: string,
		context: Record<string, unknown> = {},
		cause?: unknown,
	) {
		super(`stableStringify is unbounded (${reason})`, {
			code: STABLE_STRINGIFY_UNBOUNDED,
			context: { reason, ...context },
			severity: "fatal",
			...(cause !== undefined ? { cause } : {}),
		});
	}
}

export function stableStringify(value: unknown): string {
	const sorted = sortStable(value);
	return JSON.stringify(sorted);
}

function sortStableBounded(
	value: unknown,
	depth: number,
	state: { nodes: number; seen: WeakSet<object> },
): unknown {
	if (depth > MAX_STABLE_STRINGIFY_DEPTH) {
		throw new StableStringifyUnboundedError("depth", { depth });
	}
	if (state.nodes > MAX_STABLE_STRINGIFY_NODES) {
		throw new StableStringifyUnboundedError("nodes", { nodes: state.nodes });
	}

	if (value === null || typeof value !== "object") {
		if (typeof value === "string") {
			const bytes = new TextEncoder().encode(value).byteLength;
			if (bytes > MAX_STABLE_STRINGIFY_STRING_BYTES) {
				throw new StableStringifyUnboundedError("leaf", { stringBytes: bytes });
			}
			state.nodes += Math.max(1, Math.ceil(bytes / 1024));
		} else {
			state.nodes += 1;
		}
		if (state.nodes > MAX_STABLE_STRINGIFY_NODES) {
			throw new StableStringifyUnboundedError("nodes", { nodes: state.nodes });
		}
		return value;
	}

	if (value instanceof Date) {
		state.nodes += 1;
		if (state.nodes > MAX_STABLE_STRINGIFY_NODES) {
			throw new StableStringifyUnboundedError("nodes", { nodes: state.nodes });
		}
		return value;
	}

	if (Array.isArray(value)) {
		if (state.seen.has(value as object)) {
			throw new StableStringifyUnboundedError("cycle", {});
		}
		state.seen.add(value as object);
		try {
			// Length is read via descriptor to preserve sparse-hole semantics without
			// invoking a Proxy get trap for every index via value.length; descriptor
			// access still invokes the length trap once if value is a Proxy.
			let lengthDescriptor: PropertyDescriptor | undefined;
			try {
				lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
			} catch (error) {
				throw new StableStringifyUnboundedError(
					"reflection",
					{ field: "length" },
					error,
				);
			}
			if (
				!lengthDescriptor ||
				!("value" in lengthDescriptor) ||
				typeof lengthDescriptor.value !== "number" ||
				!Number.isSafeInteger(lengthDescriptor.value) ||
				lengthDescriptor.value < 0
			) {
				throw new StableStringifyUnboundedError("reflection", {
					field: "length",
				});
			}
			const length = lengthDescriptor.value;
			// Note: we charge for length only after reading it; a Proxy that fakes a
			// huge length still allocates the loop structure. Hosted data is plain
			// JSON arrays, not Proxies.
			if (length > MAX_STABLE_STRINGIFY_NODES - state.nodes) {
				throw new StableStringifyUnboundedError("nodes", {
					nodes: state.nodes + length,
				});
			}
			const out: unknown[] = [];
			for (let index = 0; index < length; index += 1) {
				// Sparse holes: descriptor missing -> JSON.stringify yields null, same as original value.map hole
				let descriptor: PropertyDescriptor | undefined;
				try {
					descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				} catch (error) {
					throw new StableStringifyUnboundedError(
						"reflection",
						{ index },
						error,
					);
				}
				if (!descriptor) {
					state.nodes += 1;
					if (state.nodes > MAX_STABLE_STRINGIFY_NODES) {
						throw new StableStringifyUnboundedError("nodes", {
							nodes: state.nodes,
						});
					}
					out.push(null);
					continue;
				}
				// Preserve historic accessor behavior: Object.entries/value[i] invokes getter once.
				// For plain JSON (data descriptors), this is a direct value read; for an
				// accessor, we intentionally read the getter result once rather than throwing,
				// to keep byte-for-byte compatibility with the pre-bound implementation.
				let entry: unknown;
				if ("value" in descriptor) {
					entry = descriptor.value;
				} else {
					try {
						entry = (value as unknown[])[index];
					} catch (error) {
						throw new StableStringifyUnboundedError(
							"reflection",
							{ index },
							error,
						);
					}
				}
				out.push(sortStableBounded(entry, depth + 1, state));
			}
			return out;
		} finally {
			state.seen.delete(value as object);
		}
	}

	// Generic object (plain object, class instance, Map/Set etc.)
	// Preserve historic behavior: enumerate own enumerable string keys and sort.
	// Maps/Sets have no enumerable string keys, so they serialize as {} — same as pre-bound.
	// Class instances with enumerable own properties serialize those fields.
	if (state.seen.has(value as object)) {
		throw new StableStringifyUnboundedError("cycle", {});
	}
	state.seen.add(value as object);
	try {
		let keys: string[];
		try {
			// Object.keys allocates the full key list before we can charge it — see
			// header limitation for wide objects. This mirrors the pre-bound
			// Object.entries allocation.
			keys = Object.keys(value as Record<string, unknown>);
		} catch (error) {
			throw new StableStringifyUnboundedError("reflection", {}, error);
		}
		if (keys.length > MAX_STABLE_STRINGIFY_NODES - state.nodes) {
			throw new StableStringifyUnboundedError("nodes", {
				nodes: state.nodes + keys.length,
			});
		}
		const sortedKeys = keys.sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		const output: Record<string, unknown> = {};
		for (const key of sortedKeys) {
			let entryValue: unknown;
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(value as object, key);
			} catch (error) {
				throw new StableStringifyUnboundedError("reflection", { key }, error);
			}
			if (descriptor && !descriptor.enumerable) continue;
			if (descriptor && "value" in descriptor) {
				entryValue = descriptor.value;
			} else {
				// Accessor: invoke getter once to preserve historic output (Object.entries would invoke)
				try {
					entryValue = (value as Record<string, unknown>)[key];
				} catch (error) {
					throw new StableStringifyUnboundedError("reflection", { key }, error);
				}
			}
			const keyBytes = new TextEncoder().encode(key).byteLength;
			if (keyBytes > MAX_STABLE_STRINGIFY_STRING_BYTES) {
				throw new StableStringifyUnboundedError("leaf", { keyBytes });
			}
			state.nodes += Math.max(1, Math.ceil(keyBytes / 1024));
			if (state.nodes > MAX_STABLE_STRINGIFY_NODES) {
				throw new StableStringifyUnboundedError("nodes", {
					nodes: state.nodes,
				});
			}
			const nested = sortStableBounded(entryValue, depth + 1, state);
			Object.defineProperty(output, key, {
				configurable: true,
				enumerable: true,
				value: nested,
				writable: true,
			});
		}
		return output;
	} finally {
		state.seen.delete(value as object);
	}
}

function sortStable(value: unknown): unknown {
	return sortStableBounded(value, 0, { nodes: 0, seen: new WeakSet() });
}
