/**
 * Prompt template and output JSON schema for the planner, which turns the user
 * request and prior tool results into the smallest grounded queue of native
 * tool calls (or a user-visible message when no tool fits). Feeds the
 * planner-loop stage of the message loop. The schema keeps `args` a permissive
 * object — strict-grammar providers reject an empty `properties` shape — and
 * carries an optional `completed` signal the post-tool gate uses to decide
 * whether to fall through to a full evaluator pass. Native function-calling
 * envelopes cannot carry that top-level field, so every exposed tool schema
 * additionally accepts the reserved `eliza_turn_scope` argument (#17034),
 * which the loop folds into the same completion signal and strips before
 * dispatch.
 */
import type { JSONSchema } from "../types/model";

export const plannerBatchScopeDescription =
	'"final" means every tool call this turn needs is in this queue; results need not be known yet, the evaluator verifies them and writes the answer. "more_work_pending" means a LATER tool call in this turn must read these results first (e.g. read an ID before updating). Use "final" whenever the only thing left after these calls is answering the user: the reply is never a reason for "more_work_pending".';

/*
 * Incident log behind the planner rules (kept out of the prompt text; the rule
 * statements below carry the behaviour and runtime/__tests__/planner-loop.test.ts
 * pins the phrasing; MANDATORY_PLANNER_POLICY in runtime/planner-loop.ts mirrors
 * the sentinel rules for optimized templates that lack them):
 * - elizaOS/eliza#7935: Stage 1 hinted candidateActions=["SEARCH_MESSAGES"] with no
 *   such action registered; the planner burned iterations on `echo "placeholder for
 *   ..."` and shell greps -> SHELL-fallback and dead-hint rules.
 * - Coding sub-agents spawned to "search the Discord channel for messages mentioning
 *   X" ended in sub-agent error/timeout and a generic "Sorry, something went wrong"
 *   reply -> TASKS_SPAWN_AGENT scope rule.
 * - A sub-agent spawned for a single price/weather/URL lookup was slow, re-spawned
 *   itself and posted "working on it" acks before answering -> one-shot lookup rule.
 * - 2026-05-26: after four blocked SHELL curl iterations the REPLY said "I'm fetching
 *   the latest info... Please hold" with nothing in flight; 2026-06-28 (multi-bot
 *   arena): "wrapping the runtime-identity fix" with zero TASKS_SPAWN_AGENT calls
 *   -> in-flight claim rule (investigative AND task-execution verbs, every
 *   grammatical form, stalling phrases).
 * - "Something glitched, give it another go" used to dodge a build request when no
 *   tool had failed -> fabricated-failure rule.
 * - Tool output replaced by "Listed files as requested" / "Provided the output as
 *   returned by X" meta-narration -> tool-output rule.
 * - A pre-tool ack ("I'm connecting your calendar.") became the terminal reply after
 *   the CONNECT tool drained the queue, dropping the OAuth link -> pre-tool bubble
 *   rule (planner-loop.test.ts pins the inversion).
 */
