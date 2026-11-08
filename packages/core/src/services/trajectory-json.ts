/**
 * Lossless JSON normalization shared by every trajectory persistence owner.
 * Strings and collection members are preserved completely; only unsupported
 * JavaScript values and cycles are normalized.
 */

import type { JsonValue } from "../types/primitives.ts";
import { toWellFormedUnicode } from "../utils/unicode.ts";

/** @internal Exposed only through the opaque {@link TrajectoryJsonBudget}. */
export type SanitizationState = {
	seen: WeakSet<object>;
};

function normalizeTrajectoryString(value: string): string {
	return toWellFormedUnicode(value);
}

function normalizedScalar(value: string | number | boolean | null): JsonValue {
	return typeof value === "string" ? normalizeTrajectoryString(value) : value;
}

/**
 * Record one own entry. Plain assignment would run the inherited `__proto__`
 * setter for an own `__proto__` key (e.g. from `JSON.parse`), dropping the
 * entry and re-parenting the sanitized object.
 */
function defineOwnEntry(
	target: Record<string, JsonValue>,
	key: string,
	value: JsonValue,
): void {
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function sanitizeTrajectoryJsonValueInternal(
	value: unknown,
	state: SanitizationState,
	depth: number,
): JsonValue | undefined {
	if (value === null) return normalizedScalar(null);
	if (typeof value === "string") return normalizedScalar(value);
	if (typeof value === "number") {
		return normalizedScalar(Number.isFinite(value) ? value : null);
	}
	if (typeof value === "boolean") return normalizedScalar(value);
	if (typeof value === "bigint") return normalizedScalar(value.toString());
	if (value === undefined) return undefined;
	if (typeof value === "function") {
		const fnName = (value as { name?: string }).name;
		return normalizedScalar(
			`[Function ${typeof fnName === "string" && fnName ? fnName : "anonymous"}]`,
		);
	}
	if (typeof value === "symbol") {
		return normalizedScalar(value.toString());
	}
	if (value instanceof Date) {
		return normalizedScalar(value.toJSON());
	}
	if (value instanceof Error) {
		return sanitizeTrajectoryJsonValueInternal(
			{ name: value.name, message: value.message, stack: value.stack },
			state,
			depth + 1,
		);
	}
	if (value instanceof RegExp) {
		return normalizedScalar(value.toString());
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
		if (state.seen.has(value)) return normalizedScalar("[Circular]");
		state.seen.add(value);
		const output: Record<string, JsonValue> = {};
		for (const [keyValue, entry] of value.entries()) {
			const key = String(keyValue);
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) defineOwnEntry(output, key, sanitized);
		}
		state.seen.delete(value);
		return output;
	}
	if (value instanceof Set) {
		if (state.seen.has(value)) return normalizedScalar("[Circular]");
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
		if (state.seen.has(value)) return normalizedScalar("[Circular]");
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
		if (state.seen.has(value)) return normalizedScalar("[Circular]");
		state.seen.add(value);
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			state.seen.delete(value);
			const proto = Object.getPrototypeOf(value);
			return proto === Object.prototype || proto === null
				? {}
				: normalizedScalar(String(value));
		}
		const output: Record<string, JsonValue> = {};
		for (const [key, entry] of entries) {
			const sanitized = sanitizeTrajectoryJsonValueInternal(
				entry,
				state,
				depth + 1,
			);
			if (sanitized !== undefined) defineOwnEntry(output, key, sanitized);
		}
		state.seen.delete(value);
		return output;
	}
	return normalizedScalar(String(value));
}

export function sanitizeTrajectoryJsonValue(
	value: unknown,
): JsonValue | undefined {
	return sanitizeTrajectoryJsonValueInternal(
		value,
		{ seen: new WeakSet<object>() },
		0,
	);
}

/**
 * @deprecated Carries no byte or node budget; sanitizing through it is the
 * same as {@link sanitizeTrajectoryJsonValue}. Kept so importers compile.
 */
export interface TrajectoryJsonBudget {
	/** @internal */
	state: SanitizationState;
}

/** @deprecated See {@link TrajectoryJsonBudget}. */
export function createTrajectoryJsonBudget(): TrajectoryJsonBudget {
	return {
		state: { seen: new WeakSet<object>() },
	};
}

/** @deprecated Use {@link sanitizeTrajectoryJsonValue}. */
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
