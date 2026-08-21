/**
 * Bounded JSON normalization shared by every trajectory persistence owner.
 * Per-node caps protect individual fields while a single traversal and output
 * budget prevents shared object graphs from expanding into unbounded rows.
 */

import type { JsonValue } from "../types/primitives";
import { toWellFormedUnicode, truncateWellFormed } from "../utils/well-formed";

const TRAJECTORY_JSON_MAX_DEPTH = 20;
const TRAJECTORY_JSON_MAX_ARRAY_ITEMS = 250;
const TRAJECTORY_JSON_MAX_OBJECT_KEYS = 200;
const TRAJECTORY_JSON_MAX_STRING_CHARS = 64 * 1024;
const TRAJECTORY_JSON_MAX_NODES = 5_000;
const TRAJECTORY_JSON_MAX_OUTPUT_BYTES = 1024 * 1024;
const TRAJECTORY_JSON_BUDGET_SLACK_BYTES = 1024;
const TRAJECTORY_JSON_TRUNCATION_SUFFIX = "...[truncated]";
const utf8Encoder = new TextEncoder();

/** @internal Exposed only through the opaque {@link TrajectoryJsonBudget}. */
export type SanitizationState = {
	seen: WeakSet<object>;
	visitedNodes: number;
	remainingBytes: number;
	exhausted: boolean;
};

function truncateTrajectoryString(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= TRAJECTORY_JSON_MAX_STRING_CHARS) return wellFormed;
	const previewLength = Math.max(
		0,
		TRAJECTORY_JSON_MAX_STRING_CHARS - TRAJECTORY_JSON_TRUNCATION_SUFFIX.length,
	);
	return `${truncateWellFormed(wellFormed, previewLength)}${TRAJECTORY_JSON_TRUNCATION_SUFFIX}`;
}

