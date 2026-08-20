/**
 * Bounds the Discord structured-content walk used to render outbound
 * message text. Agent `content.text` can carry nested `content`/`parts`
 * graphs; the previous recursive collect RangeError'd a 2k-deep array nest
 * on Node 24.15.0. Depth, node, and cycle limits are all load-bearing.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_DISCORD_STRUCTURED_TEXT_DEPTH = 32;
export const MAX_DISCORD_STRUCTURED_TEXT_NODES = 2_048;
export const DISCORD_STRUCTURED_TEXT_UNBOUNDED =
	"DISCORD_STRUCTURED_TEXT_UNBOUNDED";

const PRIMARY_TEXT_KEYS = ["text", "responseText", "message", "body"] as const;
const COLLECTION_KEYS = [
	"content",
	"parts",
	"blocks",
	"items",
	"segments",
] as const;
const FALLBACK_TEXT_KEYS = ["title", "summary"] as const;

type WalkContext = {
	visits: number;
	seen: WeakSet<object>;
};

function failUnbounded(context: Record<string, unknown>): never {
	throw new ElizaError(
		"Discord structured message text exceeds the render walk budget",
		{
			code: DISCORD_STRUCTURED_TEXT_UNBOUNDED,
			context,
			severity: "fatal",
		},
	);
}

function reserve(ctx: WalkContext, count: number): void {
	if (count > MAX_DISCORD_STRUCTURED_TEXT_NODES - ctx.visits) {
		failUnbounded({
			visits: ctx.visits + count,
			maxNodes: MAX_DISCORD_STRUCTURED_TEXT_NODES,
		});
	}
	ctx.visits += count;
}

function dataValue(value: object, key: string): unknown {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch (cause) {
		throw new ElizaError(
			"Discord structured message text could not be safely inspected",
			{
				code: DISCORD_STRUCTURED_TEXT_UNBOUNDED,
				context: { operation: "getOwnPropertyDescriptor", key },
				cause,
				severity: "fatal",
			},
		);
	}
	if (!descriptor || !("value" in descriptor)) return undefined;
	return descriptor.value;
}

function isArray(value: object): boolean {
	try {
		return Array.isArray(value);
	} catch (cause) {
		throw new ElizaError(
			"Discord structured message text could not be safely inspected",
			{
				code: DISCORD_STRUCTURED_TEXT_UNBOUNDED,
				context: { operation: "isArray" },
				cause,
				severity: "fatal",
			},
		);
	}
}

function collectStructuredText(
	value: unknown,
	depth: number,
	ctx: WalkContext,
	visitAlreadyReserved = false,
): string[] {
	if (depth > MAX_DISCORD_STRUCTURED_TEXT_DEPTH) {
		failUnbounded({ depth, max: MAX_DISCORD_STRUCTURED_TEXT_DEPTH });
	}
	if (typeof value === "string") {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return value.trim() ? [value] : [];
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		if (!visitAlreadyReserved) reserve(ctx, 1);
		return [String(value)];
	}
	if (!value || typeof value !== "object") {
		return [];
	}
	if (!visitAlreadyReserved) reserve(ctx, 1);
	if (ctx.seen.has(value)) {
		return [];
	}
	ctx.seen.add(value);
	if (isArray(value)) {
		const length = dataValue(value, "length");
		if (!Number.isSafeInteger(length) || (length as number) < 0) {
			failUnbounded({ operation: "arrayLength", length });
		}
		reserve(ctx, length as number);
		const fragments: string[] = [];
		for (let index = 0; index < (length as number); index += 1) {
			const child = dataValue(value, String(index));
			if (child === undefined) continue;
			fragments.push(...collectStructuredText(child, depth + 1, ctx, true));
		}
		return fragments;
	}

	for (const key of PRIMARY_TEXT_KEYS) {
		const child = dataValue(value, key);
		if (child === undefined) continue;
		const normalized = collectStructuredText(child, depth + 1, ctx);
		if (normalized.length > 0) {
			return normalized;
		}
	}
	for (const key of COLLECTION_KEYS) {
		const child = dataValue(value, key);
		if (child === undefined) continue;
		const normalized = collectStructuredText(child, depth + 1, ctx);
		if (normalized.length > 0) {
			return normalized;
		}
	}
	for (const key of FALLBACK_TEXT_KEYS) {
		const child = dataValue(value, key);
		if (child === undefined) continue;
		const normalized = collectStructuredText(child, depth + 1, ctx);
		if (normalized.length > 0) {
			return normalized;
		}
	}
	return [];
}

export function normalizeDiscordMessageText(value: unknown): string {
	const fragments = collectStructuredText(value, 0, {
		visits: 0,
		seen: new WeakSet<object>(),
	})
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment.length > 0);
	if (fragments.length === 0) {
		return "";
	}
	return fragments.join("\n\n");
}
