/**
 * Lossless JSON normalization shared by every trajectory persistence owner.
 * Strings and collection members are preserved completely; only unsupported
 * JavaScript values, cycles, and pathological nesting are normalized.
 */

import type { JsonValue } from "../types/primitives";
import { toWellFormedUnicode } from "../utils/well-formed";

const TRAJECTORY_JSON_MAX_DEPTH = 20;
const utf8Encoder = new TextEncoder();

/** @internal Exposed only through the opaque {@link TrajectoryJsonBudget}. */
export type SanitizationState = {
	seen: WeakSet<object>;
	visitedNodes: number;
	remainingBytes: number;
	exhausted: boolean;
};

function normalizeTrajectoryString(value: string): string {
	return toWellFormedUnicode(value);
}

function jsonByteLength(value: JsonValue): number {
	return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function reserveBytes(state: SanitizationState, byteLength: number): boolean {
	state.remainingBytes -= byteLength;
	return true;
}

function enterNode(state: SanitizationState): JsonValue | undefined {
	state.visitedNodes += 1;
	return undefined;
}

function normalizedScalar(
	value: string | number | boolean | null,
	state: SanitizationState,
): JsonValue {
	const normalized =
		typeof value === "string" ? normalizeTrajectoryString(value) : value;
	reserveBytes(state, jsonByteLength(normalized));
	return normalized;
}

function reserveContainer(state: SanitizationState): JsonValue | undefined {
	reserveBytes(state, 2);
	return undefined;
}

function reserveObjectKey(state: SanitizationState, key: string): boolean {
	return reserveBytes(
		state,
		utf8Encoder.encode(JSON.stringify(key)).byteLength + 2,
	);
}

function sanitizeTrajectoryJsonValueInternal(
	value: unknown,
	state: SanitizationState,
	depth: number,
): JsonValue | undefined {
	const exhausted = enterNode(state);
	if (exhausted !== undefined) return exhausted;
	if (depth > TRAJECTORY_JSON_MAX_DEPTH) {
		return normalizedScalar("[MaxDepth]", state);
	}
	if (value === null) return normalizedScalar(null, state);
	if (typeof value === "string") return normalizedScalar(value, state);
	if (typeof value === "number") {
		return normalizedScalar(Number.isFinite(value) ? value : null, state);
	}
	if (typeof value === "boolean") return normalizedScalar(value, state);
	if (typeof value === "bigint")
		return normalizedScalar(value.toString(), state);
	if (value === undefined) return undefined;
	if (typeof value === "function") {
		const fnName = (value as { name?: string }).name;
		return normalizedScalar(
			`[Function ${typeof fnName === "string" && fnName ? fnName : "anonymous"}]`,
			state,
		);
	}
	if (typeof value === "symbol") {
		return normalizedScalar(value.toString(), state);
	}
	if (value instanceof Date) {
		return normalizedScalar(value.toISOString(), state);
	}
	if (value instanceof Error) {
		return sanitizeTrajectoryJsonValueInternal(
			{ name: value.name, message: value.message, stack: value.stack },
			state,
			depth + 1,
		);
	}
	if (value instanceof RegExp) {
		return normalizedScalar(value.toString(), state);
	}
	if (value instanceof ArrayBuffer) {
		return sanitizeTrajectoryJsonValueInternal(
			{ type: "ArrayBuffer", byteLength: value.byteLength },
			state,
			depth + 1,
		);
	}
	if (ArrayBuffer.isView(value)) {
		return sanitizeTrajectoryJsonValueInternal(
			{
				type: value.constructor.name || "ArrayBufferView",
				byteLength: value.byteLength,
			},
			state,
			depth + 1,
		);
	}
	if (value instanceof Map) {
		if (state.seen.has(value)) return normalizedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: Record<string, JsonValue> = {};
		for (const [keyValue, entry] of value.entries()) {
			const key = String(keyValue);
			reserveObjectKey(state, key);
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) output[key] = sanitized;
		}
		state.seen.delete(value);
		return output;
	}
	if (value instanceof Set) {
		if (state.seen.has(value)) return normalizedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: JsonValue[] = [];
		for (const entry of value.values()) {
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			output.push(sanitized ?? null);
		}
		state.seen.delete(value);
		return output;
	}
	if (Array.isArray(value)) {
		if (state.seen.has(value)) return normalizedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: JsonValue[] = [];
		const length = value.length;
		for (let i = 0; i < length; i += 1) {
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				value[i],
				state,
				depth + 1,
			);
			output.push(sanitized ?? null);
		}
		state.seen.delete(value);
		return output;
	}
	if (typeof value === "object") {
		if (state.seen.has(value)) return normalizedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			state.seen.delete(value);
			const proto = Object.getPrototypeOf(value);
			return proto === Object.prototype || proto === null
				? {}
				: normalizedScalar(String(value), state);
		}
		const output: Record<string, JsonValue> = {};
		for (const [key, entry] of entries) {
			reserveObjectKey(state, key);
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) output[key] = sanitized;
		}
		state.seen.delete(value);
		return output;
	}
	return normalizedScalar(String(value), state);
}

export function sanitizeTrajectoryJsonValue(
	value: unknown,
): JsonValue | undefined {
	return sanitizeTrajectoryJsonValueInternal(
		value,
		{
			seen: new WeakSet<object>(),
			visitedNodes: 0,
			remainingBytes: Number.POSITIVE_INFINITY,
			exhausted: false,
		},
		0,
	);
}

/**
 * Opaque handle retained for callers that normalize several values under one
 * shared traversal state. The internal state is not part of the public contract.
 */
export interface TrajectoryJsonBudget {
	/** @internal */
	state: SanitizationState;
}

export function createTrajectoryJsonBudget(): TrajectoryJsonBudget {
	return {
		state: {
			seen: new WeakSet<object>(),
			visitedNodes: 0,
			remainingBytes: Number.POSITIVE_INFINITY,
			exhausted: false,
		},
	};
}

export function sanitizeTrajectoryJsonValueInBudget(
	value: unknown,
	budget: TrajectoryJsonBudget,
): JsonValue | undefined {
	return sanitizeTrajectoryJsonValueInternal(value, budget.state, 0);
}

export function sanitizeTrajectoryJsonObject(
	value: unknown,
): Record<string, JsonValue> | undefined {
	const sanitized = sanitizeTrajectoryJsonValue(value);
	return sanitized !== null &&
		typeof sanitized === "object" &&
		!Array.isArray(sanitized)
		? sanitized
		: undefined;
}
