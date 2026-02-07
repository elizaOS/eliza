import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { searchContactsTemplate } from "../../prompts.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("SEARCH_CONTACTS");
const SEARCH_KEYWORDS = [
  "list",
  "show",
  "search",
  "find",
  "contacts",
  "friends",
  "colleagues",
  "vip",
  "who",
];

interface SearchContactsXmlResult {
  categories?: string;
  searchTerm?: string;
  tags?: string;
  intent?: string;
}

export const searchContactsAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  examples: (spec.examples ?? []) as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if RolodexService is available
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    if (!rolodexService) {
      logger.warn("[SearchContacts] RolodexService not available");
      return false;
    }

    // Check if message contains intent to search/list contacts
    const messageText = message.content.text?.toLowerCase() || "";
    if (!messageText) return false;
    return SEARCH_KEYWORDS.some((keyword) => messageText.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;

    if (!rolodexService) {
      throw new Error("RolodexService not available");
    }

    // Build proper state for prompt composition
    if (!state) {
      state = {
        values: {},
        data: {},
        text: "",
      };
    }

    // Add our values to the state
    state.values = {
      ...state.values,
      message: message.content.text,
      senderId: message.entityId,
      senderName: state.values?.senderName || "User",
    };

    // Compose prompt to extract search criteria
    const prompt = composePromptFromState({
      state,
      template: searchContactsTemplate,
    });

    // Use LLM to extract search criteria
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });

    const parsedResponse = parseKeyValueXml<SearchContactsXmlResult>(response);

    // Build search criteria
    const criteria: {
      categories?: string[];
      tags?: string[];
      searchTerm?: string;
    } = {};

    if (parsedResponse?.categories) {
      criteria.categories = parsedResponse.categories
        .split(",")
        .map((c: string) => c.trim())
        .filter(Boolean);
    }

    if (parsedResponse?.searchTerm) {
      criteria.searchTerm = parsedResponse.searchTerm;
    }

    if (parsedResponse?.tags) {
      criteria.tags = parsedResponse.tags
        .split(",")
        .map((t: string) => t.trim())
        .filter(Boolean);
    }

    // Search contacts
    const contacts = await rolodexService.searchContacts(criteria);

    // Get entity names for each contact
    const contactDetails = await Promise.all(
      contacts.map(async (contact) => {
        const entity = await runtime.getEntityById(contact.entityId);
        return {
          contact,
          entity,
          name: entity?.names[0] || "Unknown",
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
};
