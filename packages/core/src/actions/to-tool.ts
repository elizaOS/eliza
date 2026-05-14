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
 * Stage 2 (planning) no longer goes through a single wrapper tool. Each
 * Action is exposed to the LLM as its own native tool whose name is the
 * action name and whose `parameters` is the action's parameter JSONSchema.
 * The model picks the action by name and calls it directly.
 */
export const HANDLE_RESPONSE_TOOL_NAME = "HANDLE_RESPONSE" as const;

/**
 * Schema for the `extract` field on HANDLE_RESPONSE. Populated only when
 * the inbound message states a durable fact about a user, person, or
 * relationship. Drives the facts / relationships memory pipeline.
 */
export const HANDLE_RESPONSE_EXTRACT_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		facts: {
			type: "array",
			items: { type: "string" },
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
		},
		addressedTo: {
			type: "array",
			description:
				"Entity UUIDs or participant names this message is directed at. Empty when unsure or when the message is broadcast / not directed at anyone in particular.",
			items: { type: "string" },
		},
	},
};

/**
 * Shared property definitions for the flat HANDLE_RESPONSE envelope. Declared
 * once and referenced by both the full and direct schemas so the rendered
 * shape stays byte-identical between them (only the `shouldRespond` key and the
 * `required` list differ). The key insertion order here is the canonical
 * envelope order: `shouldRespond` (full schema only), then `thought`, then
 * `replyText`, then `contexts` **directly after** `replyText`, then the
 * planning-hint fields, then `extract` last. This is the order the model is
 * trained to emit and the order the incremental field parser walks.
 */
const HANDLE_RESPONSE_REPLY_TEXT_PROPERTY: JSONSchema = {
	type: "string",
	description:
		"The user-facing reply text. Required. On the simple/direct path this is the whole answer; on the planning path it is a brief acknowledgement and the planner produces the final message.",
};

const HANDLE_RESPONSE_CONTEXTS_PROPERTY: JSONSchema = {
	type: "array",
	description:
		"Context ids to engage, drawn from available_contexts. ['simple'] (or []) = direct reply, no planner. Any other id (or 'general') = planning runs against those contexts. Comes directly after replyText.",
	items: { type: "string" },
};

const HANDLE_RESPONSE_PLANNING_HINT_PROPERTIES = {
	contextSlices: {
		type: "array",
		description:
			"Optional retrieval slice ids that would help answer this turn. Use only ids or short stable handles when visible in context.",
		items: { type: "string" },
	} as JSONSchema,
	candidateActions: {
		type: "array",
		description:
			"Optional action-like names or short operation phrases that should be used as retrieval hints for the action catalogue.",
		items: { type: "string" },
	} as JSONSchema,
	parentActionHints: {
		type: "array",
		description:
			"Optional explicit parent action names when confident. These are high-precision hints, not guesses.",
		items: { type: "string" },
	} as JSONSchema,
	requiresTool: {
		type: "boolean",
		description:
			"True when this turn needs an action/tool/provider/subagent, filesystem/runtime inspection, browser or network lookup, live/current/external data, side effects, long-running work, or verification before the user can be answered. The router upgrades empty or simple-only contexts to planning against `general` and the planner loop will retry if it returns terminal output before any non-terminal tool has run.",
	} as JSONSchema,
} as const;

