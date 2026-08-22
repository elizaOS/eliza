/**
 * Builds the model's tool-calling surface from Actions. Defines the canonical
 * Stage 1 `HANDLE_RESPONSE` tool (schema + description, with a direct-message
 * variant) through which the model declares turn intent, and the Stage 2 planner
 * tools where each Action becomes a native tool named by the action name with its
 * `parameters` JSON Schema. Tier-aware expansion promotes tier-A parents'
 * sub-actions to first-class tools; tier-B parents stay parent-only and route
 * internally. Also emits the always-available REPLY / IGNORE / STOP terminal
 * sentinels so the planner can end a turn regardless of action narrowing. Sits
 * between the action catalog and the model layer; parameter schemas come from
 * `normalizeActionJsonSchema` (`action-schema.ts`). Tool names must match
 * `NATIVE_TOOL_NAME_PATTERN` or conversion throws.
 */
import { ElizaError } from "../errors";
import type { Action } from "../types";
import type { JSONSchema, ToolDefinition } from "../types/model";
import {
	type ActionParametersJsonSchema,
	actionToJsonSchema,
	type JsonSchema,
	normalizeActionJsonSchema,
} from "./action-schema";

export const NATIVE_TOOL_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Canonical Stage 1 tool name.
 *
 * - HANDLE_RESPONSE: stage 1, called once per inbound message. The model
 *   declares intent (RESPOND / IGNORE / STOP), picks contexts to engage,
 *   may emit a simple-mode reply directly, and may extract durable
 *   facts / relationships for the memory pipeline.
 *
 * Stage 2 (planning) does not go through a single wrapper tool. Each
 * Action is exposed to the LLM as its own native tool whose name is the
 * action name and whose `parameters` is the action's parameter JSONSchema.
 * The model picks the action by name and calls it directly.
 */
export const HANDLE_RESPONSE_TOOL_NAME = "HANDLE_RESPONSE" as const;

/** Shared should-respond contract for static and registry-composed schemas. */
export const SHOULD_RESPOND_SCHEMA_DESCRIPTION =
	'RESPOND=reply/run actions — a question, a request, an active conversation, or ambient chatter with real substance you can usefully add to. IGNORE=silent — pure content-free acknowledgements/reactions ("lol", "ok", "nice", "same", "haha", "brb"), bot/webhook/status feeds, or people clearly talking to each other. STOP=explicit user stop.';

/**
 * Canonical Stage-1 HANDLE_RESPONSE parameters. This mirrors the builtin
 * ResponseHandlerFieldRegistry field order used in production. Plugin callers
 * may still pass an explicit `parameters` object to `createHandleResponseTool`;
 * callers that omit it get the same builtin field shape.
 */
export const HANDLE_RESPONSE_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		shouldRespond: {
			type: "string",
			enum: ["RESPOND", "IGNORE", "STOP"],
			description: SHOULD_RESPOND_SCHEMA_DESCRIPTION,
		},
		contexts: {
			type: "array",
			items: { type: "string" },
			description:
				"Context ids from available_contexts. 'simple'=direct reply, no planner.",
		},
		intents: {
			type: "array",
			items: { type: "string" },
			description: "Verb-led intents. Lowercase. No punctuation. ~6 words max.",
		},
		replyText: {
			type: "string",
			description:
				'User-facing reply. Simple=whole answer. Planning=brief ack ("On it.", "Working on it."). When declining a capability you lack, say plainly that you can\'t do it; do NOT invent a reason you are unsure of (e.g. "no shell access in this channel", "not connected") — an invented surface/setup cause misleads when the real reason is permission or availability.',
		},
		replyEffectStatus: {
			type: "string",
			enum: ["none", "applied", "non_applied"],
			description:
				"Whether replyText semantically claims an external change already happened, says it did not, or makes no effect claim.",
		},
		candidateActionNames: {
			type: "array",
			items: { type: "string" },
			description:
				"Action names. UPPER_SNAKE_CASE. Retrieval hints; high-precision hits expose planner actions.",
		},
		facts: {
			type: "array",
			items: { type: "string" },
			description: "Durable user/person facts stated this turn.",
		},
		relationships: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					subject: { type: "string" },
					predicate: { type: "string" },
					object: { type: "string" },
				},
				required: ["subject", "predicate", "object"],
			},
			description: "Durable subject-predicate-object relationships.",
		},
		topics: {
			type: "array",
			items: { type: "string" },
			description:
				"Short topic labels for this message. Lowercase nouns/noun-phrases. Max 5.",
		},
		addressedTo: {
			type: "array",
			items: { type: "string" },
			description:
				"Entity UUIDs or participant names this message is directed at.",
		},
		emotion: {
			type: "string",
			enum: [
				"none",
				"happy",
				"sad",
				"angry",
				"nervous",
				"calm",
				"excited",
				"whisper",
			],
			description: "Expressive voice emotion tag.",
		},
	},
	required: [
		"shouldRespond",
		"contexts",
		"intents",
		"replyText",
		"replyEffectStatus",
		"candidateActionNames",
		"facts",
		"relationships",
		"topics",
		"addressedTo",
		"emotion",
	],
};

