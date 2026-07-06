/**
 * Helper that promotes the actions of an umbrella `Action` to virtual
 * top-level Actions. Each virtual action is named `<UMBRELLA>_<SUBACTION>`
 * and delegates to the parent's handler with the discriminator value injected
 * into the parameters before dispatch.
 *
 * The parent umbrella stays registered alongside its virtuals so the planner
 * can still pick the umbrella directly with custom params. The helper also
 * records the virtuals on `parent.subActions`, so retrieval can index their
 * names/examples under the parent instead of ranking every virtual as an
 * unrelated top-level action.
 */

import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionParameters,
	Handler,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
	Validator,
} from "../types";
import {
	CANONICAL_SUBACTION_KEY,
	LEGACY_SUBACTION_KEYS,
	normalizeSubaction,
} from "./subaction-dispatch";

export interface SubactionPromotionOverrides {
	/** Override the virtual action's description. */
	description?: string;
	/**
	 * Set the virtual action's compressed description — the short one-line
	 * blurb the planner sees in tier-A / tier-B summaries. When unset, the
	 * virtual has none and consumers fall back to its composed per-subaction
	 * `description`; the parent's keyword-stuffed `descriptionCompressed` is
	 * never inherited (duplicating it across every virtual floods the
	 * planner's tool payload).
	 */
	descriptionCompressed?: string;
	/** Add similes specific to this virtual subaction. */
	similes?: readonly string[];
	/** Filter / replace examples used for the virtual. */
	examples?: ActionExample[][];
}

export interface PromoteSubactionsOptions {
	/**
	 * Per-subaction overrides keyed by the subaction value (lowercased
	 * canonical form, e.g. `list`, `create`).
	 */
	overrides?: Record<string, SubactionPromotionOverrides>;
	/**
	 * Optional name prefix override. Defaults to `parent.name`. Use this if
	 * the virtual `<PARENT>_<SUB>` would collide with an existing top-level
	 * action — e.g. pass `"LIFEOPS_MESSAGE"` if `MESSAGE_SEND` already exists
	 * elsewhere.
	 */
	namePrefix?: string;
	/**
	 * When true, the parent's `examples` are passed straight through to each
	 * virtual instead of being filtered. Useful for umbrellas whose examples
	 * already exercise multiple subactions.
	 */
	shareParentExamples?: boolean;
}

/** Marker symbol used to detect a previously-promoted parent. */
const PROMOTED_MARKER = Symbol.for("@elizaos/core/promote-subactions/marker");

interface PromotedAction extends Action {
	[PROMOTED_MARKER]?: { parent: string; virtuals: readonly string[] };
}

/**
 * Returns the list of subaction string values declared by an umbrella's
 * `action` parameter (or one of the legacy aliases). The lookup is purely
 * structural: it inspects the JSON Schema enum on the parameter named
 * `action` / `subaction` / `op` / `operation` / `verb`. Returns an empty array
 * if no enum is found.
 */
export function listSubactionsFromParameters(
	parameters: readonly ActionParameter[] | undefined,
): readonly string[] {
	if (!parameters) return [];
	const candidate = findDiscriminatorParameter(parameters);
	if (!candidate) return [];
	const schema = candidate.schema;
	if (!schema || typeof schema !== "object") return [];
	const enumValues = (schema as { enum?: unknown }).enum;
	if (!Array.isArray(enumValues)) return [];
	return enumValues.filter((v): v is string => typeof v === "string");
}

function hasEnum(parameter: ActionParameter): boolean {
	const schema = parameter.schema;
	return (
		typeof schema === "object" &&
		schema !== null &&
		Array.isArray((schema as { enum?: unknown }).enum)
	);
}

function findDiscriminatorParameter(
	parameters: readonly ActionParameter[] | undefined,
): ActionParameter | undefined {
	if (!parameters) return undefined;
	const keys = [CANONICAL_SUBACTION_KEY, ...LEGACY_SUBACTION_KEYS];
	return keys
		.map((key) => parameters.find((p) => p.name === key && hasEnum(p)))
		.find((parameter): parameter is ActionParameter => Boolean(parameter));
}

/**
 * True when `parameter` applies to the pinned `subaction`. Parameters
 * without an applicability list are shared across every subaction; an
 * explicit empty list marks a parent-only parameter. Matching goes through
 * `normalizeSubaction` so case / separator variants in hand-written lists
 * still hit the canonical enum value.
 */
function parameterAppliesToSubaction(
	parameter: ActionParameter,
	subaction: string,
): boolean {
	if (!parameter.subactions) return true;
	const pinned = normalizeSubaction(subaction);
	return parameter.subactions.some(
		(entry) => normalizeSubaction(entry) === pinned,
	);
}

