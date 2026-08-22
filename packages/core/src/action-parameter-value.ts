/**
 * Bounds the nested action-parameter walk used when parsing untrusted model
 * `{ params }` JSON. Planner output can nest arrays and objects; the previous
 * recursive map RangeError'd an 8k nest on Node 24.15.0. Depth, node, and
 * cycle limits are all load-bearing. Every reflective read is fail-closed
 * to the typed unbounded error; array length, indexes, and record keys come
 * from own data descriptors so Proxy get/has traps cannot hang the planner.
 * `parseActionParams` shares one walk budget across the whole params graph.
 */

import { ElizaError } from "./errors";
import type { ActionParameters } from "./types";
import { toWellFormedUnicode } from "./utils/well-formed";

export const MAX_ACTION_PARAMETER_DEPTH = 32;
export const MAX_ACTION_PARAMETER_NODES = 2_048;
export const ACTION_PARAMETER_UNBOUNDED = "ACTION_PARAMETER_UNBOUNDED";

type WalkContext = {
	visits: number;
	visiting: WeakSet<object>;
};

function failUnbounded(
	context: Record<string, unknown>,
	cause?: unknown,
): never {
	throw new ElizaError("Action parameter JSON exceeds the parse walk budget", {
		code: ACTION_PARAMETER_UNBOUNDED,
		context,
		cause,
		severity: "fatal",
	});
}

function reserve(ctx: WalkContext, count: number): void {
	if (count > MAX_ACTION_PARAMETER_NODES - ctx.visits) {
		failUnbounded({
			visits: ctx.visits + count,
			maxNodes: MAX_ACTION_PARAMETER_NODES,
		});
	}
	ctx.visits += count;
}

function inspectRecord<T>(operation: string, inspect: () => T): T {
	try {
		return inspect();
	} catch (cause) {
		// error-policy:J2 Preserve the reflective failure as the typed boundary cause.
		failUnbounded({ inspection: operation }, cause);
	}
}

function defineDataProperty(
	target: ActionParameters,
	key: string,
	value: ActionParameters[string],
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function ownDescriptor(
	value: object,
	key: PropertyKey,
): PropertyDescriptor | undefined {
	return inspectRecord("getOwnPropertyDescriptor", () =>
		Object.getOwnPropertyDescriptor(value, key),
	);
}

function isArrayRecord(value: unknown): value is unknown[] {
	return inspectRecord("isArray", () => Array.isArray(value));
}

function ownEnumerableStringDataEntries(
	value: object,
	ctx: WalkContext,
): Array<[string, unknown]> {
	const keys = inspectRecord("ownKeys", () => Reflect.ownKeys(value));
	reserve(ctx, keys.length);
	const entries: Array<[string, unknown]> = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const descriptor = ownDescriptor(value, key);
		if (!descriptor?.enumerable) continue;
		if (!("value" in descriptor)) {
			failUnbounded({ accessor: true, side: "object", key });
		}
		entries.push([key, descriptor.value]);
	}
	return entries;
}

function newWalkContext(): WalkContext {
	return {
		visits: 0,
		visiting: new WeakSet<object>(),
	};
}

export function toActionParameterValue(
	value: unknown,
): ActionParameters[string] {
	return toActionParameterValueInner(value, 0, newWalkContext());
}

/**
 * Production planner boundary: descriptor-only traversal of the model
 * `{ params }` graph with one shared node/cycle budget.
 */
export function parseActionParams(
	paramsInput: unknown,
): Map<string, ActionParameters> {
	const parsed =
		typeof paramsInput === "string"
			? parseActionParamsJson(paramsInput)
			: (paramsInput ?? null);
	if (parsed === null || parsed === undefined) {
		return new Map();
	}
	return parseActionParamsRecord(parsed, newWalkContext());
}

function parseActionParamsJson(input: string): unknown | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		// error-policy:J3 action parameters cross an untrusted model boundary;
		// malformed JSON is an explicit invalid result.
		return null;
	}
}