export interface PlannerToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: ActionParametersJsonSchema | JsonSchema;
		strict: boolean;
	};
}

export function assertNativeToolName(name: string): void {
	if (!NATIVE_TOOL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid tool name '${name}'. Native tool names must match ${NATIVE_TOOL_NAME_PATTERN}.`,
		);
	}
}

const HANDLE_RESPONSE_DESCRIPTION =
	"Stage 1: handle turn. Call exactly once before action tools. Fill registered fields: shouldRespond, contexts, intents, replyText, replyEffectStatus, candidateActionNames, facts, relationships, topics, addressedTo, emotion. Trivial reply: contexts=['simple'], replyText whole answer. Tool/planning path: choose non-simple contexts or candidateActionNames and use brief replyText ack.";

const HANDLE_RESPONSE_DIRECT_DESCRIPTION =
	"Stage 1 direct-message: handle turn. Call exactly once before action tools. Fill registered fields: shouldRespond, contexts, intents, replyText, replyEffectStatus, candidateActionNames, facts, relationships, topics, addressedTo, emotion. Usually RESPOND unless explicit stop. Trivial reply: contexts=['simple'], replyText whole answer. Tool/planning path: choose non-simple contexts or candidateActionNames and use brief replyText ack.";

/**
 * Build the Stage 1 tool definition. Pass `directMessage: true` for DM /
 * API / SELF channels to use the direct-message description. The schema stays
 * canonical and still includes `shouldRespond`; the field evaluator decides the
 * value, and direct-message defaults are handled by prompt/parse policy.
 */
export function createHandleResponseTool(options?: {
	directMessage?: boolean;
	parameters?: JSONSchema;
	description?: string;
}): ToolDefinition {
	return {
		name: HANDLE_RESPONSE_TOOL_NAME,
		description:
			options?.description ??
			(options?.directMessage
				? HANDLE_RESPONSE_DIRECT_DESCRIPTION
				: HANDLE_RESPONSE_DESCRIPTION),
		type: "function",
		strict: true,
		parameters: options?.parameters ?? HANDLE_RESPONSE_SCHEMA,
	};
}

/**
 * Stage 1 tool. The model uses this once per inbound message to declare
 * how it wants to handle the turn. Output drives the rest of the pipeline:
 *
 *   shouldRespond = "RESPOND" → engage `contexts`, run planner against the per-action tools
 *   shouldRespond = "IGNORE"  → terminate silently
 *   shouldRespond = "STOP"    → terminate with terminal stop signal
 *
 * `replyText` is always present (the user-facing reply). For trivially simple
 * replies that don't need action planning the model sets `contexts = ["simple"]`
 * (or leaves it empty) and `replyText` is the whole answer — the runtime emits
 * it without invoking the planner. Otherwise planning runs against `contexts`
 * and the planner produces the final message; `replyText` then serves as the
 * early acknowledgement.
 */
export const HANDLE_RESPONSE_TOOL: ToolDefinition = createHandleResponseTool();

/**
 * Synthetic terminal-sentinel action shapes. REPLY and IGNORE are real
 * runtime Actions (see `features/basic-capabilities/actions/`) but they
 * are not always part of the per-turn narrowed action surface. The
 * planner needs a stable, always-available way for the model to end the
 * turn — these shapes are converted into `ToolDefinition`s by
 * {@link CORE_PLANNER_TERMINALS} so every Stage 2 request exposes them.
 *
 * STOP is purely a terminal sentinel (no runtime handler — the planner
 * loop's `isTerminalToolCall` recognises the name).
 */
const REPLY_TERMINAL_ACTION: Pick<
	Action,
	| "name"
	| "description"
	| "descriptionCompressed"
	| "parameters"
	| "allowAdditionalParameters"
> = {
	name: "REPLY",
	description:
		"Emit a user-facing reply to terminate the turn. Use this once the work is done and the model has produced the final answer.",
	descriptionCompressed: "reply to the user with text; terminates the turn",
	parameters: [
		{
			name: "text",
			description: "The user-facing reply text.",
			required: false,
			schema: { type: "string" },
		},
	],
};

const IGNORE_TERMINAL_ACTION: Pick<
	Action,
	| "name"
	| "description"
	| "descriptionCompressed"
	| "parameters"
	| "allowAdditionalParameters"
> = {
	name: "IGNORE",
	description: "Terminate the turn silently. Use when no reply is appropriate.",
	descriptionCompressed: "terminate the turn silently; emit no reply",
	parameters: [],
};

const STOP_TERMINAL_ACTION: Pick<
	Action,
	| "name"
	| "description"
	| "descriptionCompressed"
	| "parameters"
	| "allowAdditionalParameters"
> = {
	name: "STOP",
	description: "Stop the current turn immediately with a terminal stop signal.",
	descriptionCompressed: "stop the turn with a terminal stop signal",
	parameters: [],
};

/** Minimal Action shape consumed by the planner-tool conversion helpers. */
export type PlannerToolActionShape = Pick<
	Action,
	| "name"
	| "description"
	| "descriptionCompressed"
	| "compressedDescription"
	| "routingHint"
	| "parameters"
	| "allowAdditionalParameters"
	| "toolSchemaStrict"
> & {
	subActions?: Action["subActions"];
};

function actionToPlannerTool(action: PlannerToolActionShape): ToolDefinition {
	assertNativeToolName(action.name);
	const baseDescription =
		action.descriptionCompressed ??
		action.compressedDescription ??
		action.description;
	const routingHint = action.routingHint?.trim();
	const description = routingHint
		? `${routingHint}\n${baseDescription}`.trim()
		: baseDescription;
	const parameters = normalizeActionJsonSchema({
		parameters: action.parameters,
		allowAdditionalParameters: action.allowAdditionalParameters,
	});
	return {
		name: action.name,
		description,
		type: "function",
		strict: action.toolSchemaStrict ?? true,
		parameters,
	};
}

/**
 * Build a per-turn list of `ToolDefinition`s from the narrowed Stage 2
 * action surface. Each action becomes a native tool whose name is the
 * action name and whose `parameters` is the action's parameter
 * JSONSchema, so the LLM calls each action directly by name.
 *
 * Tool description is composed from (in order):
 *   - the action's `routingHint` (if present, on its own line)
 *   - `descriptionCompressed ?? description`
 *
 * The order of `actions` is preserved in the output (callers control
 * tool ordering by ordering the input). Names are validated against
 * {@link NATIVE_TOOL_NAME_PATTERN}; an invalid name throws.
 */
export function buildPlannerToolsFromActions(
	actions: ReadonlyArray<PlannerToolActionShape>,
): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const action of actions) {
		tools.push(actionToPlannerTool(action));
	}
	return tools;
}

/**
 * Options accepted by {@link buildPlannerToolsFromTieredActions}.
 */
export interface BuildPlannerToolsFromTieredActionsOptions {
	/**
	 * Set of parent action names (case-insensitive, matched against
	 * `Action.name` after normalization) whose `subActions` should be expanded
	 * as first-class planner tools. Parents not in this set get only their own
	 * tool exposed — the parent's handler is responsible for routing to a
	 * sub-action when the planner picks the umbrella.
	 *
	 * Pass the tiered-action-surface `tierAParents` from the action surface
	 * metadata. When omitted or empty, no expansion happens and the behavior
	 * matches {@link buildPlannerToolsFromActions} exactly.
	 */
	tierAParents?: ReadonlySet<string> | readonly string[];
	/**
	 * Optional registry of `name → Action` used to resolve string-only
	 * sub-action references (parents may declare `subActions: ["FOO_BAR"]`).
	 * When a string reference is not resolvable through this map, it is
	 * skipped silently — string refs are advisory and the parent's handler
	 * can still dispatch to them internally if the planner picks the parent.
	 *
	 * Inline-Action sub-actions (where `parent.subActions[i]` is an Action
	 * object, not a string) are always expanded regardless of this map.
	 */
	actionLookup?:
		| ReadonlyMap<string, PlannerToolActionShape>
		| Readonly<Record<string, PlannerToolActionShape>>;
	/**
	 * Optional callback invoked when a string sub-action reference could not
	 * be resolved through `actionLookup`. Defaults to skipped. Useful for
	 * threading log messages without coupling the helper to a logger.
	 */
	onUnresolvedSubAction?: (info: {
		parentName: string;
		subActionName: string;
	}) => void;
	/**
	 * Per-parent allow-list of sub-action names (case-insensitive) to expand
	 * for tier-A parents. Produced by the tiering surface's per-parent child
	 * narrowing (`maxTierAChildrenPerParent` in `tierActionResults`): when a
	 * parent has an entry, only the listed children become first-class tools;
	 * every other subaction stays reachable through the parent umbrella tool,
	 * whose handler dispatches any subaction. Parents WITHOUT an entry expand
	 * all sub-actions, so full-surface mode and callers that never narrow are
	 * unaffected.
	 */
	tierAChildrenByParent?:
		| ReadonlyMap<string, readonly string[]>
		| Readonly<Record<string, readonly string[]>>;
}

/**
 * Lenient key used ONLY for matching caller-supplied *hints* against action
 * names: the tier-A parent set and the per-parent child allow-list. Those are
 * configuration-shaped inputs, so separators and case are deliberately ignored.
 *
 * It must never be used as an action's IDENTITY. Because it strips every
 * non-alphanumeric character, distinct registered actions such as
 * `GMAIL_CREATE_DRAFT` and `GMAILCREATEDRAFT` — both legal under
 * {@link NATIVE_TOOL_NAME_PATTERN}, and treated as distinct everywhere else in
 * the runtime (see `matchActionWildcardParts`) — collapse onto one key. Keying
 * emission or sub-action resolution on it silently drops one of the pair from
 * the planner surface, or resolves a string sub-action reference to the wrong
 * Action. Use {@link toolIdentityKey} for identity.
 */
function normalizeParentNameKey(name: string): string {
	return String(name)
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

/**
 * Identity of an emitted tool. This is the exact string the model will send
 * back as the tool name, so two actions are the same tool if and only if their
 * names are equal. Only surrounding whitespace is trimmed;
 * {@link assertNativeToolName} already constrains the rest of the shape (upper
 * snake case), so no case folding is needed.
 */
function toolIdentityKey(name: string): string {
	return String(name).trim();
}

function buildParentNameSet(
	tierAParents: BuildPlannerToolsFromTieredActionsOptions["tierAParents"],
): Set<string> {
	const set = new Set<string>();
	if (!tierAParents) {
		return set;
	}
	const source: Iterable<string> = Array.isArray(tierAParents)
		? (tierAParents as readonly string[])
		: (tierAParents as ReadonlySet<string>);
	for (const name of source) {
		const key = normalizeParentNameKey(name);
		if (key) {
			set.add(key);
		}
	}
	return set;
}

function resolveTierAChildAllowlist(
	value: BuildPlannerToolsFromTieredActionsOptions["tierAChildrenByParent"],
): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	if (!value) {
		return map;
	}
	const entries: Iterable<[string, readonly string[]]> =
		value instanceof Map ? value : Object.entries(value);
	for (const [parentName, childNames] of entries) {
		const parentKey = normalizeParentNameKey(parentName);
		if (!parentKey || !Array.isArray(childNames)) {
			continue;
		}
		const childKeys = new Set<string>();
		for (const childName of childNames) {
			const childKey = normalizeParentNameKey(String(childName));
			if (childKey) {
				childKeys.add(childKey);
			}
		}
		map.set(parentKey, childKeys);
	}
	return map;
}

/**
 * Sub-action reference resolver.
 *
 * Exact names win. A separator/case-insensitive fallback is kept so a parent
 * declaring `subActions: ["play-music"]` still finds `PLAY_MUSIC`, but a
 * loose key that more than one distinct action answers to is AMBIGUOUS and
 * resolves to nothing rather than silently picking the first insertion — the
 * previous behaviour handed the planner a tool built from the wrong Action's
 * schema.
 */
class ActionLookup {
	private readonly exact = new Map<string, PlannerToolActionShape>();
	private readonly loose = new Map<string, PlannerToolActionShape | null>();

	add(key: string, value: PlannerToolActionShape | undefined): void {
		if (!value) {
			return;
		}
		const identity = toolIdentityKey(key);
		if (!identity || this.exact.has(identity)) {
			return;
		}
		this.exact.set(identity, value);

		const looseKey = normalizeParentNameKey(key);
		if (!looseKey) {
			return;
		}
		if (!this.loose.has(looseKey)) {
			this.loose.set(looseKey, value);
			return;
		}
		// A second, differently-spelled action answers to the same loose key.
		// Poison it so the fallback cannot guess.
		this.loose.set(looseKey, null);
	}

	has(key: string): boolean {
		return this.exact.has(toolIdentityKey(key));
	}

	get(key: string): PlannerToolActionShape | undefined {
		const identity = toolIdentityKey(key);
		const exactMatch = this.exact.get(identity);
		if (exactMatch) {
			return exactMatch;
		}
		return this.loose.get(normalizeParentNameKey(key)) ?? undefined;
	}
}

function resolveActionLookup(
	lookup: BuildPlannerToolsFromTieredActionsOptions["actionLookup"],
): ActionLookup {
	const resolved = new ActionLookup();
	if (!lookup) {
		return resolved;
	}
	const entries: Iterable<[string, PlannerToolActionShape]> =
		lookup instanceof Map ? lookup : Object.entries(lookup);
	for (const [key, value] of entries) {
		resolved.add(key, value);
	}
	return resolved;
}

/**
 * Build a per-turn list of `ToolDefinition`s from a tier-aware Stage 2 action
 * surface. Behaves like {@link buildPlannerToolsFromActions} when no
 * `tierAParents` are provided. When `tierAParents` is non-empty, sub-actions of
 * any input action whose name is in that set are expanded into first-class
 * tools alongside the parent, so the planner can call a specific sub-action
 * directly without a "dig into the parent" round-trip.
 *
 * Tier-B parents (anything in `actions` but NOT in `tierAParents`) are exposed
 * as parent-only tools — the parent's handler is responsible for dispatching
 * to a sub-action when the planner picks the umbrella.
 *
 * Sub-action resolution:
 *   - Inline `Action` sub-actions on `parent.subActions` are always expanded.
 *   - String-only sub-action references are resolved through `actionLookup`
 *     when provided; references that cannot be resolved are skipped silently
 *     (the parent's handler can still route to them).
 *
 * The output is deduplicated by tool `name` — if a child appears both as a
 * top-level entry in `actions` AND as a sub-action under a tier-A parent, it
 * is emitted only once. Input order is preserved: each parent is followed by
 * its expanded children (in `subActions` declaration order) before the next
 * parent in `actions`.
 */
export function buildPlannerToolsFromTieredActions(
	actions: ReadonlyArray<PlannerToolActionShape>,
	options: BuildPlannerToolsFromTieredActionsOptions = {},
): ToolDefinition[] {
	const tierAKeys = buildParentNameSet(options.tierAParents);
	const actionLookup = resolveActionLookup(options.actionLookup);
	const childAllowlistByParent = resolveTierAChildAllowlist(
		options.tierAChildrenByParent,
	);

	// Top up the lookup with anything already in `actions` so children that
	// appear inline elsewhere in the input remain resolvable from a string ref.
	for (const action of actions) {
		if (!actionLookup.has(action.name)) {
			actionLookup.add(action.name, action);
		}
	}

	const tools: ToolDefinition[] = [];
	const emittedNames = new Set<string>();

	const emit = (action: PlannerToolActionShape): void => {
		// Dedupe on the tool's IDENTITY, not the lenient hint key: two actions
		// whose names differ only by separators are two different tools and both
		// must reach the planner.
		const key = toolIdentityKey(action.name);
		if (!key || emittedNames.has(key)) {
			return;
		}
		emittedNames.add(key);
		tools.push(actionToPlannerTool(action));
	};

	const onUnresolved = options.onUnresolvedSubAction ?? ((): void => undefined);

	for (const action of actions) {
		emit(action);
		const key = normalizeParentNameKey(action.name);
		if (!tierAKeys.has(key)) {
			continue;
		}
		const allowedChildren = childAllowlistByParent.get(key);
		for (const subAction of action.subActions ?? []) {
			let child: PlannerToolActionShape | undefined;
			let subActionName = "";
			if (typeof subAction === "string") {
				subActionName = subAction;
			} else if (subAction && typeof subAction === "object") {
				subActionName = subAction.name;
				child = subAction;
			}
			// The allow-list check runs before string-ref resolution: a
			// narrowed-out child is an intentional skip (it stays dispatchable
			// through the parent umbrella), not an unresolvable reference, so
			// it must not fire onUnresolvedSubAction.
			if (
				allowedChildren &&
				!allowedChildren.has(normalizeParentNameKey(subActionName))
			) {
				continue;
			}
			if (typeof subAction === "string") {
				child = actionLookup.get(subAction);
				if (!child) {
					onUnresolved({
						parentName: action.name,
						subActionName: subAction,
					});
					continue;
				}
			}
			if (!child) {
				continue;
			}
			try {
				emit(child);
			} catch (error) {
				// error-policy:J2 Parent action context identifies which tool catalog
				// entry contributed the invalid native tool name.
				throw new ElizaError("Failed to expand planner sub-action", {
					code: "INVALID_SUB_ACTION_TOOL",
					cause: error,
					context: { actionName: action.name, subActionName },
				});
			}
		}
	}

	return tools;
}

/**
 * Universal terminal-sentinel tools. Always exposed to the planner regardless
 * of action narrowing so the model can end the turn with a stable, known
 * surface. REPLY emits the final user-facing message; IGNORE / STOP terminate
 * without a reply.
 *
 * Computed lazily inside the array so a static import does not pull in the
 * action runtime; the shapes are simple data.
 */
export const CORE_PLANNER_TERMINALS: ReadonlyArray<ToolDefinition> =
	buildPlannerToolsFromActions([
		REPLY_TERMINAL_ACTION,
		IGNORE_TERMINAL_ACTION,
		STOP_TERMINAL_ACTION,
	]);

/**
 * Build a per-action tool definition. Retained for internal renderers and
 * external callers (e.g. local-AI grammar wiring) that still want the
 * `{type, function: {...}}` envelope shape. Stage 2 planning itself uses
 * {@link buildPlannerToolsFromActions} instead — that shape is the flat
 * `ToolDefinition` accepted by the provider plumbing.
 */
export function actionToTool(action: Action): PlannerToolDefinition {
	assertNativeToolName(action.name);

	return {
		type: "function",
		function: {
			name: action.name,
			description:
				action.descriptionCompressed ??
				action.compressedDescription ??
				action.description,
			parameters: actionToJsonSchema(action),
			strict: action.toolSchemaStrict ?? true,
		},
	};
}
