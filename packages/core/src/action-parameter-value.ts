/**
 * Bounds the nested action-parameter walk used when parsing untrusted model
 * `{ params }` JSON. Planner output can nest arrays and objects; the previous
 * recursive map RangeError'd an 8k nest on Node 24.15.0. Depth, node, and
 * cycle limits are all load-bearing. Every reflective read is fail-closed
 * to the typed unbounded error; array length and indexes come from own
 * data descriptors so Proxy get/has traps cannot hang the planner.
 */

import { ElizaError } from "./errors";
import type { ActionParameters } from "./types";

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
		// error-policy:J3 Proxy inspection failures make untrusted model JSON invalid.
		failUnbounded({ inspection: operation }, cause);
	}
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

export function toActionParameterValue(
	value: unknown,
): ActionParameters[string] {
	return toActionParameterValueInner(value, 0, {
		visits: 0,
		visiting: new WeakSet<object>(),
	});
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
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return value;
	}
	if (!value || typeof value !== "object") {
		return String(value);
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
			const out: ActionParameters[string][] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = ownDescriptor(value, String(index));
				if (!descriptor) continue;
				if (!("value" in descriptor)) {
					failUnbounded({ accessor: true, side: "array", index });
				}
				out.push(
					toActionParameterValueInner(descriptor.value, depth + 1, ctx, true),
				);
			}
			return out as ActionParameters[string];
		}

		const entries: Array<[string, unknown]> = [];
		for (const key of inspectRecord("ownKeys", () => Reflect.ownKeys(value))) {
			if (typeof key !== "string") continue;
			const descriptor = ownDescriptor(value, key);
			if (!descriptor?.enumerable) continue;
			if (!("value" in descriptor)) {
				failUnbounded({ accessor: true, side: "object", key });
			}
			entries.push([key, descriptor.value]);
		}
		reserve(ctx, entries.length);
		const normalized: ActionParameters = {};
		for (const [key, entry] of entries) {
			normalized[key] = toActionParameterValueInner(
				entry,
				depth + 1,
				ctx,
				true,
			);
		}
		return normalized;
	} finally {
		ctx.visiting.delete(value);
	}
}
