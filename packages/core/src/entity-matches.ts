/**
 * Bounds the nested `{ match: … }` unwrap used when parsing LLM entity
 * resolution JSON. Model output can wrap `matches` in hostile `match`
 * objects; the previous recursive unwrap RangeError'd an 8k nest on
 * Node 24.15.0. Depth, node, and cycle limits are all load-bearing.
 * Every reflective read is fail-closed to the typed unbounded error.
 */

import { ElizaError } from "./errors";

export const MAX_ENTITY_MATCH_DEPTH = 32;
export const MAX_ENTITY_MATCH_NODES = 2_048;
export const ENTITY_MATCH_UNBOUNDED = "ENTITY_MATCH_UNBOUNDED";

export interface EntityMatch {
	name?: string;
	reason?: string;
}

type WalkContext = {
	visits: number;
	visiting: WeakSet<object>;
};

function failUnbounded(
	context: Record<string, unknown>,
	cause?: unknown,
): never {
	throw new ElizaError(
		"Entity resolution matches exceed the unwrap walk budget",
		{
			code: ENTITY_MATCH_UNBOUNDED,
			context,
			cause,
			severity: "fatal",
		},
	);
}

function reserve(ctx: WalkContext, count: number): void {
	if (count > MAX_ENTITY_MATCH_NODES - ctx.visits) {
		failUnbounded({
			visits: ctx.visits + count,
			maxNodes: MAX_ENTITY_MATCH_NODES,
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

function ownString(value: object, key: string): string | undefined {
	const field = readEntityResolutionField(value, key);
	return typeof field === "string" ? field : undefined;
}

/** Reads one own data field from untrusted entity-resolution model output. */
export function readEntityResolutionField(value: object, key: string): unknown {
	const descriptor = ownDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) {
		failUnbounded({ accessor: true, key });
	}
	return descriptor.value;
}

function normalizeEntityMatch(value: unknown): EntityMatch | null {
	if (!value || typeof value !== "object" || isArrayRecord(value)) {
		return null;
	}
	const name = ownString(value, "name");
	const reason = ownString(value, "reason");
	if (!name) return null;
	return { name, reason };
}

export function normalizeEntityMatches(value: unknown): EntityMatch[] {
	return normalizeEntityMatchesInner(value, 0, {
		visits: 0,
		visiting: new WeakSet<object>(),
	});
}

function normalizeEntityMatchesInner(
	value: unknown,
	depth: number,
	ctx: WalkContext,
	visitAlreadyReserved = false,
): EntityMatch[] {
	if (depth > MAX_ENTITY_MATCH_DEPTH) {
		failUnbounded({ depth, max: MAX_ENTITY_MATCH_DEPTH });
	}
	if (!value || typeof value !== "object") {
		return [];
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
			const matches: EntityMatch[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = ownDescriptor(value, String(index));
				if (!descriptor) continue;
				if (!("value" in descriptor)) {
					failUnbounded({ accessor: true, side: "array", index });
				}
				const match = normalizeEntityMatch(descriptor.value);
				if (match) matches.push(match);
			}
			return matches;
		}

		const matchDescriptor = ownDescriptor(value, "match");
		if (matchDescriptor) {
			if (!("value" in matchDescriptor)) {
				failUnbounded({ accessor: true, key: "match" });
			}
			return normalizeEntityMatchesInner(matchDescriptor.value, depth + 1, ctx);
		}

		const direct = normalizeEntityMatch(value);
		return direct ? [direct] : [];
	} finally {
		ctx.visiting.delete(value);
	}
}
