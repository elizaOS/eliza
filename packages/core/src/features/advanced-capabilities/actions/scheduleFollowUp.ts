import { findEntityByName } from "../../../entities.ts";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import type { FollowUpService } from "../../../services/followUp.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import type { ParsedScheduleFollowUpResponse } from "../../shared/schedule-follow-up-response.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SCHEDULE_FOLLOW_UP");
const FOLLOW_UP_KEYWORDS = getValidationKeywordTerms(
	"action.scheduleFollowUp.request",
	{
		includeAllLocales: true,
	},
);

const MAX_RESULT_TEXT_LENGTH = 500;
const MAX_ERROR_LENGTH = 240;

function limitText(value: string, maxLength = MAX_RESULT_TEXT_LENGTH): string {
	return value.length > maxLength
		? `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
		: value;
}

function limitError(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return limitText(text, MAX_ERROR_LENGTH);
}

function invalidResult(
	text: string,
	error: string,
	data: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text: limitText(text),
		error,
		values: {
			success: false,
			error,
		},
		data: {
			actionName: "SCHEDULE_FOLLOW_UP",
			error,
			...data,
		},
	};
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFollowUpInput(
	message: Memory,
	options?: HandlerOptions,
): ParsedScheduleFollowUpResponse | null {
	const params = readParams(options);
	const parsed = {
		contactName: readString(params.contactName ?? message.content.contactName),
		entityId: readString(params.entityId ?? message.content.entityId),
		scheduledAt: readString(params.scheduledAt ?? message.content.scheduledAt),
		reason: readString(params.reason ?? message.content.reason),
		priority: readString(params.priority ?? message.content.priority),
		message: readString(params.message ?? message.content.message),
	} satisfies ParsedScheduleFollowUpResponse;
	return parsed.contactName || parsed.entityId || parsed.scheduledAt
		? parsed
		: null;
}

export const scheduleFollowUpAction: Action = {
	name: spec.name,
	contexts: ["tasks", "contacts", "calendar", "automation"],
	roleGate: { minRole: "ADMIN" },
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	examples: (spec.examples ?? []) as ActionExample[][],
	suppressPostActionContinuation: true,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
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

		const params = readFollowUpInput(message, options);
		const scheduledAt = params?.scheduledAt
			? new Date(params.scheduledAt)
			: null;
		if (
			params?.scheduledAt &&
			(params.contactName || params.entityId) &&
			scheduledAt &&
			!Number.isNaN(scheduledAt.getTime())
		) {
			return true;
		}
		if (
			hasActionContextOrKeyword(message, state, {
				contexts: ["tasks", "contacts", "calendar", "automation"],
				keywordKeys: ["action.scheduleFollowUp.request"],
			})
		) {
			return true;
		}

		const messageText = message.content.text ?? "";
		if (!messageText) return false;
		return findKeywordTermMatch(messageText, FOLLOW_UP_KEYWORDS) !== undefined;
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
			return invalidResult(
				"Follow-up scheduling is unavailable right now.",
				"Required services not available",
			);
		}

		try {
			const parsedResponse = readFollowUpInput(message, _options);
			const contactName = parsedResponse?.contactName?.trim();
			if (!parsedResponse || (!contactName && !parsedResponse.entityId)) {
				logger.warn(
					"[ScheduleFollowUp] Failed to parse follow-up information from response",
				);
				return invalidResult(
					"I couldn't determine who this follow-up is for.",
					"Could not extract follow-up information",
				);
			}

			let entityId = parsedResponse.entityId
				? asUUID(parsedResponse.entityId)
				: null;

			if (!entityId && contactName) {
				const contacts = await relationshipsService.searchContacts({
					searchTerm: contactName,
				});
				if (contacts.length > 0) {
					entityId = contacts[0]?.entityId ?? null;
				} else {
					state ??= { values: {}, data: {}, text: "" };
					const entity = await findEntityByName(runtime, message, state);
					if (entity?.id) {
						entityId = entity.id;
					} else {
						return invalidResult(
							`I couldn't find a contact named ${contactName}.`,
							`Contact "${contactName}" not found in relationships`,
							{ contactName },
						);
					}
				}
			}

			if (!entityId) {
				return invalidResult(
					"I couldn't determine which contact to follow up with.",
					"Could not determine contact to follow up with",
				);
			}

			const contact = await relationshipsService.getContact(entityId);
			if (!contact) {
				return invalidResult(
					"I couldn't find that contact in relationships.",
					"Contact not found in relationships. Please add them first.",
					{ contactId: entityId },
				);
			}

			const scheduledAt = new Date(parsedResponse.scheduledAt || "");
			if (Number.isNaN(scheduledAt.getTime())) {
				return invalidResult(
					"I couldn't parse the requested follow-up time.",
					"Invalid follow-up date/time",
				);
			}

			const task = await followUpService.scheduleFollowUp(
				entityId,
				scheduledAt,
				parsedResponse.reason || "Follow-up",
				(parsedResponse.priority as "high" | "medium" | "low") || "medium",
				parsedResponse.message,
			);

			const resolvedContactName = contactName || "contact";
			logger.info(
				`[ScheduleFollowUp] Scheduled follow-up for ${resolvedContactName} at ${scheduledAt.toISOString()}`,
			);

			const responseText = limitText(
				`I've scheduled a follow-up with ${resolvedContactName} for ${scheduledAt.toLocaleString()}. ${
					parsedResponse.reason ? `Reason: ${parsedResponse.reason}` : ""
				}`.trim(),
			);

			if (callback) {
				await callback({
					text: responseText,
					action: "SCHEDULE_FOLLOW_UP",
					metadata: {
						contactId: entityId,
						contactName: resolvedContactName,
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
					contactName: resolvedContactName,
					scheduledAt: scheduledAt.toISOString(),
					taskId: task.id ?? "",
					reason: parsedResponse.reason ?? "",
					priority: parsedResponse.priority ?? "medium",
				},
				text: responseText,
			};
		} catch (error) {
			const errorMessage = limitError(error);
			logger.error("[ScheduleFollowUp] Error:", errorMessage);
			const responseText = "I hit an error while scheduling that follow-up.";
			await callback?.({
				text: responseText,
				error: errorMessage,
				action: "SCHEDULE_FOLLOW_UP",
			});
			return invalidResult(responseText, errorMessage);
		}
	},
	parameters: [
		{
			name: "contactName",
			description: "Name of the contact to follow up with.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "entityId",
			description: "Entity ID of the contact to follow up with, if known.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "scheduledAt",
			description: "ISO date/time for the follow-up.",
			required: true,
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
			schema: {
				type: "string" as const,
				enum: ["high", "medium", "low"],
				default: "medium",
			},
		},
		{
			name: "message",
			description: "Optional follow-up message or reminder text.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};