export const plannerTemplate = `task: Plan next native tool calls.

rules:
- use only the tools array; smallest grounded queue covering every explicit requested outcome. Navigation is a separate outcome from reading, searching, or changing data (a background web search does not open the user's browser): queue both when both are asked; never demote navigation to a detail of the "main" task or silently drop a clause because a routing hint omits it.
- routed action: set parameters.action only if schema has it
- args grounded in user request or prior tool results; obey schema; arrays as JSON arrays, not comma strings
- no empty strings/placeholders/invented required args; gather via grounded tool or no tool
- native toolCalls: pass each argument as a direct field in that tool's args object exactly as its schema declares; never nest arguments under \`parameters\` unless the tool schema itself declares a \`parameters\` field
- plain-JSON fallback only (when native tool calls are unavailable): return exactly {"action":"TOOL_NAME","parameters":{...},"thought":"short reason"}; never put that envelope inside a native tool's args
- Batch scope: ${plannerBatchScopeDescription}
- native toolCalls: every tool requires the reserved arg \`eliza_turn_scope\` (stripped before execution); use the same batch scope on every call. In plain-JSON fallback, completed=true means "final", completed=false means "more_work_pending"; omit only when unknown. Neither form skips result verification.
- matching tool exists => call it, even with missing details (the handler owns questions/drafts/confirm/refusal); never answer with messageToUser instead of the call or add a messageToUser follow-up beside it. messageToUser alone cannot save, schedule, send, update, remember, or complete anything: if a tool can do the side effect, call it, and never say "saved", "logged", "scheduled", "sent", "updated", or "done" unless a tool result this turn proves it
- Owner life-management side effects (calendar events, reminders, alarms, todos, routines, goals, scheduled/recurring tasks) MUST call the matching exposed life-management/scheduling tool before any terminal answer, matched by the exposed tools' names, routing hints, and descriptions (e.g. CALENDAR; OWNER_REMINDERS, SCHEDULED_TASKS, or TRIGGER_CREATE for reminders — whichever is exposed this turn). Never declare the capability missing because a specific name above is absent: an exposed tool whose hint/description covers the intent IS the capability. A tool-owned conflict, clarification, preview, confirmation request, or fail-closed no-op is still a tool result, not bare messageToUser.
- owner goal save/create/update/review when OWNER_GOALS is exposed => native OWNER_GOALS args {"action":"create|update|review","intent":"...","title":"...","confirmed":true|false,"details":{"description":"...","successCriteria":{"summary":"..."},"supportStrategy":{"summary":"..."}}}; the {"action":"OWNER_GOALS","parameters":{...}} envelope exists only in the plain-JSON fallback; never messageToUser
- more tool work, or a partial result after a tool => the next grounded native toolCall; never narrate/simulate calls or fall back to messageToUser
- tool-required router decision => run at least one exposed non-terminal tool before terminal answer
- incomplete while user needs live/current/external data, filesystem/runtime state, command output, repo work, build, PR, deploy, verify, side effect, and exposed tool can try
- attachments/memory/snippets do not replace explicit current run/check/fetch/inspect/build/deploy/verify/look up now; call tool
- exposed tool can try => call it; do not say "I cannot browse/search/run/inspect/build/deploy/verify"
- candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. A dead hint does NOT mean the capability is missing: scan the exposed tools' names, routing hints, and descriptions for one covering the same intent (e.g. reminders -> TRIGGER_CREATE when OWNER_REMINDERS is not exposed) and call it; set messageToUser only when nothing fits. Never emit echo-placeholder SHELL commands (echo "placeholder for <ACTION>") to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.
- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, builds/deploys, tests, PRs) and is likewise not a fallback for chat-message recall, memory queries, or agent-history lookups (a sub-agent sent to search a chat channel routinely ends in sub-agent error/timeout). When the user wants chat-message recall and no dedicated search action (e.g. SEARCH_MESSAGES, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search, and do not spawn a sub-agent — set messageToUser explaining that the capability is not available this turn.
- A one-shot live/current/public-data lookup (price, weather, score, headline, a value at a known URL) is NOT coding work: call WEB_FETCH (construct the single URL yourself) or WEB_SEARCH directly and answer from the result; spawn a coding sub-agent only for genuine build/code/repo/multi-step work (for a single lookup it is slow, re-spawns itself, and posts spurious progress acks).
- no tool fits or task complete => no toolCalls, set messageToUser
- messageToUser is user-visible only; no thoughts, analysis, tool names, function syntax, arbitrary JSON/tool attempts, "call MESSAGE"
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.
- Structured chat markers are allowed in messageToUser when they are the actual user-visible interaction payload: [FORM]\\n{json}\\n[/FORM], [CHOICE:scope id=id]\\nvalue=Label\\n[/CHOICE], [FOLLOWUPS id=id]\\nvalue=Label\\n[/FOLLOWUPS], or [TASK:threadId]Title[/TASK]. The JSON inside [FORM] is form data, not a tool attempt; keep JSON inside the marker and do not emit unrelated JSON.
- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen ("I'm fetching X, please hold", "I'm working on it") unless a tool call THIS turn is in flight to produce it. A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call (e.g. TASKS_SPAWN_AGENT) is in flight this turn. The planner does not run in the background after returning; no further tool work happens until a NEW user message arrives, so never promise an ongoing fetch on the final iteration — when the iterations ended without a usable result (nothing found, fetch blocked), set messageToUser saying so plainly ("I couldn't find current info on X via the available tools"). The ban covers every grammatical form of both verb families ("I have fetched", "Looking it up") and "please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases.
- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not occur this turn ("something glitched, give it another go", "it didn't go through") unless a real tool call THIS turn returned an error or empty result. When you choose not to act (no tool call in flight), do not invent a malfunction: take the correct action (e.g. spawn the coding sub-agent for a build request) or say plainly what you can do and ask the user to confirm scope.
- When a tool call produced actual output (stdout, fetched content, search results, file listings), messageToUser must include that output directly, never a meta-summary of what the tool did ("Listed files as requested", "Executed the command"). If the tool already returned user-friendly text (verifiedUserFacing is true), prefer that text; do not wrap it in a process-status bubble ("on it", "got it") after the tool finished.
- Do not put a pre-tool progress or acknowledgement bubble in messageToUser when you also emit toolCalls: it is not delivered before tools run, and after a successful tool drains the queue the post-tool gate treats an explicit messageToUser as the terminal reply (skipping the evaluator), so a pre-tool ack ("I'm connecting your calendar") can replace the real outcome. Emit toolCalls alone for work in progress; set messageToUser only as a terminal answer or as a grounded post-tool outcome that includes the tool result.

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
		// JSON equivalent of the native batch-scope argument. The post-tool
		// gate must preserve later action work when this is explicitly false.
		completed: {
			type: "boolean",
			description: `${plannerBatchScopeDescription} true means "final"; false means "more_work_pending".`,
		},
	},
	required: ["thought", "toolCalls"],
};
