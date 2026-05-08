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
- owner-scoped outbound Telegram/Signal/Discord/email/SMS/iMessage/DM requests belong to MESSAGE operation=send_draft when available; do not use MESSAGE operation=send for direct sends unless the draft workflow is unavailable
- filling a login/password/form field on a site belongs to AUTOFILL when available; use PASSWORD_MANAGER only for credential search/list/copy/inject requests
- LifeOps browser settings, browser bridge settings, and companion connection state belong to MANAGE_BROWSER_BRIDGE refresh when available; browser extension setup/open chrome extensions belongs to MANAGE_BROWSER_BRIDGE install/open_manager; use BROWSER for tab/page operations, not bridge configuration
- screenshots or control of the desktop/computer/native apps belong to COMPUTER_USE when available; do not invent helper names such as takeScreenshot
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
