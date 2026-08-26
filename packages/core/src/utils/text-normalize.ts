/**
 * Text normalization helpers for prompt/context assembly.
 *
 * WHY: Several runtime paths need to turn mixed nested values into stable,
 * human-readable text blocks. Keeping this logic in one place makes prompt
 * construction more predictable and avoids each caller inventing slightly
 * different null/array/object coercion rules.
 *
 * The walk is depth-, work-, and cycle-bounded because provider output and
 * memory metadata can carry hostile nests or sparse collections. Cycles skip
 * the back-edge; over-budget graphs fail closed with a typed error.
 */

import { ElizaError } from "../errors.ts";

/** Nesting ceiling. Honest prompt values are a handful of objects deep. */
export const MAX_TEXT_NORMALIZE_DEPTH = 64;
/** Node ceiling across the whole flatten, including leaves. */
export const MAX_TEXT_NORMALIZE_NODES = 2048;
/** Collection-edge ceiling, including sparse holes and inherited keys. */
export const MAX_TEXT_NORMALIZE_EDGES = 2048;

export const TEXT_NORMALIZE_UNBOUNDED = "TEXT_NORMALIZE_UNBOUNDED";

type WalkContext = {
	visits: number;
	edges: number;
	ancestors: WeakSet<object>;
};

function failUnbounded(
	axis: "depth" | "visits" | "edges",
	context: Record<string, unknown>,
): never {
	throw new ElizaError(
		axis === "depth"
			? `text-normalize graph exceeds ${MAX_TEXT_NORMALIZE_DEPTH} nesting depth`
			: axis === "visits"
				? `text-normalize graph exceeds ${MAX_TEXT_NORMALIZE_NODES} nodes`
				: `text-normalize graph exceeds ${MAX_TEXT_NORMALIZE_EDGES} collection edges`,
		{
			code: TEXT_NORMALIZE_UNBOUNDED,
			context,
			severity: "fatal",
		},
	);
}

function reserveVisit(ctx: WalkContext): void {
	ctx.visits += 1;
	if (ctx.visits > MAX_TEXT_NORMALIZE_NODES) {
		failUnbounded("visits", {
			visits: ctx.visits,
			max: MAX_TEXT_NORMALIZE_NODES,
		});
	}
}

function reserveEdge(ctx: WalkContext): void {
	ctx.edges += 1;
	if (ctx.edges > MAX_TEXT_NORMALIZE_EDGES) {
		failUnbounded("edges", {
			edges: ctx.edges,
			max: MAX_TEXT_NORMALIZE_EDGES,
		});
	}
}

/**
 * Flatten a mixed nested value into text fragments.
 *
 * - Arrays are recursively flattened
 * - Empty/nullish values are dropped
 * - Strings are trimmed
 * - Dates become deterministic ISO-8601 strings
 * - Objects become `key: value` fragments
 * - Scalars are stringified
 */
export function flattenTextValues(value: unknown): string[] {
	return flattenTextValuesWithAncestors(value, 0, {
		visits: 0,
		edges: 0,
		ancestors: new WeakSet(),
	});
}

function flattenTextValuesWithAncestors(
	value: unknown,
	depth: number,
	ctx: WalkContext,
): string[] {
	if (depth > MAX_TEXT_NORMALIZE_DEPTH) {
		failUnbounded("depth", { depth, max: MAX_TEXT_NORMALIZE_DEPTH });
	}
	reserveVisit(ctx);

	if (Array.isArray(value)) {
		if (ctx.ancestors.has(value)) {
			return [];
		}
		ctx.ancestors.add(value);
		try {
			const fragments: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				// Holes still consume work even though they do not contribute text.
				reserveEdge(ctx);
				if (!(index in value)) continue;
				fragments.push(
					...flattenTextValuesWithAncestors(value[index], depth + 1, ctx),
				);
			}
			return fragments;
		} finally {
			ctx.ancestors.delete(value);
		}
	}

	if (value == null) {
		return [];
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}

	if (typeof value === "object") {
		const dateTimestamp = getDateTimestamp(value);
		if (dateTimestamp !== undefined) {
			return Number.isNaN(dateTimestamp)
				? [Date.prototype.toString.call(value)]
				: [Date.prototype.toISOString.call(value)];
		}
	}

	if (typeof value === "object") {
		if (ctx.ancestors.has(value)) {
			return [];
		}
		ctx.ancestors.add(value);
		try {
			const fragments: string[] = [];
			const record = value as Record<string, unknown>;
			for (const key in record) {
				// Count inherited enumeration too so a hostile prototype cannot evade the
				// work cap. Output remains restricted to enumerable own properties.
				reserveEdge(ctx);
				if (!Object.hasOwn(record, key)) continue;
				const innerText = flattenTextValuesWithAncestors(
					record[key],
					depth + 1,
					ctx,
				).join(", ");
				if (innerText) fragments.push(`${key}: ${innerText}`);
			}
			return fragments;
		} finally {
			ctx.ancestors.delete(value);
		}
	}

	return [String(value)];
}

function getDateTimestamp(value: object): number | undefined {
	try {
		if (
			!(value instanceof Date) &&
			Object.prototype.toString.call(value) !== "[object Date]"
		) {
			return undefined;
		}
		return Date.prototype.getTime.call(value);
	} catch {
		// error-policy:J3 Reject spoofed or otherwise non-Date objects.
		return undefined;
	}
}

/**
 * Convert a mixed nested value into a multi-line text block.
 */
export function toMultilineText(value: unknown): string {
	return flattenTextValues(value).join("\n");
}
