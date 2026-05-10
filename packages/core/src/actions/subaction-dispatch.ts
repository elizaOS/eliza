import type { ActionResult } from "../types";

export type SubactionParameters = Record<string, unknown> | undefined;

export type SubactionHandler<TContext = void> = (
	context: TContext,
) => ActionResult | Promise<ActionResult>;

export type SubactionHandlerMap<TSubaction extends string, TContext = void> = {
	[key in TSubaction]: SubactionHandler<TContext>;
};

/**
 * Canonical project-wide discriminator field name for umbrella actions.
 *
 * Umbrella actions previously used a mix of `op`, `action`, `operation`,
 * and `subaction`. The canonical name is now `subaction`. The other names
 * remain accepted as input aliases so cached planner outputs do not break,
 * but new schema documentation, examples, and tests should use `subaction`.
 */
export const CANONICAL_SUBACTION_KEY = "subaction" as const;

/**
 * Default ordered list of parameter keys that {@link readSubaction} consults
 * when an umbrella's handler resolves the requested operation. The canonical
 * key is consulted first; legacy aliases follow.
 */
export const DEFAULT_SUBACTION_KEYS: readonly string[] = [
	CANONICAL_SUBACTION_KEY,
	"op",
	"action",
	"operation",
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
