import { findEntityByName } from "../../../entities.ts";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	Entity,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { asUUID } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { stringToUuid } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("ADD_CONTACT");
const ADD_KEYWORDS = getValidationKeywordTerms("action.addContact.request", {
	includeAllLocales: true,
});

interface AddContactInput {
	contactName?: string;
	entityId?: string;
	categories?: string | string[];
	notes?: string;
	timezone?: string;
	language?: string;
	reason?: string;
}

const MAX_RESULT_TEXT_LENGTH = 500;
const MAX_ERROR_LENGTH = 240;
const MAX_CATEGORY_COUNT = 8;

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
			actionName: "ADD_CONTACT",
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

function readStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value
			.map((item) => readString(item))
			.filter((item): item is string => Boolean(item));
		return values.length > 0 ? values : undefined;
	}
	if (typeof value === "string") {
		const values = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

function readAddContactInput(
	message: Memory,
	options?: HandlerOptions,
): AddContactInput {
	const params = readParams(options);
	return {
		contactName: readString(params.contactName ?? message.content.contactName),
		entityId: readString(params.entityId ?? message.content.entityId),
		categories:
			readStringArray(params.categories ?? message.content.categories) ??
			undefined,
		notes: readString(params.notes ?? message.content.notes),
		timezone: readString(params.timezone ?? message.content.timezone),
		language: readString(params.language ?? message.content.language),
		reason: readString(params.reason ?? message.content.reason),
	};
}

export const addContactAction: Action = {
	name: spec.name,
	contexts: ["contacts", "messaging", "knowledge"],
	roleGate: { minRole: "ADMIN" },
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		if (!relationshipsService) {
			logger.warn("[AddContact] RelationshipsService not available");
			return false;
		}

		const params = readAddContactInput(message, options);
		const categories = readStringArray(params.categories);
		if (
			params.contactName &&
			(!categories || categories.length <= MAX_CATEGORY_COUNT)
		) {
			return true;
		}
		if (
			hasActionContextOrKeyword(message, state, {
				contexts: ["contacts", "messaging", "knowledge"],
				keywordKeys: ["action.addContact.request"],
			})
		) {
			return true;
		}

		const messageText = message.content.text ?? "";
		if (!messageText) return false;
		return findKeywordTermMatch(messageText, ADD_KEYWORDS) !== undefined;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;

		if (!relationshipsService) {
			return invalidResult(
				"Contacts are unavailable right now.",
				"RelationshipsService not available",
			);
		}

		try {
			const parsedResponse = readAddContactInput(message, _options);

			const contactName = parsedResponse.contactName?.trim();
			if (!contactName) {
				logger.warn("[AddContact] Missing contact name in response");
				return invalidResult(
					"I couldn't determine which contact to add.",
					"Could not extract contact name",
				);
			}

			const categories = (
				readStringArray(parsedResponse.categories) ?? ["acquaintance"]
			).slice(0, MAX_CATEGORY_COUNT);
			if (categories.length === 0) {
				categories.push("acquaintance");
			}

			let entityId = parsedResponse.entityId
				? asUUID(parsedResponse.entityId)
				: null;

			if (!entityId) {
				const currentState = state ?? {
					values: {},
					data: {},
					text: "",
				};
				const entity = await findEntityByName(runtime, message, currentState);

				if (entity?.id) {
					entityId = entity.id;
				} else {
					entityId = stringToUuid(`contact-${contactName}-${runtime.agentId}`);
					const entityToCreate: Entity = {
						id: entityId,
						names: [contactName],
						agentId: runtime.agentId,
					};
					await runtime.createEntity(entityToCreate);
				}
			}

			if (!entityId) {
				return invalidResult(
					"I couldn't create that contact right now.",
					"Could not determine entity ID for contact",
					{ contactName },
				);
			}

			const existingEntity = await runtime.getEntityById(entityId);
			if (!existingEntity) {
				await runtime.createEntity({
					id: entityId,
					names: [contactName],
					agentId: runtime.agentId,
				});
			}

			const preferences: Record<string, string> = {};
			if (parsedResponse.timezone)
				preferences.timezone = parsedResponse.timezone;
			if (parsedResponse.language)
				preferences.language = parsedResponse.language;
			if (parsedResponse.notes) preferences.notes = parsedResponse.notes;

			await relationshipsService.addContact(entityId, categories, preferences, {
				displayName: contactName,
			});

			logger.info(`[AddContact] Added contact ${contactName} (${entityId})`);

			const responseText = limitText(
				`I've added ${contactName} to your contacts as ${categories.join(", ")}. ${
					parsedResponse.reason || "They have been saved to your relationships."
				}`,
			);

			if (callback) {
				await callback({
					text: responseText,
					action: "ADD_CONTACT",
					metadata: {
						contactId: entityId,
						contactName,
						categories,
						success: true,
					},
				});
			}

			return {
				success: true,
				values: {
					contactId: entityId,
					contactName,
					categoriesStr: categories.join(","),
				},
				data: {
					actionName: "ADD_CONTACT",
					contactId: entityId,
					contactName,
					categories,
					preferences,
				},
				text: responseText,
			};
		} catch (error) {
			const errorMessage = limitError(error);
			logger.error("[AddContact] Error:", errorMessage);
			const responseText = "I hit an error while adding that contact.";
			await callback?.({
				text: responseText,
				error: errorMessage,
				action: "ADD_CONTACT",
			});
			return invalidResult(responseText, errorMessage);
		}
	},
	parameters: [
		{
			name: "contactName",
			description: "Display name of the contact to add.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "entityId",
			description: "Existing entity ID for the contact, if known.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "categories",
			description: "Relationship categories for this contact.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
				default: ["acquaintance"],
			},
		},
		{
			name: "notes",
			description: "Optional notes to store with the contact.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "timezone",
			description: "Optional contact timezone.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "language",
			description: "Optional preferred language for the contact.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Short explanation for the user-facing confirmation.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};