/**
 * Build the virtual's exposed parameter schema:
 *
 * 1. Drop parameters whose `subactions` applicability list excludes the
 *    pinned value. Without this, every virtual duplicates the parent's FULL
 *    schema — a wide umbrella (MESSAGE: 58 parameters, 23 subactions)
 *    multiplies into hundreds of kilobytes of near-identical JSON Schema on
 *    every planner turn even though each virtual's handler reads only a
 *    handful of them. The parent keeps the full surface, so nothing is lost
 *    when the planner picks the umbrella directly. The `subactions` marker
 *    itself is stripped from the virtual's copy — once the discriminator is
 *    pinned the list carries no information.
 *
 * 2. Replace the parent's discriminator parameter (e.g. `action` with
 *    enum=[create, spawn_agent, send, ...]) with one whose enum is pinned to
 *    the single subaction value this virtual represents.
 *
 * Why the pinning matters: without it, every virtual exposes the
 * FULL discriminator enum to the LLM's tool schema, even though its name
 * already implies which subaction it dispatches. The model sees
 * `TASKS_SPAWN_AGENT(action: enum[14 values], task, agentType, ...)` and
 * is asked to set `action` to a value — but `action` is meant to be
 * implicit from the virtual name. With weaker LLMs (hosted small instruct
 * models, native function-calling planners that have to fill structured args),
 * this is the dominant cause of "TASKS umbrella
 * called with no sub-action" retry loops: the model picks the parent
 * because the virtual's schema looks more complex than the parent's.
 *
 * Pinning the enum to a single value (rather than removing the field)
 * preserves the discriminator's documentation purpose: the schema still
 * declares the discriminator and its value, so any consumer of the
 * exposed schema (tool inspectors, grammar generators, prompt
 * templates) gets a complete picture. The runtime handler still injects
 * the discriminator into `mergeOptionsWithSubaction` regardless, so
 * dispatch is unaffected.
 */
function pinDiscriminatorForVirtual(
	parameters: readonly ActionParameter[] | undefined,
	subaction: string,
): ActionParameter[] | undefined {
	if (!parameters) return undefined;
	const discriminator = findDiscriminatorParameter(parameters);
	if (!discriminator) return [...parameters];
	const sliced: ActionParameter[] = [];
	for (const parameter of parameters) {
		if (parameter.name === discriminator.name) {
			const baseSchema =
				parameter.schema && typeof parameter.schema === "object"
					? parameter.schema
					: { type: "string" as const };
			const { subactions: _stray, ...discriminatorRest } = parameter;
			sliced.push({
				...discriminatorRest,
				description: `Subaction discriminator (auto-set to "${subaction}" for this virtual; do not change).`,
				required: false,
				schema: {
					...baseSchema,
					type: baseSchema.type,
					enum: [subaction],
					default: subaction,
				},
			});
			continue;
		}
		if (!parameterAppliesToSubaction(parameter, subaction)) continue;
		const { subactions: _applicability, ...rest } = parameter;
		sliced.push(rest);
	}
	return sliced;
}

function toUpperSnake(value: string): string {
	return value
		.trim()
		.replace(/[\s-]+/g, "_")
		.replace(/[^A-Za-z0-9_]/g, "")
		.toUpperCase();
}

function mergeOptionsWithSubaction(
	parent: Action,
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
	subaction: string,
): HandlerOptions {
	const incoming =
		(options as HandlerOptions | undefined) ?? ({} as HandlerOptions);
	const incomingParams = (incoming.parameters ?? {}) as ActionParameters;
	const discriminatorKey =
		findDiscriminatorParameter(parent.parameters)?.name ??
		CANONICAL_SUBACTION_KEY;
	const parentDeclaresNestedAction = parent.parameters?.some(
		(parameter) => parameter.name === CANONICAL_SUBACTION_KEY,
	);
	const mergedParams: ActionParameters = {
		...incomingParams,
		[discriminatorKey]: subaction,
	};
	if (discriminatorKey !== "subaction") {
		mergedParams.subaction = subaction;
	}
	if (
		discriminatorKey !== CANONICAL_SUBACTION_KEY &&
		!parentDeclaresNestedAction &&
		incomingParams[CANONICAL_SUBACTION_KEY] === undefined
	) {
		mergedParams[CANONICAL_SUBACTION_KEY] = subaction;
	}
	return {
		...incoming,
		parameters: mergedParams,
	};
}

function buildVirtualHandler(parent: Action, subaction: string): Handler {
	const parentHandler = parent.handler;
	return async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions | Record<string, JsonValue | undefined>,
		callback?: HandlerCallback,
		responses?: Memory[],
	) => {
		const merged = mergeOptionsWithSubaction(parent, options, subaction);
		return parentHandler(runtime, message, state, merged, callback, responses);
	};
}

