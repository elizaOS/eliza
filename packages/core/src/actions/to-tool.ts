import type { Action } from "../types";
import type { JSONSchema, ToolDefinition } from "../types/model";
import {
	type ActionParametersJsonSchema,
	actionToJsonSchema,
	type JsonSchema,
} from "./action-schema";

export const NATIVE_TOOL_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The two canonical tool names exposed to the LLM. Holding the tool list
 * to a fixed pair keeps the prompt-cache key byte-stable across requests
 * even when the available action set or selected contexts change per turn.
 *
 * - HANDLE_RESPONSE: stage 1, called once per inbound message. The model
 *   declares intent (RESPOND / IGNORE / STOP), picks contexts to engage,
 *   may emit a simple-mode reply directly, and may extract durable
 *   facts / relationships for the memory pipeline.
 *
 * - PLAN_ACTIONS: stage 2, called repeatedly during the planner loop to
 *   invoke an action (or sub-action) by name with parameters.
 *
 * Both tools are present in tool-capable requests. Stage 2 normally uses
 * `tool_choice: "auto"` for cache stability, but can force `"required"` when
 * the Stage 1 router has already determined that the current turn must run a
 * non-terminal tool.
 */
export const HANDLE_RESPONSE_TOOL_NAME = "HANDLE_RESPONSE" as const;
export const PLAN_ACTIONS_TOOL_NAME = "PLAN_ACTIONS" as const;

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
 * Schema for HANDLE_RESPONSE in direct-message / API / VOICE_DM / SELF channels
 * where the agent always responds — `shouldRespond` is implicit RESPOND so we
 * drop it from the schema to save tokens and avoid spurious IGNORE.
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
	"Stage 1 — pick how to handle this turn. Call exactly once per inbound message before any PLAN_ACTIONS calls. Set shouldRespond to RESPOND/IGNORE/STOP. Always write replyText (the user-facing reply). List contexts to engage (directly after replyText); set requiresTool=true when tools/actions/providers/subagents, filesystem/runtime inspection, live/current/external data, side effects, long-running work, or verification are needed. For trivial replies set contexts=['simple'] (replyText is the whole answer). Optionally include action-retrieval hints in candidateActions / parentActionHints / contextSlices and populate `extract` with durable facts/relationships from the message.";

const HANDLE_RESPONSE_DIRECT_DESCRIPTION =
	"Stage 1 (direct-message channel) — pick how to handle this turn. Call exactly once per inbound message before any PLAN_ACTIONS calls. shouldRespond is implicit RESPOND for DMs. Always write replyText (the user-facing reply). List contexts to engage (directly after replyText); set requiresTool=true when tools/actions/providers/subagents, filesystem/runtime inspection, live/current/external data, side effects, long-running work, or verification are needed. For trivial replies set contexts=['simple'] (replyText is the whole answer). Optionally include action-retrieval hints in candidateActions / parentActionHints / contextSlices and populate `extract` with durable facts/relationships from the message.";

const PLAN_ACTIONS_DESCRIPTION =
	"Stage 2 — invoke an action by name with parameters. Use multiple times in sequence to build up a turn's work. Action names and parameter schemas are listed under available_actions in the conversation; the system prompt only describes the protocol. Use exactly the parameter names from that action schema; for routed actions the selector is usually `action` inside `parameters`. Use REPLY to emit a user-facing reply; IGNORE / STOP to terminate the turn.";

/**
 * Build the Stage 1 tool definition. Pass `directMessage: true` for DM /
 * API / VOICE_DM / SELF channels to drop the explicit RESPOND/IGNORE/STOP
 * flag (the agent always responds in those channels).
 */
export function createHandleResponseTool(options?: {
	directMessage?: boolean;
}): ToolDefinition {
	return {
		name: HANDLE_RESPONSE_TOOL_NAME,
		description: options?.directMessage
			? HANDLE_RESPONSE_DIRECT_DESCRIPTION
			: HANDLE_RESPONSE_DESCRIPTION,
		type: "function",
		strict: true,
		parameters: options?.directMessage
			? HANDLE_RESPONSE_DIRECT_SCHEMA
			: HANDLE_RESPONSE_SCHEMA,
	};
}

/**
 * Stage 1 tool. The model uses this once per inbound message to declare
 * how it wants to handle the turn. Output drives the rest of the pipeline:
 *
 *   shouldRespond = "RESPOND" → engage `contexts`, run planner with PLAN_ACTIONS
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
 * Stage 2 tool. The model uses this to invoke an action with parameters.
 * Action names + their parameter schemas
 * live in the available_actions block of the conversation, NOT in the
 * static system prompt — the system prompt only describes the protocol.
 *
 * The dispatcher in planner-loop unwraps `PLAN_ACTIONS` calls at the parse
 * boundary so all downstream logic (context-event lookup, trajectory
 * recording, REPLY/IGNORE/STOP terminal sentinels) sees the actual action
 * name.
 */
export const PLAN_ACTIONS_TOOL: ToolDefinition = {
	name: PLAN_ACTIONS_TOOL_NAME,
	description: PLAN_ACTIONS_DESCRIPTION,
	type: "function",
	strict: true,
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: {
				type: "string",
				description:
					"Action name to invoke. Must match one of the names listed under available_actions in the conversation. Use REPLY for terminal user-facing replies; IGNORE / STOP to terminate the turn.",
			},
			parameters: {
				type: "object",
				description:
					"Action-shaped parameters object. Shape depends on the action; use only parameter names listed in that action's available_actions schema.",
				additionalProperties: true,
			},
			thought: {
				type: "string",
				description: "Short reasoning trace, recorded to the trajectory.",
			},
		},
		required: ["action", "parameters", "thought"],
	},
};

/**
 * The fixed Stage 2 wrapper tool array sent to the LLM on every planner request.
 * Reference this directly when constructing a request — never build a
 * per-turn tool list, which would defeat tool-block caching.
 */
export const STABLE_PLANNER_TOOLS: ReadonlyArray<ToolDefinition> = [
	PLAN_ACTIONS_TOOL,
];

/**
 * Build a per-action tool definition. Used internally to render an action's
 * parameter schema into the conversation's available-actions block — NOT
 * passed to the LLM as a tool. The LLM only sees {@link STABLE_PLANNER_TOOLS}.
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
