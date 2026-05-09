import type { JSONSchema } from "../types/model";

export const v5PlannerTemplate = `task: Plan next native tool calls.

rules:
- use only tools from the tools array; smallest grounded queue
- arguments grounded in user request or prior tool results
- respect each tool's parameter schema; array params must be JSON arrays, not comma-separated strings
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

domain routing (when the action is available):
- live LifeOps status (todos, tasks, reminders, habits, routines, goals, alarms, "what's on my list today") -> LIFE; do not answer from provider summaries
- inbox respond/reply -> MESSAGE operation=triage first; never draft for newsletters/digests/promotional/list mail; prefer operation=respond when user asked to respond/send; include concrete body grounded in source message, no "please provide reply content" placeholders
- explicit call/phone/dial a person/business -> VOICE_CALL first (calendar/email secondary)
- relationship cadence ("follow up with David", "how long since I talked to X") -> RELATIONSHIP; one-off dated reminders to call/text ("remember to call mom Sunday") -> LIFE
- morning/night/daily check-in -> CHECKIN; never invent AUTOMATION_RUN
- broadcast/device-targeted reminders ("to my phone", "all devices") -> DEVICE_INTENT, not LIFE or REPLY
- owner-scoped outbound Telegram/Signal/Discord/email/SMS/iMessage/DM -> MESSAGE operation=send_draft; use operation=send only if draft workflow unavailable
- durable owner facts, reusable preferences, travel/booking preferences -> PROFILE; not extraction/memory/REPLY
- X/Twitter DMs -> MESSAGE source=x; X timeline/feed/mentions/post search -> POST source=x; never invent X/SOCIAL_POSTING/WEB_SEARCH/SEARCH_WEB
- login/password/form field fill -> AUTOFILL; PASSWORD_MANAGER only for credential search/list/copy/inject
- real flight/hotel/trip booking -> BOOK_TRAVEL; no browse-first or web-search-first
- Calendly availability + single-use booking links -> CALENDAR; never WEB_GET/WEB_SEARCH/BROWSER for Calendly URLs
- health/wearable reads ("step count", "sleep last night") -> HEALTH; no summaries/REPLY
- LifeOps browser bridge settings + companion connection state -> MANAGE_BROWSER_BRIDGE refresh; extension setup/open -> install/open_manager; BROWSER is only for tab/page operations
- desktop/computer/native-app screenshots or control -> COMPUTER_USE; never invent takeScreenshot

context_object:
{{contextObject}}

trajectory:
{{trajectory}}`;

export const V5_PLANNER_TEMPLATE = v5PlannerTemplate;

export const v5PlannerSchema: JSONSchema = {
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

export const V5_PLANNER_SCHEMA = v5PlannerSchema;
