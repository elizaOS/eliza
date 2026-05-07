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
import type { ParsedScheduleFollowUpResponse } from "../../shared/schedule-follow-up-response.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SCHEDULE_FOLLOW_UP");
const FOLLOW_UP_KEYWORDS = getValidationKeywordTerms(
	"action.scheduleFollowUp.request",
	{
		includeAllLocales: true,
	},
);

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
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	examples: (spec.examples ?? []) as ActionExample[][],
	suppressPostActionContinuation: true,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (
			runtime.actions.some(
				(action) =>
					action.name === "RELATIONSHIP" ||
					action.name === "RELATIONSHIP",
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
		if (params?.scheduledAt && (params.contactName || params.entityId)) {
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
			throw new Error("Required services not available");
		}

		const parsedResponse = readFollowUpInput(message, _options);
		const contactName = parsedResponse?.contactName?.trim();
		if (!parsedResponse || (!contactName && !parsedResponse.entityId)) {
			logger.warn(
				"[ScheduleFollowUp] Failed to parse follow-up information from response",
			);
			throw new Error("Could not extract follow-up information");
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
					throw new Error(
						`Contact "${contactName}" not found in relationships`,
					);
				}
			}
		}

		if (!entityId) {
			throw new Error("Could not determine contact to follow up with");
		}

		const contact = await relationshipsService.getContact(entityId);
		if (!contact) {
			throw new Error(
				"Contact not found in relationships. Please add them first.",
			);
		}

		const scheduledAt = new Date(parsedResponse.scheduledAt || "");
		if (Number.isNaN(scheduledAt.getTime())) {
			throw new Error("Invalid follow-up date/time");
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

		const responseText = `I've scheduled a follow-up with ${resolvedContactName} for ${scheduledAt.toLocaleString()}. ${
			parsedResponse.reason ? `Reason: ${parsedResponse.reason}` : ""
		}`;

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
