import type { JSONSchema } from "../types/model";

export const plannerTemplate = `task: Plan next native tool calls.

rules:
- use only tools from the tools array; smallest grounded queue
- PLAN_ACTIONS.action must be an exact action name from available_actions; never invent compound names for a requested operation
- for routed actions, put the operation selector in parameters.action only when that parameter exists in the action schema
- arguments grounded in user request or prior tool results
- respect each tool's parameter schema; array params must be JSON arrays, not comma-separated strings
- never use empty strings, placeholders, or invented values for required tool arguments; gather missing content with another grounded tool or choose no tool if no tool can supply it
- when a tool matches the requested operation, call it even if details are missing; the tool/action handler owns follow-up questions, drafts, confirmations, refusal
- do not ask a follow-up via messageToUser when a matching tool exists
- messageToUser is shown directly to user; never put thoughts, analysis, tool names, function syntax, JSON/tool-call attempts, or "call MESSAGE" in it
- if more tool work remains, emit native toolCalls; never narrate or simulate tool calls in text
- after a tool result, if partially complete call the next grounded tool, not messageToUser
- if context includes a tool-required router decision, do not return a terminal answer until at least one exposed non-terminal tool runs for this request
- task is not complete while the user still needs live/current/external data, filesystem/runtime state, command output, repo work, app builds, PR work, deployment, verification, or another side effect and a relevant exposed tool can attempt it
- prior attachments, memory, or conversation snippets are not a substitute for an explicit current request to run/check/fetch/inspect/build/deploy/verify/look up now; call the relevant exposed tool
- when a relevant exposed tool can attempt the needed work, call it instead of replying "I cannot browse/search/run/inspect/build/deploy/verify"
- if no tool fits or task is complete, return no toolCalls and set messageToUser

When the context includes a "# Routing hints" section, follow those hints — each line names which action handles a specific kind of request. Hints are sourced from the action's own routingHint metadata, so the list reflects only actions actually exposed for this turn.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const plannerSchema: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		thought: { type: "string" },
		toolCalls: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					name: { type: "string" },
					// Tool args are arbitrary per-tool. Permissive object schema —
					// no `additionalProperties: false`, no empty `properties: {}`.
					// Strict-grammar providers (Cerebras, etc.) reject the empty
					// shape with `Object fields require at least one of:
					// 'properties' or 'anyOf' with a list of possible properties`.
					args: { type: "object" },
				},
				required: ["name"],
			},
		},
		messageToUser: { type: "string" },
	},
	required: ["thought", "toolCalls"],
};

export const v5PlannerTemplate = plannerTemplate;
export const v5PlannerSchema = plannerSchema;
