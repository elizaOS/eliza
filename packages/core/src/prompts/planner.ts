import type { JSONSchema } from "../types/model";

export const v5PlannerTemplate = `task: Plan the next native tool calls.

rules:
- use only tools from the tools array
- plan the smallest grounded queue
- only include arguments grounded in the user request or prior tool results
- respect each tool parameter schema exactly; array parameters must be JSON arrays, not comma-separated strings
- when a tool matches the requested operation, call it even if some details are missing; the tool/action handler owns missing-detail follow-up questions, drafts, confirmations, and safe refusal
- do not ask a follow-up yourself with messageToUser when a matching tool is available
- messageToUser is shown directly to the user; never put thoughts, analysis, tool names, function syntax, JSON/tool-call attempts, or instructions like "call MESSAGE" in it
- if more tool work remains, emit native toolCalls; do not narrate or simulate tool calls in text
- after a tool result, if the user request is only partially complete, call the next grounded tool instead of stopping with messageToUser
- live LifeOps status reads for todos, tasks, reminders, habits, routines, goals, alarms, or "what's on my list today" belong to LIFE when available; do not answer from provider summaries such as open occurrence counts
- requests to respond/reply to messages that need an answer in an inbox belong to MESSAGE operation=triage first when available; use it to identify only needs-reply messages before any MESSAGE operation=respond/draft_reply calls, never draft replies to newsletters, digests, or promotional/list mail, and prefer operation=respond over operation=draft_reply when the user asked to respond/send
- when calling MESSAGE operation=respond or operation=draft_reply, include a concrete body grounded in the source message; never use placeholders such as "please provide reply content" and never call them for newsletters, digests, promotional, archive-only, or skip messages
- if the user explicitly asks to call, phone, or dial a person/business and VOICE_CALL is available, call VOICE_CALL first and do not search calendar/email first; calendar/email details are secondary
- relationship cadence/follow-up management ("follow up with David", "how long since I talked to X") belongs to RELATIONSHIP when available; one-off dated reminders or todos to call/text someone ("remember to call mom on Sunday") belong to LIFE when available
- explicit morning/night/daily check-in requests ("run my morning check-in", "give me my night check-in") belong to CHECKIN when available; do not invent AUTOMATION_RUN or answer from summaries
- broadcast/device-targeted reminders ("broadcast a reminder", "to my phone", "to mobile", "all devices") belong to DEVICE_INTENT when available; do not use LIFE or REPLY for cross-device delivery
- owner-scoped outbound Telegram/Signal/Discord/email/SMS/iMessage/DM requests belong to MESSAGE operation=send_draft when available; do not use MESSAGE operation=send for direct sends unless the draft workflow is unavailable
- durable owner profile facts, reusable preferences, and travel/booking preference memory ("remember I prefer aisle seats", "save my hotel preferences") belong to PROFILE when available; do not rely on extraction, memory side effects, or REPLY
- X/Twitter DMs belong to MESSAGE with source=x when available; X/Twitter timeline, feed, mentions, or post search belong to POST with source=x when available; do not invent X, SOCIAL_POSTING, WEB_SEARCH, or SEARCH_WEB actions for these
- filling a login/password/form field on a site belongs to AUTOFILL when available; use PASSWORD_MANAGER only for credential search/list/copy/inject requests
- real flight/hotel/trip booking requests ("book travel", "book a flight", "reserve a hotel") belong to BOOK_TRAVEL when available; do not browse or web-search first
- Calendly availability and single-use booking link requests belong to CALENDAR when available; do not use WEB_GET, WEB_SEARCH, or BROWSER for Calendly API URLs
- health metrics and wearable reads ("step count", "sleep last night") belong to HEALTH when available; do not answer from summaries or REPLY
- LifeOps browser settings, browser bridge settings, and companion connection state belong to MANAGE_BROWSER_BRIDGE refresh when available; browser extension setup/open chrome extensions belongs to MANAGE_BROWSER_BRIDGE install/open_manager; use BROWSER for tab/page operations, not bridge configuration
- screenshots or control of the desktop/computer/native apps belong to COMPUTER_USE when available; do not invent helper names such as takeScreenshot
- the task is not complete while the user still needs live/current/external data, filesystem/runtime state, command output, repo work, app builds, pull-request work, deployment, verification, or another side effect and a relevant exposed tool can attempt it
- if the current context includes a tool-required router decision or instruction, do not return a terminal answer until after at least one exposed non-terminal tool has run for the current request
- when a relevant exposed tool can attempt the needed work, call that tool instead of replying that the current context cannot browse, search, run commands, inspect, build, deploy, or verify
- prior attachments, memory, or conversation snippets are not a substitute for an explicit current request to run, check, fetch, inspect, build, deploy, verify, or look something up now; use a relevant exposed tool for the current turn
- if no tool fits or the task is complete, return no toolCalls and set messageToUser

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
