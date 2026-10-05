/** Normalizes an umbrella action discriminator and dispatches its handler. Missing or unknown operations return UNKNOWN_SUBACTION. */
import type { ActionResult } from "../types/components.js";

export type SubactionParameters = Record<string, unknown> | undefined;

export type SubactionHandler<TContext = void> = (
	context: TContext,
) => ActionResult | Promise<ActionResult>;

export type SubactionHandlerMap<TSubaction extends string, TContext = void> = {
	[key in TSubaction]: SubactionHandler<TContext>;
};

/** The primary discriminator is action; subaction, op, operation, and verb are accepted aliases. Owners may specify a different key when action names a nested choice. */
export const CANONICAL_SUBACTION_KEY = "action" as const;

export const LEGACY_SUBACTION_KEYS: readonly string[] = [
	"subaction",
	"op",
	"operation",
	"verb",
	"subAction",
	"__subaction",
];

/** Discriminator keys in lookup order; the primary key takes precedence. */
export const DEFAULT_SUBACTION_KEYS: readonly string[] = [
	CANONICAL_SUBACTION_KEY,
	...LEGACY_SUBACTION_KEYS,
];

export function normalizeSubaction(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return normalized.length > 0 ? normalized : undefined;
}

export function readSubaction<TSubaction extends string>(
	parameters: SubactionParameters,
	options: {
		allowed: readonly TSubaction[];
		keys?: readonly string[];
		aliases?: Partial<Record<string, TSubaction>>;
		defaultValue?: TSubaction;
	},
): TSubaction | undefined {
	const keys = options.keys ?? DEFAULT_SUBACTION_KEYS;
	const allowed = new Set<string>(options.allowed);
	const aliases = options.aliases ?? {};

	for (const key of keys) {
		const normalized = normalizeSubaction(parameters?.[key]);
		if (!normalized) continue;
		const aliased = aliases[normalized];
		if (aliased) return aliased;
		if (allowed.has(normalized)) return normalized as TSubaction;
		return undefined;
	}

	return options.defaultValue;
}

export async function dispatchSubaction<TSubaction extends string, TContext>(
	subaction: TSubaction | undefined,
	handlers: SubactionHandlerMap<TSubaction, TContext>,
	context: TContext,
): Promise<ActionResult> {
	if (!subaction || !(subaction in handlers)) {
		return {
			success: false,
			error: "UNKNOWN_SUBACTION",
			text: subaction ? `Unknown subaction: ${subaction}` : "Missing subaction",
			data: { subaction },
		};
	}

	return handlers[subaction](context);
}