function parseActionParamsRecord(
	parsed: unknown,
	ctx: WalkContext,
): Map<string, ActionParameters> {
	if (!parsed || typeof parsed !== "object") {
		return new Map();
	}
	if (isArrayRecord(parsed)) {
		return new Map();
	}
	reserve(ctx, 1);
	if (ctx.visiting.has(parsed)) {
		failUnbounded({ cycle: true });
	}
	ctx.visiting.add(parsed);
	try {
		const rootEntries = ownEnumerableStringDataEntries(parsed, ctx);
		const paramsSlot = rootEntries.find(([key]) => key === "params");
		if (paramsSlot) {
			const paramsValue = paramsSlot[1];
			if (
				paramsValue &&
				typeof paramsValue === "object" &&
				!isArrayRecord(paramsValue)
			) {
				return collectActionParams(paramsValue, ctx);
			}
		}
		return collectActionsFromEntries(rootEntries, ctx);
	} finally {
		ctx.visiting.delete(parsed);
	}
}

function collectActionParams(
	candidate: object,
	ctx: WalkContext,
): Map<string, ActionParameters> {
	if (ctx.visiting.has(candidate)) {
		failUnbounded({ cycle: true });
	}
	ctx.visiting.add(candidate);
	try {
		return collectActionsFromEntries(
			ownEnumerableStringDataEntries(candidate, ctx),
			ctx,
		);
	} finally {
		ctx.visiting.delete(candidate);
	}
}

function collectActionsFromEntries(
	actionEntries: Array<[string, unknown]>,
	ctx: WalkContext,
): Map<string, ActionParameters> {
	const result = new Map<string, ActionParameters>();
	for (const [actionName, paramsValue] of actionEntries) {
		if (!paramsValue || typeof paramsValue !== "object") {
			continue;
		}
		if (isArrayRecord(paramsValue)) {
			continue;
		}
		if (ctx.visiting.has(paramsValue)) {
			failUnbounded({ cycle: true });
		}
		ctx.visiting.add(paramsValue);
		try {
			const params: ActionParameters = {};
			for (const [paramName, paramValue] of ownEnumerableStringDataEntries(
				paramsValue,
				ctx,
			)) {
				defineDataProperty(
					params,
					paramName,
					toActionParameterValueInner(paramValue, 0, ctx, true),
				);
			}
			if (Object.keys(params).length > 0) {
				result.set(actionName.trim().toUpperCase(), params);
			}
		} finally {
			ctx.visiting.delete(paramsValue);
		}
	}
	return result;
}

function toActionParameterValueInner(
	value: unknown,
	depth: number,
	ctx: WalkContext,
	visitAlreadyReserved = false,
): ActionParameters[string] {
	if (depth > MAX_ACTION_PARAMETER_DEPTH) {
		failUnbounded({ depth, max: MAX_ACTION_PARAMETER_DEPTH });
	}
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return toWellFormedUnicode(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return value;
	}
	if (!value || typeof value !== "object") {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return inspectRecord("primitiveToString", () => String(value));
	}
	if (!visitAlreadyReserved) reserve(ctx, 1);
	if (ctx.visiting.has(value)) {
		failUnbounded({ cycle: true });
	}
	ctx.visiting.add(value);
	try {
		if (isArrayRecord(value)) {
			const lengthDescriptor = ownDescriptor(value, "length");
			if (!lengthDescriptor || !("value" in lengthDescriptor)) {
				failUnbounded({ invalidArrayLength: true });
			}
			const length = lengthDescriptor.value;
			if (!Number.isSafeInteger(length) || length < 0) {
				failUnbounded({ invalidArrayLength: true });
			}
			reserve(ctx, length);
			const out = new Array<ActionParameters[string]>(length);
			for (let index = 0; index < length; index += 1) {
				const descriptor = ownDescriptor(value, String(index));
				if (!descriptor) continue;
				if (!("value" in descriptor)) {
					failUnbounded({ accessor: true, side: "array", index });
				}
				out[index] = toActionParameterValueInner(
					descriptor.value,
					depth + 1,
					ctx,
					true,
				);
			}
			return out as ActionParameters[string];
		}

		const entries = ownEnumerableStringDataEntries(value, ctx);
		const normalized: ActionParameters = {};
		for (const [key, entry] of entries) {
			defineDataProperty(
				normalized,
				key,
				toActionParameterValueInner(entry, depth + 1, ctx, true),
			);
		}
		return normalized;
	} finally {
		ctx.visiting.delete(value);
	}
}