/**
 * Schema for the full HANDLE_RESPONSE tool — used outside DM channels where the
 * agent must explicitly choose RESPOND / IGNORE / STOP.
 *
 * Flat, single-object envelope (no `plan` nesting): the model emits one ordered
 * object — `shouldRespond`, `thought`, `replyText`, `contexts`, then the
 * planning hints, then `extract`. `parseMessageHandlerOutput` still accepts the
 * legacy `{ processMessage, plan:{...} }` nesting for older trajectories.
 *
 * Source-of-truth note (two envelope definitions exist — read this):
 *   The schema actually sent to the Stage-1 LLM in production is composed at
 *   request time by `ResponseHandlerFieldRegistry.composeSchema()` (see
 *   `../runtime/response-handler-field-registry.ts`) from the registered
 *   builtin field evaluators (`../runtime/builtin-field-evaluators.ts`:
 *   shouldRespond / contexts / intents / replyText / candidateActionNames /
 *   facts / relationships / addressedTo). `services/message.ts` calls
 *   `createHandleResponseTool({ parameters: composeSchema() })`, so this
 *   `HANDLE_RESPONSE_SCHEMA` constant is **not** the bytes the model sees in
 *   production — it is the W3 flat-envelope shape kept here as (a) the default
 *   `parameters` for `createHandleResponseTool` when no override is passed,
 *   (b) the shape `parseMessageHandlerOutput` decodes back-compat trajectories
 *   into, and (c) a stable reference for tests / `buildResponseGrammar`'s
 *   no-field fallback. `buildResponseGrammar` (`../runtime/response-grammar.ts`)
 *   prefers the field-registry envelope when evaluators are registered (always,
 *   in production) and only falls back to this fixed key order otherwise.
 *
 *   The field registry's `composeSchema()` is canonical TODAY.
 *
 * TODO(consolidate): derive `HANDLE_RESPONSE_SCHEMA` /
 *   `HANDLE_RESPONSE_DIRECT_SCHEMA` from `composeSchema()` of the builtin field
 *   evaluators so there is one source of truth. Not done in this pass: the two
 *   envelopes have *different field sets* (W3: thought/contextSlices/
 *   parentActionHints/requiresTool/extract vs. registry: intents/
 *   candidateActionNames/facts/relationships/addressedTo), so a direct swap
 *   changes the constant's shape and breaks the W3-envelope tests + the
 *   back-compat parser path that still reads `plan.*` / `contextSlices` /
 *   `requiresTool`. The migration needs the W3 fields fully retired from the
 *   parser and the trajectory corpus first.
 */
export const HANDLE_RESPONSE_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		shouldRespond: {
			type: "string",
			enum: ["RESPOND", "IGNORE", "STOP"],
		},
		thought: { type: "string" },
		replyText: HANDLE_RESPONSE_REPLY_TEXT_PROPERTY,
		contexts: HANDLE_RESPONSE_CONTEXTS_PROPERTY,
		...HANDLE_RESPONSE_PLANNING_HINT_PROPERTIES,
		extract: HANDLE_RESPONSE_EXTRACT_SCHEMA,
	},
	required: ["shouldRespond", "replyText", "contexts"],
};

/**
 * Schema for HANDLE_RESPONSE in direct-message / API / SELF channels
 * where the agent always responds — `shouldRespond` is implicit RESPOND so we
 * drop it from the schema to save tokens and avoid spurious IGNORE.
 *
 * Voice channels do not use this direct schema: VAD/STT/turn-detection signals
 * may determine that the user is still speaking or that the agent should stay
 * silent.
 */
export const HANDLE_RESPONSE_DIRECT_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: { type: "string" },
		replyText: HANDLE_RESPONSE_REPLY_TEXT_PROPERTY,
		contexts: HANDLE_RESPONSE_CONTEXTS_PROPERTY,
		...HANDLE_RESPONSE_PLANNING_HINT_PROPERTIES,
		extract: HANDLE_RESPONSE_EXTRACT_SCHEMA,
	},
	required: ["replyText", "contexts"],
};

export interface PlannerToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: ActionParametersJsonSchema | JsonSchema;
		strict: true;
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
	"Stage 1 — pick how to handle this turn. Call exactly once per inbound message before any action tool calls. Set shouldRespond to RESPOND/IGNORE/STOP. Always write replyText (the user-facing reply). List contexts to engage (directly after replyText); set requiresTool=true when tools/actions/providers/subagents, filesystem/runtime inspection, live/current/external data, side effects, long-running work, or verification are needed. For trivial replies set contexts=['simple'] (replyText is the whole answer). Optionally include action-retrieval hints in candidateActions / parentActionHints / contextSlices and populate `extract` with durable facts/relationships from the message.";

