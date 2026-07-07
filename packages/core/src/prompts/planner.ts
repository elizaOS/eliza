/**
 * Prompt template and output JSON schema for the planner, which turns the user
 * request and prior tool results into the smallest grounded queue of native
 * tool calls (or a user-visible message when no tool fits). Feeds the
 * planner-loop stage of the message loop. The schema keeps `args` a permissive
 * object — strict-grammar providers reject an empty `properties` shape — and
 * carries an optional `completed` signal the post-tool gate uses to decide
 * whether to fall through to a full evaluator pass.
 */
import type { JSONSchema } from "../types/model";

export const plannerTemplate = `task: Plan next native tool calls.

rules:
- use only tools array; smallest grounded queue
- routed action: set parameters.action only if schema has it
- args grounded in user request or prior tool results
- obey schema; arrays as JSON arrays, not comma strings
- no empty strings/placeholders/invented required args; gather via grounded tool or no tool
- matching tool exists => call it, even missing details; handler owns questions/drafts/confirm/refusal
- Owner life-management side effects MUST call the matching exposed tool before any terminal answer: calendar creates/updates/conflict checks -> CALENDAR; reminders/alarms/todos/routines/goals/scheduled tasks -> OWNER_REMINDERS/OWNER_ALARMS/OWNER_TODOS/OWNER_ROUTINES/OWNER_GOALS/SCHEDULED_TASKS. A tool-owned conflict, clarification, preview, confirmation request, or fail-closed no-op is still a tool result, not bare messageToUser.
- no messageToUser follow-up when matching tool exists
- messageToUser alone cannot save, schedule, send, update, remember, or complete anything; if a tool can do the side effect, call it
- never say "saved", "logged", "scheduled", "sent", "updated", or "done" unless a tool result this turn proves it
- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, arbitrary JSON/tool attempts, "call MESSAGE"
- to call a tool, return exactly {"action":"TOOL_NAME","parameters":{...},"thought":"short reason"} or native toolCalls; never prose
- owner goal save/create/update/review when OWNER_GOALS is exposed => return {"action":"OWNER_GOALS","parameters":{"action":"create|update|review","intent":"...","title":"...","confirmed":true|false,"details":{"description":"...","successCriteria":{"summary":"..."},"supportStrategy":{"summary":"..."} } },"thought":"..."} rather than messageToUser
- Structured chat markers are allowed in messageToUser when they are the actual user-visible interaction payload: [FORM]\\n{json}\\n[/FORM], [CHOICE:scope id=id]\\nvalue=Label\\n[/CHOICE], [FOLLOWUPS id=id]\\nvalue=Label\\n[/FOLLOWUPS], or [TASK:threadId]Title[/TASK]. The JSON inside [FORM] is form data, not a tool attempt; keep JSON inside the marker and do not emit unrelated JSON.
- more tool work => native toolCalls only; never narrate/simulate calls
- partial after tool result => next grounded tool, not messageToUser
- tool-required router decision => run at least one exposed non-terminal tool before terminal answer
- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try
- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool
- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"
- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. When the user wants chat-message search/recall, memory queries, or agent-history lookups and no dedicated search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search — set messageToUser explaining that the capability is not available this turn.
- candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. Either an exposed tool genuinely resolves the user's intent (call it), or no tool fits (set messageToUser). Never emit echo-placeholder SHELL commands such as: echo "<intent-name>" / echo "placeholder for <ACTION>" / echo "search <X>" as a way to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.
- TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, building/deploying apps, running tests, opening PRs). It is not a fallback for chat-message recall, memory queries, or agent-history lookups. Spawning a coding sub-agent to "search the Discord channel for messages mentioning X" routinely ends in sub-agent error/timeout and a generic "Sorry, something went wrong" reply to the user. When the user wants chat-message recall and no dedicated search action is exposed, set messageToUser explaining the capability is not available — do not spawn a sub-agent for it.
- A one-shot live/current/public-data lookup — current price, weather, score, news headline, a status, or a value at a known URL — is NOT coding work: call WEB_FETCH (construct the single URL yourself) or WEB_SEARCH directly and answer from the result. Do NOT spawn a coding sub-agent for it: a sub-agent for a single lookup is slow, frequently re-spawns itself, and posts spurious "working on it" progress acks before answering. Spawn only when the task is genuinely build/code/repo/multi-step work.
- no tool fits or task complete => no toolCalls, set messageToUser
- set completed=false when this turn's tool calls do not yet achieve the goal (read-then-act, multi-step deploy/build, verification pending); completed=true only when the goal is achieved this turn. omit when unknown.
- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen — "I'm fetching X, please hold", "Let me look that up", "Pulling up the info", "Searching for the answer", "I'm checking now", "I'll get back to you", "Spawning a sub-agent", "I'm working on it", "I'm fixing that now", "Let me get that done", "Wrapping it up", "Almost done", "Building it now", "I'll start on that" — when no tool call this turn is in flight to produce that content. A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call (e.g. TASKS_SPAWN_AGENT) is actually in flight THIS turn; if you did not spawn a sub-agent or take an action this turn, do not say the task is underway. The planner does not run in the background after returning; once this turn ends, no further tool work happens unless a NEW user message arrives. If your tool iterations exhausted without a usable result (search returned nothing, fetch was blocked, scrape gave no usable HTML, RSS was empty), set messageToUser saying so plainly: "I tried web search via the available tools and couldn't find current info on X — try checking a news site directly" or "The searches returned no usable results". Never promise ongoing fetch when this turn is the planner's final iteration. This rule covers every grammatical form for both investigative and task-execution verbs (fetch/search/look up/check AND work on/start/fix/build/wrap up/finish): past-perfect ("I have fetched", "I have started fixing it"), bare past-tense ("I fetched", "I started on it"), present-continuous with subject ("I'm fetching now", "I'm checking", "I'm working on it", "I'm fixing it"), bare present-participle without subject ("Fetching latest info", "Looking it up", "Working on it", "Wrapping it up"), and "please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases.
- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not actually occur this turn. Do not claim something "glitched", "hiccuped", "broke", "went wrong", "snagged", "errored out", "got cut off", "didn't go through", "failed on my end", or invite the user to "give it another go / try that again / ask again" UNLESS a real tool call THIS turn actually returned an error or empty result. If you are choosing NOT to take an action this turn (no tool call in flight), do not invent a malfunction to excuse it: instead either (a) take the correct action (e.g. spawn the coding sub-agent for a build request), or (b) say plainly and truthfully what you can do and ask the user to confirm scope, e.g. "I can build that as a single-file site in its own folder, want me to start?". A fabricated "something glitched, give it another go" is a hallucinated failure and is forbidden when nothing failed. This covers every phrasing of a non-existent error or stall-and-retry invitation.
- When a tool call produced actual output (stdout, fetched content, search results, file listings, command output), the subsequent messageToUser must include that output directly — do not replace it with a meta-summary of what the tool did. Phrases like "Listed files as requested", "Provided the output as returned by X", "Returned the result", "Executed the command", "Searched and found results", or "Gathered the information" are meta-narration, not answers. If the tool already returned user-friendly text (verifiedUserFacing is true), include that text in messageToUser rather than describing the action.

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
