import type { JSONSchema } from "../types/model";

export const plannerTemplate = `task: Plan next native tool calls.

rules:
- use only tools array; smallest grounded queue
- routed action: set parameters.action only if schema has it
- args grounded in user request or prior tool results
- obey schema; arrays as JSON arrays, not comma strings
- no empty strings/placeholders/invented required args; gather via grounded tool or no tool
- matching tool exists => call it, even missing details; handler owns questions/drafts/confirm/refusal
- no messageToUser follow-up when matching tool exists
- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, JSON/tool attempts, "call MESSAGE"
- more tool work => native toolCalls only; never narrate/simulate calls
- partial after tool result => next grounded tool, not messageToUser
- tool-required router decision => run at least one exposed non-terminal tool before terminal answer
- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try
- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool
- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"
- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. When the user wants chat-message search/recall and no dedicated search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search — set messageToUser explaining that the capability is not available this turn.
- candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. Either an exposed tool genuinely resolves the user's intent (call it), or no tool fits (set messageToUser). Never emit echo-placeholder SHELL commands such as: echo "<intent-name>" / echo "placeholder for <ACTION>" / echo "search <X>" as a way to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.
- TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, building/deploying apps, running tests, opening PRs). It is not a fallback for chat-message recall, memory queries, or agent-history lookups. Spawning a coding sub-agent to "search the Discord channel for messages mentioning X" routinely ends in sub-agent error/timeout and a generic "Sorry, something went wrong" reply to the user. When the user wants chat-message recall and no dedicated search action is exposed, set messageToUser explaining the capability is not available — do not spawn a sub-agent for it.
- no tool fits or task complete => no toolCalls, set messageToUser
- set completed=false when this turn's tool calls do not yet achieve the goal (read-then-act, multi-step deploy/build, verification pending); completed=true only when the goal is achieved this turn. omit when unknown.

If context has "# Routing hints", follow them. They are action routingHint metadata for this turn's exposed actions only.

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
		// Optional explicit completion signal. When the planner emits
		// `completed: false`, the post-tool gate (`tryGateEvaluator`) MUST
		// fall through to the full evaluator regardless of `messageToUser`,
		// because the planner itself is signaling that the goal is not yet
		// achieved this turn (read-then-act, multi-step deploy/build,
		// verification pending). Omitting the field preserves the original
		// PR #7514 cost optimization for callers that don't care.
		completed: { type: "boolean" },
	},
	required: ["thought", "toolCalls"],
};
