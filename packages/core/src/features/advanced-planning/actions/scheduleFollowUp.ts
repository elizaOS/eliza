import { getPromptReferenceDate } from "../../../deterministic";
import { findEntityByName } from "../../../entities.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import type { FollowUpService } from "../../../services/followUp.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { asUUID, ModelType } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import {
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";
import {
	extractScheduleFollowUpResponseFromText,
	type ParsedScheduleFollowUpResponse,
} from "../../shared/schedule-follow-up-response.ts";

const FOLLOW_UP_KEYWORDS = getValidationKeywordTerms(
	"action.scheduleFollowUp.request",
	{
		includeAllLocales: true,
	},
);

function normalizePriority(
	rawPriority: string | undefined,
): "high" | "medium" | "low" {
	const normalized = rawPriority?.trim().toLowerCase();
	if (
		normalized === "high" ||
		normalized === "medium" ||
		normalized === "low"
	) {
		return normalized;
	}
	return "medium";
}

function scheduleFollowUpFailureResult(
	message: string,
	extraData: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text: message,
		error: message,
		data: {
			actionName: "SCHEDULE_FOLLOW_UP",
			...extraData,
		},
	};
}

const scheduleFollowUpTemplate = `# Schedule Follow-up

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the follow-up scheduling information from the message:
1. Who to follow up with (name or entity reference)
2. When to follow up (date/time or relative time like "tomorrow", "next week")
3. Reason for the follow-up
4. Priority (high, medium, low)
5. Any specific message or notes

## Current Date/Time
{{currentDateTime}}

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the JSON response without any preamble or explanation.

## Response Format
{
  "contactName": "Name of the contact to follow up with",
  "entityId": "ID if known, otherwise empty string",
  "scheduledAt": "ISO datetime for the follow-up",
  "reason": "Reason for the follow-up",
  "priority": "high, medium, or low",
  "message": "Optional message or notes for the follow-up"
}

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

export const scheduleFollowUpAction: Action = {
	name: "SCHEDULE_FOLLOW_UP",
	contexts: ["tasks", "contacts", "calendar", "automation"],
	roleGate: { minRole: "ADMIN" },
	description: "Schedule a follow-up reminder for a contact",
	suppressPostActionContinuation: true,
	similes: [
		"follow up with",
		"remind me to contact",
		"schedule a check-in",
		"set a reminder for",
		"follow up on",
		"check back with",
		"reach out to",
		"schedule follow-up",
		"remind me about",
	],
	parameters: [
		{
			name: "contactName",
			description: "Name of the contact to follow up with.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "entityId",
			description: "Known entity ID for the contact.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "scheduledAt",
			description: "Follow-up date/time as an ISO timestamp.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Reason for the follow-up.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "priority",
			description: "Follow-up priority.",
			required: false,
			schema: { type: "string" as const, enum: ["high", "medium", "low"] },
		},
		{
			name: "message",
			description: "Optional message or notes for the follow-up.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Remind me to follow up with John next week about the project",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "I've scheduled a follow-up with John for next week about the project.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Schedule a follow-up with Sarah tomorrow at 2pm" },
			},
			{
				name: "{{name2}}",
				content: {
					text: "I've scheduled a follow-up with Sarah for tomorrow at 2:00 PM.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Follow up with the VIP client in 3 days" },
			},
			{
				name: "{{name2}}",
				content: {
					text: "I've scheduled a follow-up with the VIP client in 3 days.",
				},
			},
		],
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		if (
			runtime.actions.some(
				(action) =>
					action.name === "RELATIONSHIP" || action.name === "RELATIONSHIP",
			)
		) {
			return false;
		}

		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const followUpService = runtime.getService("follow_up") as FollowUpService;

		if (!relationshipsService || !followUpService) {
			logger.warn("[ScheduleFollowUp] Required services not available");
			return false;
		}

		const messageText = message.content.text ?? "";
		return (
			findKeywordTermMatch(messageText, FOLLOW_UP_KEYWORDS) !== undefined ||
			hasActionContextOrKeyword(message, state, {
				contexts: ["tasks", "contacts", "calendar", "automation"],
				keywordKeys: ["action.scheduleFollowUp.request"],
			})
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		const followUpService = runtime.getService("follow_up") as FollowUpService;

		if (!relationshipsService || !followUpService) {
			return scheduleFollowUpFailureResult(
				"I couldn't schedule that follow-up because the required services are unavailable right now.",
				{ errorCode: "services_unavailable" },
			);
		}

		if (!state) {
			state = {
				values: {},
				data: {},
				text: "",
			};
		}

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const parameterMessage = [
			typeof params.contactName === "string"
				? `contactName: ${params.contactName}`
				: "",
			typeof params.entityId === "string"
				? `entityId: ${params.entityId}`
				: "",
			typeof params.scheduledAt === "string"
				? `scheduledAt: ${params.scheduledAt}`
				: "",
			typeof params.reason === "string"
				? `reason: ${params.reason}`
				: "",
			typeof params.priority === "string"
				? `priority: ${params.priority}`
				: "",
			typeof params.message === "string"
				? `message: ${params.message}`
				: "",
		]
			.filter(Boolean)
			.join("\n");

		state.values = {
			...state.values,
			message: parameterMessage || message.content.text,
			senderId: message.entityId,
			senderName: state.values?.senderName || "User",
			currentDateTime: getPromptReferenceDate({
				runtime,
				message,
				state,
				surface: "action:schedule_follow_up",
			}).toISOString(),
		};

		const prompt = composePromptFromState({
			state,
			template: scheduleFollowUpTemplate,
		});

		try {
			const response = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
			});

			const parsedResponse =
				(parseJSONObjectFromText(
					response,
				) as ParsedScheduleFollowUpResponse | null) ??
				extractScheduleFollowUpResponseFromText(response);
			if (
				!parsedResponse ||
				(!parsedResponse.contactName && !parsedResponse.entityId)
			) {
				logger.warn(
					"[ScheduleFollowUp] Failed to parse follow-up information from response",
				);
				return scheduleFollowUpFailureResult(
					"I couldn't extract enough follow-up details from that request.",
					{ errorCode: "parse_failed" },
				);
			}

			let entityId = parsedResponse.entityId
				? asUUID(parsedResponse.entityId)
				: null;

			if (!entityId && parsedResponse.contactName) {
				const entity = await findEntityByName(runtime, message, state);

				if (entity?.id) {
					entityId = entity.id;
				} else {
					return scheduleFollowUpFailureResult(
						`I couldn't find ${parsedResponse.contactName} in your relationships yet.`,
						{
							errorCode: "contact_not_found",
							contactName: parsedResponse.contactName,
						},
					);
				}
			}

			if (!entityId) {
				return scheduleFollowUpFailureResult(
					"I couldn't determine who the follow-up should be for.",
					{ errorCode: "missing_contact" },
				);
			}

			const contact = await relationshipsService.getContact(entityId);
			if (!contact) {
				return scheduleFollowUpFailureResult(
					"That contact isn't available in relationships yet. Add them first, then try again.",
					{ errorCode: "relationship_missing", contactId: entityId },
				);
			}

			const scheduledAt = new Date(parsedResponse.scheduledAt || "");
			if (Number.isNaN(scheduledAt.getTime())) {
				return scheduleFollowUpFailureResult(
					"I couldn't determine a valid follow-up date or time from that request.",
					{
						errorCode: "invalid_datetime",
						scheduledAt: parsedResponse.scheduledAt || "",
					},
				);
			}

			const task = await followUpService.scheduleFollowUp(
				entityId,
				scheduledAt,
				parsedResponse.reason || "Follow-up",
				normalizePriority(parsedResponse.priority),
				parsedResponse.message,
			);

			logger.info(
				`[ScheduleFollowUp] Scheduled follow-up for ${parsedResponse.contactName} at ${scheduledAt.toISOString()}`,
			);

			const responseText = `I've scheduled a follow-up with ${parsedResponse.contactName} for ${scheduledAt.toLocaleString()}. ${
				parsedResponse.reason ? `Reason: ${parsedResponse.reason}` : ""
			}`;

			if (callback) {
				await callback({
					text: responseText,
					action: "SCHEDULE_FOLLOW_UP",
					metadata: {
						contactId: entityId,
						contactName: parsedResponse.contactName,
						scheduledAt: scheduledAt.toISOString(),
						taskId: task.id,
						success: true,
					},
				});
			}

			return {
				success: true,
				values: {
					contactId: entityId,
					taskId: task.id ?? "",
				},
				data: {
					actionName: "SCHEDULE_FOLLOW_UP",
					contactId: entityId,
					contactName: parsedResponse.contactName ?? "",
					scheduledAt: scheduledAt.toISOString(),
					taskId: task.id ?? "",
					reason: parsedResponse.reason ?? "",
					priority: parsedResponse.priority ?? "medium",
				},
				text: responseText,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: "Failed to schedule follow-up.";
			logger.error(
				error instanceof Error ? error : { error },
				"[ScheduleFollowUp] Unexpected scheduling failure",
			);
			return scheduleFollowUpFailureResult(
				"I couldn't schedule that follow-up right now.",
				{ errorCode: "schedule_failed", errorMessage },
			);
		}
	},
};
