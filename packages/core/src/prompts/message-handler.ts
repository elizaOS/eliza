import {
	createHandleResponseTool,
	HANDLE_RESPONSE_DIRECT_SCHEMA,
	HANDLE_RESPONSE_EXTRACT_SCHEMA,
	HANDLE_RESPONSE_SCHEMA,
	HANDLE_RESPONSE_TOOL_NAME,
} from "../actions/to-tool";
import type { JSONSchema, ToolDefinition } from "../types/model";

/**
 * Stage 1 tool name. Re-exported here so prompts and template strings can
 * use the canonical constant without pulling in the full action surface.
 */
export const V5_MESSAGE_HANDLER_TOOL_NAME = HANDLE_RESPONSE_TOOL_NAME;

export const v5MessageHandlerTemplate = `task: Decide processMessage and the plan for this message.

context:
{{contextObject}}

available_contexts:
{{availableContexts}}

rules:
- choose processMessage=RESPOND only when the agent should answer or perform work for this message
- choose processMessage=IGNORE when the message should be ignored
- choose processMessage=STOP when the user asks the agent to stop or disengage
- plan.contexts is a list of context ids drawn from available_contexts, such as calendar or email
- never invent context ids that are not in available_contexts
- choose plan.contexts=["simple"] (and only "simple") when ALL of the following are true:
    * the message is purely conversational, a greeting, or a factual question the agent can answer from training alone
    * no external data, system state, person, document, file, schedule, calendar, email, memory, or provider is mentioned or implied
    * no action verbs like search, find, get, fetch, save, send, create, update, delete, run, execute, or call are present
    * the answer would not meaningfully change if checked against up-to-date information, world state, or memory
    * when uncertain: prefer planning over simple
- never choose "simple" if the message names a person, place, file, document, or data source; asks about schedules or past interactions ("what did I say earlier", "what's on my calendar", "how many X"); or would benefit from any tool call even if the agent could fabricate a plausible answer
- never choose "simple" for owner life-management requests to start, track, list, create, change, or review todos, habits, routines, goals, reminders, alarms, check-ins, blocks, calls, travel bookings, device delivery, desktop actions, or approvals; route to the relevant context so the owning action can ask any missing-detail follow-up
- do not choose "simple" for requests to change, persist, update, or remember agent/user settings, preferences, identity, persona, character, response style, or future behavior; select settings and any other relevant context instead
- named-person relationship cadence requests ("follow up with David", "last talked to Alice", "how long since I spoke with Sam") must include contacts when available; one-off dated reminders or todos to call/text someone must include tasks when available
- explicit phone/call/dial requests to a third party must include phone and contacts when available. Do not include calendar solely because the call is about an appointment or rescheduling; the requested operation is the call
- device-targeted or broadcast reminders ("to my phone", "to mobile", "all devices", "broadcast") must include automation and connectors when available; tasks can be included as secondary context
- desktop, native-app, browser, Finder, window, or computer screenshots/control requests must include browser or automation when available; do not route desktop screenshots to media alone
- LifeOps browser, browser bridge, browser companion, browser extension, browser tab, or browser settings requests must include browser; include settings or connectors as secondary contexts when the user asks for configuration/connection state
- otherwise list every relevant context id; planning will run and tools will be selected from those contexts
- include plan.reply only on the simple shortcut path (plan.contexts=["simple"])
- thought is internal routing rationale and is not shown to the user
- extract is OPTIONAL. Populate it ONLY when the user's message states a durable fact about the user, a person they know, or a relationship between two entities. Examples worth extracting: "my birthday is March 5", "Alice is my manager", "I live in Brooklyn". Do NOT extract: questions, requests, ephemeral state, agent self-talk, or anything already obvious from the agent persona.
- extract.facts entries are short factual statements in the user's voice ("the user's birthday is 1990-03-05"). Keep each entry under ~120 chars and self-contained.
- extract.relationships entries are subject-predicate-object triples where subject and object are short entity names ("user", "Alice", "Acme Corp") and predicate is a snake_case relation ("works_with", "lives_in", "manages").
- omit extract entirely when nothing durable was stated. Do not invent facts to fill it.
- call ${HANDLE_RESPONSE_TOOL_NAME} exactly once with the plan
- do not answer in plain text

return:
Use the ${HANDLE_RESPONSE_TOOL_NAME} tool. Do not return JSON as message text.`;

export const V5_MESSAGE_HANDLER_TEMPLATE = v5MessageHandlerTemplate;

/**
 * Re-exported for downstream callers that need the raw schemas (e.g.
 * trajectory replay validators). New code should reach for the schemas
 * via `actions/to-tool.ts` directly.
 */
export const v5MessageHandlerExtractSchema: JSONSchema =
	HANDLE_RESPONSE_EXTRACT_SCHEMA;

export const v5MessageHandlerSchema: JSONSchema = HANDLE_RESPONSE_SCHEMA;

export const V5_MESSAGE_HANDLER_SCHEMA = v5MessageHandlerSchema;

export const v5DirectMessageHandlerSchema: JSONSchema =
	HANDLE_RESPONSE_DIRECT_SCHEMA;

export const V5_DIRECT_MESSAGE_HANDLER_SCHEMA = v5DirectMessageHandlerSchema;

/**
 * Build the Stage 1 tool definition. Thin wrapper around
 * {@link createHandleResponseTool} kept for backward compatibility with
 * existing call sites.
 */
export function createV5MessageHandlerTool(options?: {
	directMessage?: boolean;
}): ToolDefinition {
	return createHandleResponseTool(options);
}
