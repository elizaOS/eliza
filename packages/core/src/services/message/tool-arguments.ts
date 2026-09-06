/** Parses and canonicalizes complete tool arguments, rejecting unsupported graphs explicitly before execution. */
import { ElizaError } from "../../errors";
import { extractJsonObjects } from "../../runtime/json-output";

/**
 * Budget for the Stage-1 duplicated-stream canonicalizer. The values walked
 * here are `JSON.parse` products of planner output — `error-policy:J3 planner
 * output is untrusted model input` — so the walk is bounded the way
 * `database/connector-json.ts` bounds connector JSON: a depth cap, a node
 * budget charged BEFORE any per-child allocation, an output-size budget, and a
 * path-local cycle guard that still accepts an honest DAG.
 *
 * Overflow is a typed failure, never a truncated canonical form. A lossy
 * normalizer (`services/trajectory-json.ts` replaces an over-depth branch with
 * `"[MaxDepth]"`) cannot back this comparison: two DIFFERENT over-budget
 * fragments would canonicalize to the same string and the equality check below
 * would accept a stream the model never actually repeated.
 */
export const MAX_TOOL_ARGUMENT_CANONICAL_DEPTH = 32;

export const MAX_TOOL_ARGUMENT_CANONICAL_NODES = 20_000;

export const MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS = 4 * 1024 * 1024;

export const TOOL_ARGUMENT_CANONICAL_UNBOUNDED =
	"TOOL_ARGUMENT_CANONICAL_UNBOUNDED";

export type CanonicalJsonOverflowReason =
	| "accessor"
	| "chars"
	| "cycle"
	| "depth"
	| "nodes"
	| "reflection";

export type CanonicalJsonState = {
	nodes: number;
	chars: number;
	readonly visiting: WeakSet<object>;
};

export function createCanonicalJsonState(): CanonicalJsonState {
	return { nodes: 0, chars: 0, visiting: new WeakSet<object>() };
}

export function failCanonicalJsonUnbounded(
	reason: CanonicalJsonOverflowReason,
	context: Record<string, unknown> = {},
	cause?: unknown,
): never {
	throw new ElizaError(`planner tool arguments are unbounded (${reason})`, {
		code: TOOL_ARGUMENT_CANONICAL_UNBOUNDED,
		severity: "ephemeral",
		context: {
			reason,
			maxDepth: MAX_TOOL_ARGUMENT_CANONICAL_DEPTH,
			maxNodes: MAX_TOOL_ARGUMENT_CANONICAL_NODES,
			maxOutputChars: MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS,
			...context,
		},
		...(cause !== undefined ? { cause } : {}),
	});
}

export function isCanonicalJsonUnboundedError(error: unknown): boolean {
	return (
		error instanceof ElizaError &&
		error.code === TOOL_ARGUMENT_CANONICAL_UNBOUNDED
	);
}

export function chargeCanonicalNodes(
	state: CanonicalJsonState,
	count: number,
): void {
	state.nodes += count;
	if (state.nodes > MAX_TOOL_ARGUMENT_CANONICAL_NODES) {
		failCanonicalJsonUnbounded("nodes", { nodes: state.nodes });
	}
}

export function chargeCanonicalChars(
	state: CanonicalJsonState,
	count: number,
): void {
	state.chars += count;
	if (state.chars > MAX_TOOL_ARGUMENT_CANONICAL_OUTPUT_CHARS) {
		failCanonicalJsonUnbounded("chars", { chars: state.chars });
	}
}

export function canonicalOwnDescriptor(
	value: object,
	key: PropertyKey,
): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(value, key);
	} catch (error) {
		// error-policy:J2 a hostile or revoked Proxy can make
		// getOwnPropertyDescriptor throw; rethrow as the typed unbounded
		// failure with the original preserved as `cause`, so the caller sees
		// one failure shape rather than a raw reflection error.
		failCanonicalJsonUnbounded("reflection", { key: String(key) }, error);
	}
}

/**
 * Own enumerable string-keyed data properties, read through descriptors only —
 * a getter is never invoked and a Proxy `get` trap never runs on untrusted
 * input. A `JSON.parse` product carries only data properties, so this selects
 * exactly the same keys `Object.entries` did for every value the live path
 * accepts today.
 */
export function canonicalOwnEntries(
	value: object,
	state: CanonicalJsonState,
): Array<[string, unknown]> {
	let keys: readonly PropertyKey[];
	try {
		keys = Reflect.ownKeys(value);
	} catch (error) {
		// error-policy:J2 same shape as the descriptor read above — a revoked
		// Proxy makes Reflect.ownKeys throw, and it is rethrown as the typed
		// unbounded failure with the original as `cause`.
		failCanonicalJsonUnbounded("reflection", {}, error);
	}
	// Width is charged before the entry array is allocated.
	chargeCanonicalNodes(state, keys.length);
	const entries: Array<[string, unknown]> = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const descriptor = canonicalOwnDescriptor(value, key);
		if (!descriptor?.enumerable) continue;
		if (!("value" in descriptor)) {
			failCanonicalJsonUnbounded("accessor", { key });
		}
		entries.push([key, descriptor.value]);
	}
	return entries;
}

