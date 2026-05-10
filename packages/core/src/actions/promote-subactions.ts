/**
 * Helper that promotes the subactions of an umbrella `Action` to virtual
 * top-level Actions. Each virtual action is named `<UMBRELLA>_<SUBACTION>`
 * and delegates to the parent's handler with `subaction: <name>` injected
 * into the parameters before dispatch.
 *
 * The parent umbrella stays registered alongside its virtuals so the planner
 * can still pick the umbrella directly with custom params; the virtuals
 * exist to GUIDE the planner toward the right subaction by giving every
 * subaction a discoverable top-level entry in the action catalogue.
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
import { CANONICAL_SUBACTION_KEY } from "./subaction-dispatch";

export interface SubactionPromotionOverrides {
	/** Override the virtual action's description. */
	description?: string;
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
 * `subaction` parameter (or one of the legacy aliases). The lookup is purely
 * structural: it inspects the JSON Schema enum on the parameter named
 * `subaction` / `op` / `action` / `operation`. Returns an empty array if no
 * enum is found.
 */
export function listSubactionsFromParameters(
	parameters: readonly ActionParameter[] | undefined,
): readonly string[] {
	if (!parameters) return [];
	const candidate = parameters.find((p) =>
		[
			CANONICAL_SUBACTION_KEY,
			"op",
			"action",
			"operation",
		].includes(p.name),
	);
	if (!candidate) return [];
	const schema = candidate.schema;
	if (!schema || typeof schema !== "object") return [];
	const enumValues = (schema as { enum?: unknown }).enum;
	if (!Array.isArray(enumValues)) return [];
	return enumValues.filter((v): v is string => typeof v === "string");
}

function toUpperSnake(value: string): string {
	return value
		.trim()
		.replace(/[\s-]+/g, "_")
		.replace(/[^A-Za-z0-9_]/g, "")
		.toUpperCase();
}

function mergeOptionsWithSubaction(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
	subaction: string,
): HandlerOptions {
	const incoming =
		(options as HandlerOptions | undefined) ?? ({} as HandlerOptions);
	const incomingParams = (incoming.parameters ?? {}) as ActionParameters;
	const mergedParams: ActionParameters = {
		...incomingParams,
		[CANONICAL_SUBACTION_KEY]: subaction,
	};
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
		const merged = mergeOptionsWithSubaction(options, subaction);
		return parentHandler(runtime, message, state, merged, callback, responses);
	};
}

function buildVirtualValidator(parent: Action): Validator {
	const parentValidate = parent.validate;
	return parentValidate;
}

/**
 * Promote each subaction of an umbrella action to a virtual top-level Action.
 *
 * Returns `[parent, ...virtuals]`. The parent is unchanged and stays at index
 * 0 so callers can safely spread the result into a plugin's `actions: [...]`
 * array. Virtual actions inject `subaction: <value>` into `options.parameters`
 * before delegating to the parent's handler.
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
				...(parent.similes ?? []),
				...(override.similes ?? []),
				toUpperSnake(sub),
			]),
		);
		const examples =
			override.examples ??
			(options.shareParentExamples ? parent.examples : undefined);

		const virtual: PromotedAction = {
			name: virtualName,
			description,
			descriptionCompressed: parent.descriptionCompressed,
			similes,
			examples,
			handler: buildVirtualHandler(parent, subKey),
			validate: buildVirtualValidator(parent),
			parameters: parent.parameters,
			contexts: parent.contexts,
			contextGate: parent.contextGate,
			roleGate: parent.roleGate,
			cacheStable: parent.cacheStable,
			cacheScope: parent.cacheScope,
			suppressPostActionContinuation: parent.suppressPostActionContinuation,
			suppressActionResultClipboard: parent.suppressActionResultClipboard,
			tags: parent.tags,
			priority: parent.priority,
			routingHint: parent.routingHint,
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

	return [parent, ...virtuals];
}

/**
 * Returns true if the given action was produced by
 * {@link promoteSubactionsToActions}. Used by tests and tooling.
 */
export function isPromotedSubactionVirtual(action: Action): boolean {
	return Boolean((action as PromotedAction)[PROMOTED_MARKER]);
}