const HANDLE_RESPONSE_DIRECT_DESCRIPTION =
	"Stage 1 (direct-message channel) — pick how to handle this turn. Call exactly once per inbound message before any action tool calls. shouldRespond is implicit RESPOND for DMs. Always write replyText (the user-facing reply). List contexts to engage (directly after replyText); set requiresTool=true when tools/actions/providers/subagents, filesystem/runtime inspection, live/current/external data, side effects, long-running work, or verification are needed. For trivial replies set contexts=['simple'] (replyText is the whole answer). Optionally include action-retrieval hints in candidateActions / parentActionHints / contextSlices and populate `extract` with durable facts/relationships from the message.";

/**
 * Build the Stage 1 tool definition. Pass `directMessage: true` for DM /
 * API / SELF channels to drop the explicit RESPOND/IGNORE/STOP flag (the
 * agent always responds in those channels). Keep it false for voice channels.
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
		parameters:
			options?.parameters ??
			(options?.directMessage
				? HANDLE_RESPONSE_DIRECT_SCHEMA
				: HANDLE_RESPONSE_SCHEMA),
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
> & {
	subActions?: Action["subActions"];
};

function actionToPlannerTool(action: PlannerToolActionShape): ToolDefinition {
	assertNativeToolName(action.name);
	const baseDescription =
		action.descriptionCompressed ??
		action.compressedDescription ??
		action.description ??
		"";
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
		strict: true,
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
 *   - `descriptionCompressed ?? compressedDescription ?? description`
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
	 * be resolved through `actionLookup`. Defaults to a no-op. Useful for
	 * threading log messages without coupling the helper to a logger.
	 */
	onUnresolvedSubAction?: (info: {
		parentName: string;
		subActionName: string;
	}) => void;
}

function normalizeParentNameKey(name: string): string {
	return String(name ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
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

function resolveActionLookup(
	lookup: BuildPlannerToolsFromTieredActionsOptions["actionLookup"],
): Map<string, PlannerToolActionShape> {
	const map = new Map<string, PlannerToolActionShape>();
	if (!lookup) {
		return map;
	}
	if (lookup instanceof Map) {
		for (const [key, value] of lookup) {
			const normalized = normalizeParentNameKey(key);
			if (normalized && value && !map.has(normalized)) {
				map.set(normalized, value);
			}
		}
		return map;
	}
	for (const [key, value] of Object.entries(lookup)) {
		const normalized = normalizeParentNameKey(key);
		if (normalized && value && !map.has(normalized)) {
			map.set(normalized, value);
		}
	}
	return map;
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

	// Top up the lookup with anything already in `actions` so children that
	// appear inline elsewhere in the input remain resolvable from a string ref.
	for (const action of actions) {
		const key = normalizeParentNameKey(action.name);
		if (key && !actionLookup.has(key)) {
			actionLookup.set(key, action);
		}
	}

	const tools: ToolDefinition[] = [];
	const emittedNames = new Set<string>();

	const emit = (action: PlannerToolActionShape): void => {
		const key = normalizeParentNameKey(action.name);
		if (!key || emittedNames.has(key)) {
			return;
		}
		emittedNames.add(key);
		tools.push(actionToPlannerTool(action));
	};

	const onUnresolved =
		options.onUnresolvedSubAction ?? ((): void => undefined);

	for (const action of actions) {
		emit(action);
		const key = normalizeParentNameKey(action.name);
		if (!tierAKeys.has(key)) {
			continue;
		}
		for (const subAction of action.subActions ?? []) {
			let child: PlannerToolActionShape | undefined;
			let subActionName = "";
			if (typeof subAction === "string") {
				subActionName = subAction;
				child = actionLookup.get(normalizeParentNameKey(subAction));
				if (!child) {
					onUnresolved({
						parentName: action.name,
						subActionName: subAction,
					});
					continue;
				}
			} else if (subAction && typeof subAction === "object") {
				subActionName = subAction.name;
				child = subAction;
			}
			if (!child) {
				continue;
			}
			try {
				emit(child);
			} catch (error) {
				// Re-throw with parent context so the caller can see which
				// umbrella surfaced an invalid sub-action name. assertNativeToolName
				// throws synchronously inside actionToPlannerTool when a name
				// fails NATIVE_TOOL_NAME_PATTERN.
				const message =
					error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to expand sub-action '${subActionName}' of '${action.name}': ${message}`,
				);
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
			strict: true,
		},
	};
}