function jsonByteLength(value: JsonValue): number {
	return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function reserveBytes(state: SanitizationState, byteLength: number): boolean {
	if (state.exhausted || byteLength > state.remainingBytes) {
		state.exhausted = true;
		return false;
	}
	state.remainingBytes -= byteLength;
	return true;
}

function budgetMarker(): JsonValue {
	return {
		__trajectoryTruncated: {
			reason: "global_budget",
			maxNodes: TRAJECTORY_JSON_MAX_NODES,
			maxBytes: TRAJECTORY_JSON_MAX_OUTPUT_BYTES,
		},
	};
}

function enterNode(state: SanitizationState): JsonValue | undefined {
	state.visitedNodes += 1;
	if (state.visitedNodes <= TRAJECTORY_JSON_MAX_NODES && !state.exhausted) {
		return undefined;
	}
	state.exhausted = true;
	return budgetMarker();
}

function boundedScalar(
	value: string | number | boolean | null,
	state: SanitizationState,
): JsonValue {
	const normalized =
		typeof value === "string" ? truncateTrajectoryString(value) : value;
	if (!reserveBytes(state, jsonByteLength(normalized))) return budgetMarker();
	return normalized;
}

function reserveContainer(state: SanitizationState): JsonValue | undefined {
	return reserveBytes(state, 2) ? undefined : budgetMarker();
}

function reserveObjectKey(state: SanitizationState, key: string): boolean {
	return reserveBytes(
		state,
		utf8Encoder.encode(JSON.stringify(key)).byteLength + 2,
	);
}

function appendGeneratedValue(
	output: JsonValue[],
	value: JsonValue,
	state: SanitizationState,
): void {
	if (reserveBytes(state, jsonByteLength(value) + 1)) output.push(value);
}

function setGeneratedValue(
	output: Record<string, JsonValue>,
	key: string,
	value: JsonValue,
	state: SanitizationState,
): void {
	if (
		reserveObjectKey(state, key) &&
		reserveBytes(state, jsonByteLength(value))
	) {
		output[key] = value;
	}
}

function sanitizeTrajectoryJsonValueInternal(
	value: unknown,
	state: SanitizationState,
	depth: number,
): JsonValue | undefined {
	const exhausted = enterNode(state);
	if (exhausted !== undefined) return exhausted;
	if (depth > TRAJECTORY_JSON_MAX_DEPTH) {
		return boundedScalar("[MaxDepth]", state);
	}
	if (value === null) return boundedScalar(null, state);
	if (typeof value === "string") return boundedScalar(value, state);
	if (typeof value === "number") {
		return boundedScalar(Number.isFinite(value) ? value : null, state);
	}
	if (typeof value === "boolean") return boundedScalar(value, state);
	if (typeof value === "bigint") return boundedScalar(value.toString(), state);
	if (value === undefined) return undefined;
	if (typeof value === "function") {
		const fnName = (value as { name?: string }).name;
		return boundedScalar(
			`[Function ${typeof fnName === "string" && fnName ? fnName : "anonymous"}]`,
			state,
		);
	}
	if (typeof value === "symbol") {
		return boundedScalar(value.toString(), state);
	}
	if (value instanceof Date) {
		return boundedScalar(value.toISOString(), state);
	}
	if (value instanceof Error) {
		return sanitizeTrajectoryJsonValueInternal(
			{ name: value.name, message: value.message, stack: value.stack },
			state,
			depth + 1,
		);
	}
	if (value instanceof RegExp) {
		return boundedScalar(value.toString(), state);
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
		if (state.seen.has(value)) return boundedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: Record<string, JsonValue> = {};
		let index = 0;
		for (const [keyValue, entry] of value.entries()) {
			if (index >= TRAJECTORY_JSON_MAX_OBJECT_KEYS || state.exhausted) break;
			const key = String(keyValue);
			if (!reserveObjectKey(state, key)) {
				output.__trajectoryTruncation = budgetMarker();
				break;
			}
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) output[key] = sanitized;
			index += 1;
		}
		if (!state.exhausted && value.size > TRAJECTORY_JSON_MAX_OBJECT_KEYS) {
			setGeneratedValue(
				output,
				"__truncatedKeys",
				value.size - TRAJECTORY_JSON_MAX_OBJECT_KEYS,
				state,
			);
		}
		state.seen.delete(value);
		return output;
	}
	if (value instanceof Set) {
		if (state.seen.has(value)) return boundedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: JsonValue[] = [];
		let index = 0;
		for (const entry of value.values()) {
			if (index >= TRAJECTORY_JSON_MAX_ARRAY_ITEMS || state.exhausted) break;
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			output.push(sanitized ?? null);
			index += 1;
		}
		if (!state.exhausted && value.size > TRAJECTORY_JSON_MAX_ARRAY_ITEMS) {
			appendGeneratedValue(
				output,
				{ __truncatedItems: value.size - TRAJECTORY_JSON_MAX_ARRAY_ITEMS },
				state,
			);
		}
		state.seen.delete(value);
		return output;
	}
	if (Array.isArray(value)) {
		if (state.seen.has(value)) return boundedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const output: JsonValue[] = [];
		const length = Math.min(value.length, TRAJECTORY_JSON_MAX_ARRAY_ITEMS);
		for (let i = 0; i < length && !state.exhausted; i += 1) {
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				value[i],
				state,
				depth + 1,
			);
			output.push(sanitized ?? null);
		}
		if (!state.exhausted && value.length > TRAJECTORY_JSON_MAX_ARRAY_ITEMS) {
			appendGeneratedValue(
				output,
				{ __truncatedItems: value.length - TRAJECTORY_JSON_MAX_ARRAY_ITEMS },
				state,
			);
		}
		state.seen.delete(value);
		return output;
	}
	if (typeof value === "object") {
		if (state.seen.has(value)) return boundedScalar("[Circular]", state);
		const containerMarker = reserveContainer(state);
		if (containerMarker !== undefined) return containerMarker;
		state.seen.add(value);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			state.seen.delete(value);
			const proto = Object.getPrototypeOf(value);
			return proto === Object.prototype || proto === null
				? {}
				: boundedScalar(String(value), state);
		}
		const output: Record<string, JsonValue> = {};
		for (const [key, entry] of entries.slice(
			0,
			TRAJECTORY_JSON_MAX_OBJECT_KEYS,
		)) {
			if (state.exhausted) break;
			if (!reserveObjectKey(state, key)) {
				output.__trajectoryTruncation = budgetMarker();
				break;
			}
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) output[key] = sanitized;
		}
		if (!state.exhausted && entries.length > TRAJECTORY_JSON_MAX_OBJECT_KEYS) {
			setGeneratedValue(
				output,
				"__truncatedKeys",
				entries.length - TRAJECTORY_JSON_MAX_OBJECT_KEYS,
				state,
			);
		}
		state.seen.delete(value);
		return output;
	}
	return boundedScalar(String(value), state);
}

export function sanitizeTrajectoryJsonValue(
	value: unknown,
): JsonValue | undefined {
	return sanitizeTrajectoryJsonValueInternal(
		value,
		{
			seen: new WeakSet<object>(),
			visitedNodes: 0,
			remainingBytes:
				TRAJECTORY_JSON_MAX_OUTPUT_BYTES - TRAJECTORY_JSON_BUDGET_SLACK_BYTES,
			exhausted: false,
		},
		0,
	);
}

/**
 * Opaque handle for callers that must bound SEVERAL values under one shared
 * node/byte budget (e.g. every payload field of a persisted trajectory step
 * competes for the same row-size allowance). The internal state is not part
 * of the public contract.
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
			remainingBytes:
				TRAJECTORY_JSON_MAX_OUTPUT_BYTES - TRAJECTORY_JSON_BUDGET_SLACK_BYTES,
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