export function canonicalArrayLength(
	value: object,
	state: CanonicalJsonState,
): number {
	const descriptor = canonicalOwnDescriptor(value, "length");
	if (
		!descriptor ||
		!("value" in descriptor) ||
		typeof descriptor.value !== "number" ||
		!Number.isSafeInteger(descriptor.value) ||
		descriptor.value < 0
	) {
		failCanonicalJsonUnbounded("reflection", { field: "length" });
	}
	// Width is charged before the element array is allocated.
	chargeCanonicalNodes(state, descriptor.value);
	return descriptor.value;
}

export function canonicalJsonValue(
	value: unknown,
	state: CanonicalJsonState,
	depth: number,
): string {
	chargeCanonicalNodes(state, 1);
	if (Array.isArray(value)) {
		if (depth >= MAX_TOOL_ARGUMENT_CANONICAL_DEPTH) {
			failCanonicalJsonUnbounded("depth", { depth });
		}
		// Path-local: a repeated sibling reference (an honest DAG) still
		// canonicalizes; only a reference back into the current path is a cycle.
		if (state.visiting.has(value)) {
			failCanonicalJsonUnbounded("cycle", { depth });
		}
		const length = canonicalArrayLength(value, state);
		chargeCanonicalChars(state, 2 + Math.max(0, length - 1));
		state.visiting.add(value);
		try {
			const parts: string[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = canonicalOwnDescriptor(value, String(index));
				if (!descriptor) {
					// A hole: `Array.prototype.map` skipped it and `join` rendered it
					// as the empty string. Preserved byte-for-byte.
					parts.push("");
					continue;
				}
				if (!("value" in descriptor)) {
					failCanonicalJsonUnbounded("accessor", { index });
				}
				parts.push(canonicalJsonValue(descriptor.value, state, depth + 1));
			}
			return `[${parts.join(",")}]`;
		} finally {
			state.visiting.delete(value);
		}
	}
	if (value && typeof value === "object") {
		if (depth >= MAX_TOOL_ARGUMENT_CANONICAL_DEPTH) {
			failCanonicalJsonUnbounded("depth", { depth });
		}
		if (state.visiting.has(value)) {
			failCanonicalJsonUnbounded("cycle", { depth });
		}
		const entries = canonicalOwnEntries(value, state);
		chargeCanonicalChars(state, 2 + Math.max(0, entries.length - 1));
		entries.sort(([left], [right]) => left.localeCompare(right));
		state.visiting.add(value);
		try {
			const parts: string[] = [];
			for (const [key, entry] of entries) {
				const encodedKey = JSON.stringify(key);
				chargeCanonicalChars(state, encodedKey.length + 1);
				parts.push(
					`${encodedKey}:${canonicalJsonValue(entry, state, depth + 1)}`,
				);
			}
			return `{${parts.join(",")}}`;
		} finally {
			state.visiting.delete(value);
		}
	}
	const encoded = JSON.stringify(value) ?? "undefined";
	chargeCanonicalChars(state, encoded.length);
	return encoded;
}

export function parseToolArgumentsString(
	value: string,
): Record<string, unknown> | null {
	const trimmed = value.trim();
	if (!trimmed) return null;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// error-policy:J3 planner output is untrusted model input; a single-object
		// parse miss continues to the explicit duplicated-stream recovery below.
	}

	const objects = extractJsonObjects(trimmed);
	if (objects.length === 0) return null;

	let remainder = trimmed;
	for (const objectText of objects) {
		remainder = remainder.replace(objectText, "");
	}
	if (remainder.replace(/\0/g, "").trim().length > 0) {
		return null;
	}

	const parsedObjects = objects.map((objectText) => {
		try {
			const parsed: unknown = JSON.parse(objectText);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			// error-policy:J3 each recovered fragment is untrusted model input; one
			// malformed object invalidates the duplicated-stream recovery.
			return null;
		}
	});
	if (parsedObjects.some((parsed) => !parsed)) {
		return null;
	}

	const [first, ...rest] = parsedObjects as Record<string, unknown>[];
	try {
		// A fresh budget per fragment: one fragment must never exhaust the budget
		// of the next, or the comparison would depend on stream position.
		const canonical = canonicalJsonValue(first, createCanonicalJsonState(), 0);
		if (
			rest.some(
				(entry) =>
					canonicalJsonValue(entry, createCanonicalJsonState(), 0) !==
					canonical,
			)
		) {
			return null;
		}
	} catch (error) {
		if (!isCanonicalJsonUnboundedError(error)) throw error;
		// error-policy:J3 an over-budget fragment is untrusted model input. The
		// duplicated-stream recovery declines it through the documented `null`
		// failure signal — Stage 1 then classifies the tool call as malformed and
		// runs its recovery chain — instead of exhausting the stack inside
		// `runV5MessageRuntimeStage1`, whose only catch rethrows to the message
		// boundary and ends the turn.
		return null;
	}
	return first;
}

export function parseToolArguments(
	value: unknown,
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return typeof value === "string" ? parseToolArgumentsString(value) : null;
	}
	return value as Record<string, unknown>;
}
