import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type { RelationshipsService } from "../../../services/relationships.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CONTACTS");
const MAX_CONTACTS = 50;

export const contactsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	contexts: ["contacts", "memory"],
	contextGate: { anyOf: ["contacts", "memory"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const relationshipsService = runtime.getService(
				"relationships",
			) as RelationshipsService;
			if (!relationshipsService) {
				runtime.logger.warn(
					"[ContactsProvider] RelationshipsService not available",
				);
				return { text: "", values: {}, data: {} };
			}

			// Get all contacts
			const contacts = (await relationshipsService.searchContacts({})).slice(
				0,
				MAX_CONTACTS,
			);

		if (contacts.length === 0) {
			return {
				text: "No contacts in relationships.",
				values: { contactCount: 0 },
				data: {},
			};
		}

		// Get entity details and categorize
		const contactDetails = await Promise.all(
			contacts.map(async (contact) => {
				const entity = await runtime.getEntityById(contact.entityId);
				const displayName =
					typeof contact.customFields.displayName === "string"
						? contact.customFields.displayName
						: null;
				return {
					id: contact.entityId,
					name: entity?.names[0] || displayName || "Unknown",
					categories: contact.categories,
					tags: contact.tags,
					preferences: contact.preferences,
					lastModified: contact.lastModified,
				};
			}),
		);

		// Group by category
		const grouped: Record<string, typeof contactDetails> = {};
		for (const contact of contactDetails) {
			for (const cat of contact.categories) {
				const bucket = grouped[cat];
				if (bucket) {
					bucket.push(contact);
				} else {
					grouped[cat] = [contact];
				}
			}
		}

		const lines: string[] = [];
		lines.push(`You have ${contacts.length} contacts in your relationships:`);

		const categoryCounts: Record<string, number> = {};
		for (const category in grouped) {
			const items = grouped[category];
			if (!items) continue;
			categoryCounts[category] = items.length;
			lines.push(
				"",
				`${category.charAt(0).toUpperCase() + category.slice(1)}s (${items.length}):`,
			);
			for (const item of items) {
				let line = `- ${item.name}`;
				if (item.tags.length > 0) {
					line += ` [${item.tags.join(", ")}]`;
				}
				lines.push(line);
			}
		}

		const textSummary = lines.join("\n").trim();

			return {
				text: textSummary,
				values: {
					contactCount: contacts.length,
					...categoryCounts,
				},
				data: categoryCounts,
			};
		} catch (error) {
			return {
				text: "",
				values: { contactCount: 0 },
				data: {
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	},
};
