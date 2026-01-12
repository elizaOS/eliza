import { logger } from "../../logger.ts";
import type { RolodexService } from "../../services/rolodex.ts";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

interface SearchContactsXmlResult {
  categories?: string;
  searchTerm?: string;
  tags?: string;
  intent?: string;
}

const searchContactsTemplate = `# Search Contacts

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the search criteria from the message:
1. Categories to filter by (friend, family, colleague, acquaintance, vip, business)
2. Search terms (names or keywords)
3. Tags to filter by
4. Any other filters mentioned

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<categories>comma-separated list of categories to filter by</categories>
<searchTerm>search term for names</searchTerm>
<tags>comma-separated list of tags</tags>
<intent>list, search, or count</intent>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const searchContactsAction: Action = {
  name: "SEARCH_CONTACTS",
  description: "Search and list contacts in the rolodex",
  similes: [
    "list contacts",
    "show contacts",
    "search contacts",
    "find contacts",
    "who are my friends",
    "list my colleagues",
    "show vip contacts",
    "find people named",
    "search for",
    "contacts list",
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me all my friends" },
      },
      {
        name: "{{name2}}",
        content: { text: "Here are your friends: Alice, Bob, Charlie" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "List my VIP contacts" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Your VIP contacts: Sarah (CEO), John (Key Client)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Find contacts named John" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I found 2 contacts named John: John Smith (colleague), John Doe (friend)",
        },
      },
    ],
  ],

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
    const searchKeywords = [
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
    const messageText = message.content.text?.toLowerCase() || "";

    return searchKeywords.some((keyword) => messageText.includes(keyword));
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
        const grouped = contactDetails.reduce(
          (acc, item) => {
            item.contact.categories.forEach((cat) => {
              if (!acc[cat]) acc[cat] = [];
              acc[cat].push(item);
            });
            return acc;
          },
          {} as Record<string, typeof contactDetails>,
        );

        responseText = `I found ${contactDetails.length} contact${contactDetails.length !== 1 ? "s" : ""}:\n\n`;

        for (const [category, items] of Object.entries(grouped)) {
          responseText += `**${category.charAt(0).toUpperCase() + category.slice(1)}s:**\n`;
          items.forEach((item) => {
            responseText += `- ${item.name}`;
            if (item.contact.tags.length > 0) {
              responseText += ` [${item.contact.tags.join(", ")}]`;
            }
            responseText += "\n";
          });
          responseText += "\n";
        }
      } else {
        // Simple list for specific category
        const categoryName = criteria.categories[0];
        responseText = `Your ${categoryName}s:\n`;
        contactDetails.forEach((item) => {
          responseText += `- ${item.name}`;
          if (item.contact.tags.length > 0) {
            responseText += ` [${item.contact.tags.join(", ")}]`;
          }
          responseText += "\n";
        });
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
