import { findEntityByName } from "../../entities.ts";
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
import { asUUID, ModelType } from "../../types/index.ts";
import {
  composePromptFromState,
  parseKeyValueXml,
  stringToUuid,
} from "../../utils.ts";

interface AddContactXmlResult {
  contactName?: string;
  entityId?: string;
  categories?: string;
  notes?: string;
  timezone?: string;
  language?: string;
  reason?: string;
}

const addContactTemplate = `# Add Contact to Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact information from the message and determine:
1. Who should be added as a contact (name or entity reference)
2. What category they belong to (friend, family, colleague, acquaintance, vip, business)
3. Any preferences or notes mentioned

Respond with the extracted information in XML format.

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to add</contactName>
<entityId>ID if known, otherwise leave empty</entityId>
<categories>comma-separated categories</categories>
<notes>Any additional notes or preferences</notes>
<timezone>Timezone if mentioned</timezone>
<language>Language preference if mentioned</language>
<reason>Reason for adding this contact</reason>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const addContactAction: Action = {
  name: "ADD_CONTACT",
  description:
    "Add a new contact to the rolodex with categorization and preferences",
  similes: [
    "add contact",
    "save contact",
    "add to contacts",
    "add to rolodex",
    "remember this person",
    "save their info",
    "add them to my list",
    "categorize as friend",
    "mark as vip",
    "add to address book",
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Add John Smith to my contacts as a colleague" },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've added John Smith to your contacts as a colleague.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Save this person as a friend in my rolodex" },
      },
      {
        name: "{{name2}}",
        content: { text: "I've saved them as a friend in your rolodex." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Remember Alice as a VIP contact" },
      },
      {
        name: "{{name2}}",
        content: { text: "I've added Alice to your contacts as a VIP." },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;
    if (!rolodexService) {
      logger.warn("[AddContact] RolodexService not available");
      return false;
    }

    const addKeywords = [
      "add",
      "save",
      "remember",
      "categorize",
      "contact",
      "rolodex",
    ];
    const messageText = message.content.text?.toLowerCase() || "";

    return addKeywords.some((keyword) => messageText.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const rolodexService = runtime.getService("rolodex") as RolodexService;

    if (!rolodexService) {
      throw new Error("RolodexService not available");
    }

    if (!state) {
      state = {
        values: {},
        data: {},
        text: "",
      };
    }

    state.values = {
      ...state.values,
      message: message.content.text,
      senderId: message.entityId,
      senderName: state.values?.senderName || "User",
    };

    const prompt = composePromptFromState({
      state,
      template: addContactTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseKeyValueXml<AddContactXmlResult>(response);
    if (!parsedResponse || !parsedResponse.contactName) {
      logger.warn(
        "[AddContact] Failed to parse contact information from response",
      );
      throw new Error("Could not extract contact information");
    }

    let entityId = parsedResponse.entityId
      ? asUUID(parsedResponse.entityId)
      : null;

    if (!entityId && parsedResponse.contactName) {
      const entity = await findEntityByName(runtime, message, state);

      if (entity?.id) {
        entityId = entity.id;
      } else {
        // Create a new entity ID based on the name
        entityId = stringToUuid(
          `contact-${parsedResponse.contactName}-${runtime.agentId}`,
        );
      }
    }

    if (!entityId) {
      throw new Error("Could not determine entity ID for contact");
    }

    // Parse categories
    const categories = parsedResponse.categories
      ? parsedResponse.categories.split(",").map((c: string) => c.trim())
      : ["acquaintance"];

    // Build preferences
    const preferences: Record<string, string> = {};
    if (parsedResponse.timezone) preferences.timezone = parsedResponse.timezone;
    if (parsedResponse.language) preferences.language = parsedResponse.language;
    if (parsedResponse.notes) preferences.notes = parsedResponse.notes;

    const _contact = await rolodexService.addContact(
      entityId,
      categories,
      preferences,
    );

    logger.info(
      `[AddContact] Added contact ${parsedResponse.contactName} (${entityId})`,
    );

    const responseText = `I've added ${parsedResponse.contactName} to your contacts as ${categories.join(", ")}. ${
      parsedResponse.reason || "They have been saved to your rolodex."
    }`;

    if (callback) {
      await callback({
        text: responseText,
        action: "ADD_CONTACT",
        metadata: {
          contactId: entityId,
          contactName: parsedResponse.contactName,
          categories,
          success: true,
        },
      });
    }

    return {
      success: true,
      values: {
        contactId: entityId,
        contactName: parsedResponse.contactName ?? "",
        categoriesStr: categories.join(","),
      },
      data: {
        contactId: entityId,
        contactName: parsedResponse.contactName ?? "",
        categories: categories.join(","),
      },
      text: responseText,
    };
  },
};
