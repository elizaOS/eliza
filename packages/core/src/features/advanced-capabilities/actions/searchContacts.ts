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
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SEARCH_CONTACTS");
const SEARCH_KEYWORDS = getValidationKeywordTerms(
	"action.searchContacts.request",
	{
		includeAllLocales: true,
	},
);

const MAX_RESULT_TEXT_LENGTH = 1200;
const MAX_ERROR_LENGTH = 240;
const MAX_CONTACT_RESULTS = 25;
const MAX_CATEGORIES = 8;
const MAX_TAGS = 12;

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
			actionName: "SEARCH_CONTACTS",
			error,
			...data,
		},
	};
}

interface SearchContactsInput {
	categories?: string | string[];
	searchTerm?: string;
	tags?: string | string[];
	intent?: string;
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

function readSearchContactsInput(
	message: Memory,
	options?: HandlerOptions,
): SearchContactsInput {
	const params = readParams(options);
	return {
		categories:
			readStringArray(params.categories ?? message.content.categories) ??
			undefined,
		searchTerm: readString(
			params.searchTerm ?? params.query ?? message.content.searchTerm,
		),
		tags: readStringArray(params.tags ?? message.content.tags) ?? undefined,
		intent: readString(params.intent ?? message.content.intent),
	};
}

export const searchContactsAction: Action = {
	name: spec.name,
	contexts: ["contacts", "messaging", "knowledge"],
	roleGate: { minRole: "ADMIN" },
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	suppressPostActionContinuation: true,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		// Check if RelationshipsService is available
		const relationshipsService = runtime.getService(
			"relationships",
		) as RelationshipsService;
		if (!relationshipsService) {
			logger.warn("[SearchContacts] RelationshipsService not available");
			return false;
		}

		const params = readSearchContactsInput(message, options);
		const categories = readStringArray(params.categories);
		const tags = readStringArray(params.tags);
		if (
			params.searchTerm ||
			(categories && categories.length <= MAX_CATEGORIES) ||
			(tags && tags.length <= MAX_TAGS)
		) {
			return true;
		}
		if (
			hasActionContextOrKeyword(message, state, {
				contexts: ["contacts", "messaging", "knowledge"],
				keywordKeys: ["action.searchContacts.request"],
			})
		) {
			return true;
		}

		// Check if message contains intent to search/list contacts
		const messageText = message.content.text ?? "";
		if (!messageText) return false;
		return findKeywordTermMatch(messageText, SEARCH_KEYWORDS) !== undefined;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
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
			const parsedResponse = readSearchContactsInput(message, _options);

			const criteria: {
				categories?: string[];
				tags?: string[];
				searchTerm?: string;
			} = {};

			const categories = readStringArray(parsedResponse.categories)?.slice(
				0,
				MAX_CATEGORIES,
			);
			if (categories) criteria.categories = categories;

			if (parsedResponse?.searchTerm) {
				criteria.searchTerm = parsedResponse.searchTerm;
			}

			const tags = readStringArray(parsedResponse.tags)?.slice(0, MAX_TAGS);
			if (tags) criteria.tags = tags;

			if (!criteria.searchTerm && !criteria.categories && !criteria.tags) {
				return invalidResult(
					"I need a name, category, or tag to search contacts.",
					"Missing search criteria",
				);
			}

			const contacts = (
				await relationshipsService.searchContacts(criteria)
			).slice(0, MAX_CONTACT_RESULTS);

			const contactDetails = await Promise.all(
				contacts.map(async (contact) => {
					const entity = await runtime.getEntityById(contact.entityId);
					const displayName =
						typeof contact.customFields.displayName === "string"
							? contact.customFields.displayName
							: null;
					return {
						contact,
						entity,
						name: entity?.names[0] || displayName || "Unknown",
					};
				}),
			);

			let responseText = "";

			if (contactDetails.length === 0) {
				responseText = "No contacts found matching your criteria.";
			} else if (parsedResponse?.intent === "count") {
				responseText = `I found ${contactDetails.length} contact${contactDetails.length !== 1 ? "s" : ""} matching your criteria.`;
			} else if (!criteria.categories || criteria.categories.length === 0) {
				const grouped: Record<string, typeof contactDetails> = {};
				for (const item of contactDetails) {
					const itemCategories = item.contact.categories.slice(
						0,
						MAX_CATEGORIES,
					);
					for (const cat of itemCategories) {
						const bucket = grouped[cat];
						if (bucket) {
							bucket.push(item);
						} else {
							grouped[cat] = [item];
						}
					}
				}

				const lines: string[] = [];
				lines.push(
					`I found ${contactDetails.length} contact${contactDetails.length !== 1 ? "s" : ""}:`,
					"",
				);

				for (const category in grouped) {
					const items = grouped[category];
					if (!items) continue;
					lines.push(
						`**${category.charAt(0).toUpperCase() + category.slice(1)}s:**`,
					);
					for (const item of items) {
						let line = `- ${item.name}`;
						const itemTags = item.contact.tags.slice(0, MAX_TAGS);
						if (itemTags.length > 0) {
							line += ` [${itemTags.join(", ")}]`;
						}
						lines.push(line);
					}
					lines.push("");
				}
				responseText = lines.join("\n").trim();
			} else {
				const categoryName = criteria.categories[0];
				const lines = [`Your ${categoryName}s:`];
				for (const item of contactDetails) {
					let line = `- ${item.name}`;
					const itemTags = item.contact.tags.slice(0, MAX_TAGS);
					if (itemTags.length > 0) {
						line += ` [${itemTags.join(", ")}]`;
					}
					lines.push(line);
				}
				responseText = lines.join("\n");
			}

			responseText = limitText(responseText);

			if (callback) {
				await callback({
					text: responseText,
					action: "SEARCH_CONTACTS",
					metadata: {
						count: contactDetails.length,
						criteria,
						success: true,
					},
				});
			}

			return {
				success: true,
				values: {
					count: contactDetails.length,
					criteria,
				},
				data: {
					actionName: "SEARCH_CONTACTS",
					count: contactDetails.length,
					criteria,
					contacts: contactDetails.map((d) => ({
						id: d.contact.entityId,
						name: d.name,
						categories: d.contact.categories.slice(0, MAX_CATEGORIES),
						tags: d.contact.tags.slice(0, MAX_TAGS),
					})),
					truncated: contacts.length === MAX_CONTACT_RESULTS,
				},
				text: responseText,
			};
		} catch (error) {
			const errorMessage = limitError(error);
			logger.error("[SearchContacts] Error:", errorMessage);
			const responseText = "I hit an error while searching contacts.";
			await callback?.({
				text: responseText,
				error: errorMessage,
				action: "SEARCH_CONTACTS",
			});
			return invalidResult(responseText, errorMessage);
		}
	},
	parameters: [
		{
			name: "searchTerm",
			description: "Name or text to search contacts for.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "categories",
			description: "Contact categories to filter by.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "tags",
			description: "Contact tags to filter by.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
	],
};
