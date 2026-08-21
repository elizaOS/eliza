/**
 * Descriptor-only JSON projection shared by connector-account storage adapters.
 * Writes fail typed before persistence; audit metadata replaces hostile or
 * over-budget branches with a visible sentinel so diagnostics are not lost.
 */

import { ElizaError } from "../errors";
import type { ConnectorAccountJsonObject, JsonValue } from "../types";

export const CONNECTOR_JSON_UNBOUNDED = "CONNECTOR_JSON_UNBOUNDED";
export const CONNECTOR_JSON_BOUNDED = "[BOUNDED]";
export const MAX_CONNECTOR_JSON_DEPTH = 16;
export const MAX_CONNECTOR_JSON_NODES = 2_048;
export const MAX_CONNECTOR_JSON_STRING_BYTES = 64 * 1024;

type OverflowMode = "throw" | "sentinel";
const BOUNDED_BRANCH = Symbol("connector-json-bounded-branch");
const BOUNDED_EXHAUSTED = Symbol("connector-json-bounded-exhausted");
type BoundedResult = typeof BOUNDED_BRANCH | typeof BOUNDED_EXHAUSTED;
type OverflowReason =
	| "accessor"
	| "cycle"
	| "depth"
	| "leaf"
	| "nodes"
	| "reflection";

const utf8Encoder = new TextEncoder();

export class ConnectorJsonUnboundedError extends ElizaError {
	override readonly name = "ConnectorJsonUnboundedError";

	constructor(
		reason: OverflowReason,
		context: Record<string, unknown> = {},
		cause?: unknown,
	) {
		super(`connector account JSON is unbounded (${reason})`, {
			code: CONNECTOR_JSON_UNBOUNDED,
			context: { reason, ...context },
			severity: "fatal",
			...(cause !== undefined ? { cause } : {}),
		});
	}
}

interface WalkState {
	nodes: number;
	readonly seen: WeakSet<object>;
}

interface WalkOptions {
	readonly mode: OverflowMode;
	readonly redactKey?: (key: string) => boolean;
}

function overflow(
	options: WalkOptions,
	reason: OverflowReason,
	context: Record<string, unknown> = {},
	cause?: unknown,
): BoundedResult {
	if (options.mode === "sentinel") {
		return reason === "nodes" ? BOUNDED_EXHAUSTED : BOUNDED_BRANCH;
	}
	throw new ConnectorJsonUnboundedError(reason, context, cause);
}

function charge(
	state: WalkState,
	amount: number,
	options: WalkOptions,
): BoundedResult | undefined {
	state.nodes += amount;
	if (state.nodes > MAX_CONNECTOR_JSON_NODES) {
		return overflow(options, "nodes", { nodes: state.nodes });
	}
	return undefined;
}

function chargeText(
	value: string,
	state: WalkState,
	options: WalkOptions,
	kind: "keyBytes" | "stringBytes",
): BoundedResult | undefined {
	const bytes = utf8Encoder.encode(value).byteLength;
	if (bytes > MAX_CONNECTOR_JSON_STRING_BYTES) {
		return overflow(options, "leaf", { [kind]: bytes });
	}
	return charge(state, Math.max(1, Math.ceil(bytes / 1024)), options);
}

