import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("CONTACTS");

export const contactsProvider: Provider = {
  name: spec.name,
  description: spec.description,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    if (!rolodexService) {
      runtime.logger.warn("[ContactsProvider] RolodexService not available");
      return { text: "", values: {}, data: {} };
    }

    // Get all contacts
    const contacts = await rolodexService.searchContacts({});

    if (contacts.length === 0) {
      return {
        text: "No contacts in rolodex.",
        values: { contactCount: 0 },
        data: {},
      };
    }

    // Get entity details and categorize
    const contactDetails = await Promise.all(
      contacts.map(async (contact) => {
        const entity = await runtime.getEntityById(contact.entityId);
        return {
          id: contact.entityId,
          name: entity?.names[0] || "Unknown",
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
    lines.push(`You have ${contacts.length} contacts in your rolodex:`);

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
  },
};
