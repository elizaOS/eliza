import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import type {
	ContactInfo,
	RelationshipsService,
} from "../../../services/relationships.ts";
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
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UPDATE_CONTACT");
const UPDATE_CONTACT_TERMS = getValidationKeywordTerms(
	"action.updateContact.request",
	{
		includeAllLocales: true,
	},
);

interface UpdateContactInput {
	contactName?: string;
	operation?: string;
	categories?: string | string[];
	tags?: string | string[];
	preferences?: string | Record<string, string>;
	customFields?: string | Record<string, string>;
	notes?: string;
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
	if (!value) return undefined;
	if (typeof value === "string") {
		const values = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

const parseKeyValueList = (
	value?: string | Record<string, string>,
): Record<string, string> => {
	if (!value) return {};
	if (typeof value === "object") return value;
	const result: Record<string, string> = {};
	const entries = value.split(",");
	for (const entry of entries) {
		const [key, val] = entry.split(":").map((s: string) => s.trim());
		if (key && val) {
			result[key] = val;
		}
	}
	return result;
};

function readRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const [key, val] of Object.entries(value)) {
		if (typeof val === "string") result[key] = val;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function readUpdateContactInput(
	message: Memory,
	options?: HandlerOptions,
): UpdateContactInput {
	const params = readParams(options);
	return {
		contactName: readString(params.contactName ?? message.content.contactName),
		operation: readString(params.operation ?? message.content.operation),
		categories:
			readStringArray(params.categories ?? message.content.categories) ??
			undefined,
		tags: readStringArray(params.tags ?? message.content.tags) ?? undefined,
		preferences:
			readRecord(params.preferences ?? message.content.preferences) ??
			readString(params.preferences ?? message.content.preferences),
		customFields:
			readRecord(params.customFields ?? message.content.customFields) ??
			readString(params.customFields ?? message.content.customFields),
		notes: readString(params.notes ?? message.content.notes),
	};
}

export const updateContactAction: Action = {
	name: spec.name,
	contexts: ["contacts", "messaging", "documents"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	suppressPostActionContinuation: true,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const hasService = !!runtime.getService("relationships");
		const params = readUpdateContactInput(message, options);
		if (
			hasService &&
			params.contactName &&
			(params.categories ||
				params.tags ||
				params.preferences ||
				params.customFields ||
				params.notes)
		) {
			return true;
		}
		if (
			hasService &&
			hasActionContextOrKeyword(message, state, {
				contexts: ["contacts", "messaging", "documents"],
				keywordKeys: ["action.updateContact.request"],
			})
		) {
			return true;
		}
		const text = message.content.text;
		if (!text) return false;
		const hasIntent = findKeywordTermMatch(text, UPDATE_CONTACT_TERMS);
		return hasService && !!hasIntent;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const relationshipsService = runtime.getService(
				"relationships",
			) as RelationshipsService;
			if (!relationshipsService) {
				throw new Error("RelationshipsService not available");
			}

			const parsed = readUpdateContactInput(message, _options);

			const contactName = parsed.contactName?.trim();
			if (!contactName) {
				logger.warn("[UpdateContact] No contact name provided");
				await callback?.({
					text: "I couldn't determine which contact to update. Please specify the contact name.",
				});
				return {
					success: false,
					text: "I couldn't determine which contact to update. Please specify the contact name.",
					data: { actionName: "UPDATE_CONTACT" },
				};
			}

			// Find the contact entity
			const contacts = await relationshipsService.searchContacts({
				searchTerm: contactName,
			});

			if (contacts.length === 0) {
				await callback?.({
					text: `I couldn't find a contact named "${contactName}" in the relationships.`,
				});
				return {
					success: false,
					text: `I couldn't find a contact named "${contactName}" in the relationships.`,
					data: { actionName: "UPDATE_CONTACT" },
				};
			}

			const contact = contacts[0];
			const operation = parsed.operation || "replace";

			// Prepare update data
			const updateData: Partial<ContactInfo> = {};

			// Handle categories
			const newCategories = readStringArray(parsed.categories);
			if (newCategories) {
				if (operation === "add_to" && contact.categories) {
					updateData.categories = [
						...new Set([...contact.categories, ...newCategories]),
					];
				} else if (operation === "remove_from" && contact.categories) {
					updateData.categories = contact.categories.filter(
						(category) => !newCategories.includes(category),
					);
				} else {
					updateData.categories = newCategories;
				}
			}

			// Handle tags
			const newTags = readStringArray(parsed.tags);
			if (newTags) {
				if (operation === "add_to" && contact.tags) {
					updateData.tags = [...new Set([...contact.tags, ...newTags])];
				} else if (operation === "remove_from" && contact.tags) {
					updateData.tags = contact.tags.filter(
						(tag) => !newTags.includes(tag),
					);
				} else {
					updateData.tags = newTags;
				}
			}

			// Handle preferences
			if (parsed.preferences) {
				const newPrefs = parseKeyValueList(parsed.preferences);
				if (operation === "add_to" && contact.preferences) {
					updateData.preferences = { ...contact.preferences, ...newPrefs };
				} else if (operation === "remove_from" && contact.preferences) {
					const remainingPreferences = { ...contact.preferences };
					for (const key of Object.keys(newPrefs)) {
						delete remainingPreferences[key];
					}
					updateData.preferences = remainingPreferences;
				} else {
					updateData.preferences = newPrefs;
				}
			}

			// Handle custom fields
			if (parsed.customFields) {
				const newFields = parseKeyValueList(parsed.customFields);
				if (operation === "add_to" && contact.customFields) {
					updateData.customFields = { ...contact.customFields, ...newFields };
				} else if (operation === "remove_from" && contact.customFields) {
					const remainingCustomFields = { ...contact.customFields };
					for (const key of Object.keys(newFields)) {
						delete remainingCustomFields[key];
					}
					updateData.customFields = remainingCustomFields;
				} else {
					updateData.customFields = newFields;
				}
			}

			if (parsed.notes) {
				updateData.preferences = {
					...(updateData.preferences ?? contact.preferences ?? {}),
					notes: parsed.notes,
				};
			}

			// Update the contact
			const updated = await relationshipsService.updateContact(
				contact.entityId,
				updateData,
			);

			if (updated) {
				const responseText = `I've updated ${contactName}'s contact information. ${
					updateData.categories
						? `Categories: ${updateData.categories.join(", ")}. `
						: ""
				}${updateData.tags ? `Tags: ${updateData.tags.join(", ")}. ` : ""}`;

				await callback?.({
					text: responseText,
					actions: ["UPDATE_CONTACT_INFO"],
				});

				logger.info(`[UpdateContact] Updated contact ${contact.entityId}`);

				return {
					success: true,
					values: {
						contactId: contact.entityId,
						categoriesStr: updateData.categories?.join(",") ?? "",
						tagsStr: updateData.tags?.join(",") ?? "",
					},
					data: {
						actionName: "UPDATE_CONTACT",
						success: true,
						updatedFieldsStr: Object.keys(updateData).join(","),
					},
					text: responseText,
				};
			} else {
				throw new Error("Failed to update contact");
			}
		} catch (error) {
			logger.error(
				"[UpdateContact] Error:",
				error instanceof Error ? error.message : String(error),
			);
			await callback?.({
				text: "I encountered an error while updating the contact. Please try again.",
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return {
				success: false,
				text: "I encountered an error while updating the contact. Please try again.",
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "UPDATE_CONTACT" },
			};
		}
	},
	parameters: [
		{
			name: "contactName",
			description: "Name of the contact to update.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "operation",
			description:
				"How to apply list/map updates: replace, add_to, or remove_from.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["replace", "add_to", "remove_from"],
				default: "replace",
			},
		},
		{
			name: "categories",
			description: "Contact categories to set, add, or remove.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "tags",
			description: "Contact tags to set, add, or remove.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "preferences",
			description: "Preference key-value pairs to set, add, or remove.",
			required: false,
			schema: {
				type: "object" as const,
				additionalProperties: { type: "string" as const },
			},
		},
		{
			name: "customFields",
			description: "Custom field key-value pairs to set, add, or remove.",
			required: false,
			schema: {
				type: "object" as const,
				additionalProperties: { type: "string" as const },
			},
		},
		{
			name: "notes",
			description: "Optional notes to store in contact preferences.",
			required: false,
			schema: { type: "string" as const },
		},
	],
};