function defineOwn(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function genuineDateIso(value: object): string | undefined {
	try {
		Date.prototype.getTime.call(value);
		return Date.prototype.toISOString.call(value);
	} catch {
		return undefined;
	}
}

function ownKeys(
	value: object,
	options: WalkOptions,
): readonly PropertyKey[] | BoundedResult {
	try {
		return Reflect.ownKeys(value);
	} catch (error) {
		return overflow(options, "reflection", {}, error);
	}
}

function ownDescriptor(
	value: object,
	key: PropertyKey,
	options: WalkOptions,
): PropertyDescriptor | undefined | BoundedResult {
	try {
		return Object.getOwnPropertyDescriptor(value, key);
	} catch (error) {
		return overflow(options, "reflection", { key: String(key) }, error);
	}
}

function objectPrototype(
	value: object,
	options: WalkOptions,
): object | null | BoundedResult {
	try {
		return Object.getPrototypeOf(value) as object | null;
	} catch (error) {
		return overflow(options, "reflection", {}, error);
	}
}

function walkPrimitive(
	value: unknown,
	inArray: boolean,
	state: WalkState,
	options: WalkOptions,
): { handled: false } | { handled: true; value: unknown; skip?: boolean } {
	if (value === null) {
		return { handled: true, value: charge(state, 1, options) ?? null };
	}
	switch (typeof value) {
		case "string":
			return {
				handled: true,
				value: chargeText(value, state, options, "stringBytes") ?? value,
			};
		case "number":
			if (!Number.isFinite(value)) {
				return {
					handled: true,
					value: overflow(options, "leaf", { type: "non-finite-number" }),
				};
			}
			return {
				handled: true,
				value: charge(state, 1, options) ?? value,
			};
		case "boolean":
			return { handled: true, value: charge(state, 1, options) ?? value };
		case "undefined":
		case "function":
		case "symbol":
			if (options.mode === "throw") {
				return {
					handled: true,
					value: overflow(options, "leaf", { type: typeof value }),
				};
			}
			if (!inArray) {
				return { handled: true, value: CONNECTOR_JSON_BOUNDED };
			}
			return {
				handled: true,
				value: charge(state, 1, options) ?? CONNECTOR_JSON_BOUNDED,
			};
		case "bigint":
			return {
				handled: true,
				value: overflow(options, "leaf", { type: "bigint" }),
			};
		case "object":
			return { handled: false };
	}
	return { handled: false };
}

function walk(
	value: unknown,
	depth: number,
	inArray: boolean,
	state: WalkState,
	options: WalkOptions,
): unknown | BoundedResult {
	const primitive = walkPrimitive(value, inArray, state, options);
	if (primitive.handled) return primitive.skip ? undefined : primitive.value;

	const objectValue = value as object;
	const dateIso = genuineDateIso(objectValue);
	if (dateIso !== undefined) {
		return chargeText(dateIso, state, options, "stringBytes") ?? dateIso;
	}
	if (depth > MAX_CONNECTOR_JSON_DEPTH) {
		return overflow(options, "depth", { depth });
	}
	if (state.seen.has(objectValue)) {
		return overflow(options, "cycle", { depth });
	}
	const containerHit = charge(state, 1, options);
	if (containerHit !== undefined) return containerHit;

	let isArray: boolean;
	try {
		isArray = Array.isArray(objectValue);
	} catch (error) {
		return overflow(options, "reflection", {}, error);
	}
	state.seen.add(objectValue);
	try {
		if (isArray) {
			const lengthDescriptor = ownDescriptor(objectValue, "length", options);
			if (
				lengthDescriptor === BOUNDED_BRANCH ||
				lengthDescriptor === BOUNDED_EXHAUSTED
			) {
				return lengthDescriptor;
			}
			if (
				!lengthDescriptor ||
				!("value" in lengthDescriptor) ||
				typeof lengthDescriptor.value !== "number" ||
				!Number.isSafeInteger(lengthDescriptor.value) ||
				lengthDescriptor.value < 0
			) {
				return overflow(options, "reflection", { field: "length" });
			}
			const length = lengthDescriptor.value;
			if (length > MAX_CONNECTOR_JSON_NODES - state.nodes) {
				return overflow(options, "nodes", { nodes: state.nodes + length });
			}
			const output: unknown[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = ownDescriptor(objectValue, String(index), options);
				if (descriptor === BOUNDED_BRANCH || descriptor === BOUNDED_EXHAUSTED) {
					output.push(CONNECTOR_JSON_BOUNDED);
					if (descriptor === BOUNDED_EXHAUSTED) break;
					continue;
				}
				if (!descriptor) {
					const hit = charge(state, 1, options);
					output.push(hit === undefined ? null : CONNECTOR_JSON_BOUNDED);
					if (hit !== undefined) break;
					continue;
				}
				if (!("value" in descriptor)) {
					overflow(options, "accessor", { index });
					output.push(CONNECTOR_JSON_BOUNDED);
					continue;
				}
				const cloned = walk(descriptor.value, depth + 1, true, state, options);
				if (cloned === BOUNDED_BRANCH || cloned === BOUNDED_EXHAUSTED) {
					output.push(CONNECTOR_JSON_BOUNDED);
					if (cloned === BOUNDED_EXHAUSTED) break;
					continue;
				}
				output.push(cloned);
			}
			return output;
		}

		const prototype = objectPrototype(objectValue, options);
		if (prototype === BOUNDED_BRANCH || prototype === BOUNDED_EXHAUSTED) {
			return prototype;
		}
		if (prototype !== Object.prototype && prototype !== null) {
			return overflow(options, "leaf", { type: "non-plain-object" });
		}
		const keys = ownKeys(objectValue, options);
		if (keys === BOUNDED_BRANCH || keys === BOUNDED_EXHAUSTED) return keys;
		if (keys.length > MAX_CONNECTOR_JSON_NODES - state.nodes) {
			return overflow(options, "nodes", { nodes: state.nodes + keys.length });
		}
		const output: Record<string, unknown> = {};
		for (const key of keys) {
			if (typeof key !== "string") continue;
			const descriptor = ownDescriptor(objectValue, key, options);
			if (descriptor === BOUNDED_BRANCH || descriptor === BOUNDED_EXHAUSTED) {
				defineOwn(output, key, CONNECTOR_JSON_BOUNDED);
				if (descriptor === BOUNDED_EXHAUSTED) break;
				continue;
			}
			if (!descriptor) {
				const missing = overflow(options, "reflection", { key });
				defineOwn(output, key, CONNECTOR_JSON_BOUNDED);
				if (missing === BOUNDED_EXHAUSTED) break;
				continue;
			}
			if (!descriptor.enumerable) continue;
			const keyHit = chargeText(key, state, options, "keyBytes");
			if (keyHit !== undefined) {
				defineOwn(output, key, CONNECTOR_JSON_BOUNDED);
				if (keyHit === BOUNDED_EXHAUSTED) break;
				continue;
			}
			if (options.redactKey?.(key)) {
				defineOwn(output, key, "[REDACTED]");
				continue;
			}
			if (!("value" in descriptor)) {
				overflow(options, "accessor", { key });
				defineOwn(output, key, CONNECTOR_JSON_BOUNDED);
				continue;
			}
			const cloned = walk(descriptor.value, depth + 1, false, state, options);
			if (cloned === BOUNDED_BRANCH || cloned === BOUNDED_EXHAUSTED) {
				defineOwn(output, key, CONNECTOR_JSON_BOUNDED);
				if (cloned === BOUNDED_EXHAUSTED) break;
				continue;
			}
			if (cloned !== undefined) defineOwn(output, key, cloned);
		}
		return output;
	} finally {
		state.seen.delete(objectValue);
	}
}

/** Clone a connector JSON object and fail typed before any persistence. */
export function cloneConnectorJsonObject(
	value: ConnectorAccountJsonObject | undefined,
): ConnectorAccountJsonObject {
	if (value === undefined) return {};
	const cloned = walk(
		value,
		0,
		false,
		{ nodes: 0, seen: new WeakSet() },
		{ mode: "throw" },
	);
	if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
		throw new ConnectorJsonUnboundedError("leaf", { type: "non-object-root" });
	}
	return cloned as ConnectorAccountJsonObject;
}

/** Redact and bound audit metadata without dropping the diagnostic event. */
export function redactConnectorJsonAudit(
	value: Record<string, unknown> | undefined,
	redactKey: (key: string) => boolean,
): ConnectorAccountJsonObject {
	const redacted = walk(
		value ?? {},
		0,
		false,
		{ nodes: 0, seen: new WeakSet() },
		{ mode: "sentinel", redactKey },
	);
	if (redacted === BOUNDED_BRANCH || redacted === BOUNDED_EXHAUSTED) {
		return { bounded: CONNECTOR_JSON_BOUNDED };
	}
	if (
		redacted === null ||
		typeof redacted !== "object" ||
		Array.isArray(redacted)
	) {
		return { bounded: CONNECTOR_JSON_BOUNDED };
	}
	return redacted as ConnectorAccountJsonObject;
}

/** Clone a JSON value for adapter read isolation. */
export function cloneConnectorJsonValue(value: unknown): JsonValue {
	return walk(
		value,
		0,
		false,
		{ nodes: 0, seen: new WeakSet() },
		{ mode: "throw" },
	) as JsonValue;
}
