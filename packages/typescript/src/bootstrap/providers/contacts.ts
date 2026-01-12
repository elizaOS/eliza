import type { RolodexService } from "../../services/rolodex.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";

export const contactsProvider: Provider = {
  name: "CONTACTS",
  description: "Provides contact information from the rolodex",
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
    const grouped = contactDetails.reduce(
      (acc, contact) => {
        contact.categories.forEach((cat) => {
          if (!acc[cat]) acc[cat] = [];
          acc[cat].push(contact);
        });
        return acc;
      },
      {} as Record<string, typeof contactDetails>,
    );

    // Build text summary
    let textSummary = `You have ${contacts.length} contacts in your rolodex:\n`;

    for (const [category, items] of Object.entries(grouped)) {
      textSummary += `\n${category.charAt(0).toUpperCase() + category.slice(1)}s (${items.length}):\n`;
      items.forEach((item) => {
        textSummary += `- ${item.name}`;
        if (item.tags.length > 0) {
          textSummary += ` [${item.tags.join(", ")}]`;
        }
        textSummary += "\n";
      });
    }

    // Build category counts as simple key-value pairs
    const categoryCounts: Record<string, number> = {};
    for (const [cat, items] of Object.entries(grouped)) {
      categoryCounts[cat] = items.length;
    }

    return {
      text: textSummary.trim(),
      values: {
        contactCount: contacts.length,
        ...categoryCounts,
      },
      data: categoryCounts,
    };
  },
};
