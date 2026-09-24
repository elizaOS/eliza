/** Authored templates for advanced planning behavior, preserving complete model context. */

export const chooseOptionTemplate = `# Task: Choose an option from available choices.

{{providers}}

# Available Options:
{{options}}

# Instructions:
Select the most appropriate option based on context. Provide reasoning and selected option ID.

JSON shape:
{
  "thought": "Your reasoning for the selection",
  "selected_id": "The ID of the selected option"
}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const CHOOSE_OPTION_TEMPLATE = chooseOptionTemplate;

export const optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{tasks}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Identify which task and option the user is selecting
2. Match against available tasks and options, including ABORT
3. Return task ID (shortened UUID) and option name exactly as listed
4. If no clear selection, return null for both

JSON:
taskId: string_or_null
selectedOption: OPTION_NAME_or_null

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const OPTION_EXTRACTION_TEMPLATE = optionExtractionTemplate;

export const plannerTemplate = `task: Plan next native tool calls for current ContextObject.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- use only tools in current context object
- smallest grounded useful tool queue
- args only from user request or prior tool results
- if an exposed tool can perform the requested side effect, call it; messageToUser alone does not save, schedule, send, update, remember, or complete anything
- matching owner life-management tool exists => call it before terminal answer. Match by the exposed tools' names, routing hints, and descriptions (e.g. CALENDAR for calendar work; OWNER_REMINDERS, SCHEDULED_TASKS, or TRIGGER_CREATE for reminders/scheduling — whichever is exposed this turn); never declare the capability missing because a specific name is absent. A conflict, clarification, preview, confirmation request, or fail-closed no-op belongs in the tool result, not bare messageToUser.
- task already complete from prior tool result or next step truly needs user speech => no toolCalls, set messageToUser
- never say "saved", "logged", "scheduled", "sent", "updated", or "done" unless an actual tool result this turn proves it
- native toolCalls: pass each argument as a direct field in that tool's args object exactly as its schema declares; never nest arguments under \`parameters\` unless the tool schema itself declares a \`parameters\` field
- plain-JSON fallback only (when native tool calls are unavailable): return exactly {"action":"TOOL_NAME","parameters":{...},"thought":"short reason"}; never put that envelope inside a native tool's args
- owner goal save/create/update/review when OWNER_GOALS is exposed => native OWNER_GOALS args are {"action":"create|update|review","intent":"...","title":"...","confirmed":true|false,"details":{"description":"...","successCriteria":{"summary":"..."},"supportStrategy":{"summary":"..."} } }; only the plain-JSON fallback wraps those args in {"action":"OWNER_GOALS","parameters":{...},"thought":"..."}; never use messageToUser
- never invent tool names, connector names, providers, ids, benchmark ids
- messageToUser must read like natural conversation, not a database or debug log. Prefer concise everyday wording. Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times; do not expose internal ids, field names, raw JSON, tool names, receipt metadata, or backend jargon unless the user explicitly asks for raw or technical output. Preserve exact code and user-provided values when they are the subject of the request.

return:
JSON object only. No markdown, prose, XML, or legacy formats.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
`;

export const PLANNER_TEMPLATE = plannerTemplate;
