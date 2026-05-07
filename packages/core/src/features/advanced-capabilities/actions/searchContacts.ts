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

// Get text content from centralized specs
const spec = requireActionSpec("SEARCH_CONTACTS");
const SEARCH_KEYWORDS = getValidationKeywordTerms(
	"action.searchContacts.request",
	{
		includeAllLocales: true,
	},
);

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
	description: spec.description,
	similes: spec.similes ? [...spec.similes] : [],
	suppressPostActionContinuation: true,
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
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
		if (params.searchTerm || params.categories || params.tags) return true;

		// Check if message contains intent to search/list contacts
		const messageText = message.content.text ?? "";
		if (!messageText) return false;
		return findKeywordTermMatch(messageText, SEARCH_KEYWORDS) !== undefined;
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

		if (!relationshipsService) {
			throw new Error("RelationshipsService not available");
		}

		const parsedResponse = readSearchContactsInput(message, _options);

		// Build search criteria
		const criteria: {
			categories?: string[];
			tags?: string[];
			searchTerm?: string;
		} = {};

		const categories = readStringArray(parsedResponse.categories);
		if (categories) criteria.categories = categories;

		if (parsedResponse?.searchTerm) {
			criteria.searchTerm = parsedResponse.searchTerm;
		}

		const tags = readStringArray(parsedResponse.tags);
		if (tags) criteria.tags = tags;

		// Search contacts
		const contacts = await relationshipsService.searchContacts(criteria);

		// Get entity names for each contact
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

		// Format response
		let responseText = "";

		if (contactDetails.length === 0) {
			responseText = "No contacts found matching your criteria.";
		} else if (parsedResponse?.intent === "count") {
			responseText = `I found ${contactDetails.length} contact${contactDetails.length !== 1 ? "s" : ""} matching your criteria.`;
		} else {
			// Group by category if searching all
			if (!criteria.categories || criteria.categories.length === 0) {
				const grouped: Record<string, typeof contactDetails> = {};
				for (const item of contactDetails) {
					for (const cat of item.contact.categories) {
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
						if (item.contact.tags.length > 0) {
							line += ` [${item.contact.tags.join(", ")}]`;
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
					if (item.contact.tags.length > 0) {
						line += ` [${item.contact.tags.join(", ")}]`;
					}
					lines.push(line);
				}
				responseText = lines.join("\n");
			}
		}

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
					categories: d.contact.categories,
					tags: d.contact.tags,
				})),
			},
			text: responseText,
		};
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