function buildVirtualValidator(parent: Action, subaction: string): Validator {
	const parentValidate = parent.validate;
	if (!parentValidate) return async () => true;
	return (runtime, message, state, options) => {
		const merged = mergeOptionsWithSubaction(parent, options, subaction);
		return parentValidate(runtime, message, state, merged);
	};
}

/**
 * Promote each subaction of an umbrella action to a virtual top-level Action.
 *
 * Returns `[parent, ...virtuals]`. The parent stays at index 0 so callers can
 * safely spread the result into a plugin's `actions: [...]` array. The parent
 * is annotated with the virtual names as `subActions`; virtual actions inject
 * the parent's structural discriminator into `options.parameters` before
 * delegating to the parent's handler.
 *
 * Calling this function twice on the same parent is idempotent: the second
 * call returns a freshly-built but structurally identical set of virtuals.
 */
export function promoteSubactionsToActions(
	parent: Action,
	options: PromoteSubactionsOptions = {},
): readonly Action[] {
	const subactions = listSubactionsFromParameters(parent.parameters);
	if (subactions.length === 0) return [parent];

	const namePrefix = options.namePrefix ?? parent.name;
	const overrides = options.overrides ?? {};

	const virtuals: PromotedAction[] = subactions.map((sub) => {
		const subKey = sub.toLowerCase();
		const override = overrides[subKey] ?? {};
		const virtualName = `${toUpperSnake(namePrefix)}_${toUpperSnake(sub)}`;
		const subBlurb = override.description
			? override.description
			: `subaction = ${subKey}`;
		const description = `${parent.description} — ${subBlurb}`;
		const similes = Array.from(
			new Set([
				// Parent's name is first so simile-based search/routing can still
				// find promoted actions through the parent surface.
				toUpperSnake(parent.name),
				...(parent.similes ?? []),
				...(override.similes ?? []),
				toUpperSnake(sub),
			]),
		);
		const examples =
			override.examples ??
			(options.shareParentExamples ? parent.examples : undefined);

		// The parent's `descriptionCompressed` (a keyword-stuffed retrieval
		// blurb) and `routingHint` are deliberately NOT inherited: duplicated
		// verbatim across every virtual they multiply into tens of kilobytes
		// of identical tool-description text per planner turn. Retrieval still
		// finds virtuals through their similes (parent name + subaction) and
		// through the parent's own search text, and tool rendering falls back
		// to the short composed `description` when no per-subaction
		// `descriptionCompressed` override is provided.
		const virtual: PromotedAction = {
			name: virtualName,
			description,
			descriptionCompressed: override.descriptionCompressed,
			similes,
			examples,
			handler: buildVirtualHandler(parent, subKey),
			validate: buildVirtualValidator(parent, subKey),
			parameters: pinDiscriminatorForVirtual(parent.parameters, subKey),
			contexts: parent.contexts,
			contextGate: parent.contextGate,
			roleGate: parent.roleGate,
			cacheStable: parent.cacheStable,
			cacheScope: parent.cacheScope,
			suppressPostActionContinuation: parent.suppressPostActionContinuation,
			suppressActionResultClipboard: parent.suppressActionResultClipboard,
			suppressEarlyReply: parent.suppressEarlyReply,
			tags: parent.tags,
			priority: parent.priority,
			connectorAccountPolicy: parent.connectorAccountPolicy,
			accountPolicy: parent.accountPolicy,
		};
		Object.defineProperty(virtual, PROMOTED_MARKER, {
			value: { parent: parent.name, virtuals: [virtualName] },
			enumerable: false,
			configurable: false,
			writable: false,
		});
		return virtual;
	});

	attachVirtualSubactions(
		parent,
		virtuals.map((virtual) => virtual.name),
	);

	return [parent, ...virtuals];
}

/**
 * Returns true if the given action was produced by
 * {@link promoteSubactionsToActions}. Used by tests and tooling.
 */
export function isPromotedSubactionVirtual(action: Action): boolean {
	return Boolean((action as PromotedAction)[PROMOTED_MARKER]);
}

function attachVirtualSubactions(
	parent: Action,
	virtualNames: readonly string[],
) {
	if (virtualNames.length === 0) {
		return;
	}

	const existing = parent.subActions ?? [];
	const seen = new Set(
		existing.map((entry) =>
			toUpperSnake(typeof entry === "string" ? entry : entry.name),
		),
	);
	const additions = virtualNames.filter((name) => {
		const normalized = toUpperSnake(name);
		if (seen.has(normalized)) {
			return false;
		}
		seen.add(normalized);
		return true;
	});

	if (additions.length === 0) {
		return;
	}

	parent.subActions = [...existing, ...additions];
}
