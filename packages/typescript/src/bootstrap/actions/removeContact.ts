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

interface RemoveContactXmlResult {
  contactName?: string;
  confirmed?: string;
}

const removeContactTemplate = `# Remove Contact from Rolodex

Current message: {{message}}
Sender: {{senderName}} (ID: {{senderId}})

## Instructions
Extract the contact removal information from the message:
1. Who to remove (name or entity reference)
2. Confirmation of the intent to remove

Do NOT include any thinking, reasoning, or <think> sections in your response.
Go directly to the XML response format without any preamble or explanation.

## Response Format
<response>
<contactName>Name of the contact to remove</contactName>
<confirmed>yes or no</confirmed>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

export const removeContactAction: Action = {
  name: "REMOVE_CONTACT",
  similes: ["DELETE_CONTACT", "REMOVE_FROM_ROLODEX", "DELETE_FROM_CONTACTS"],
  description: "Removes a contact from the rolodex",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const hasService = !!runtime.getService("rolodex");
    const hasIntent = message.content.text
      ?.toLowerCase()
      .match(/remove|delete|drop.*contact|remove.*from.*rolodex/);
    return hasService && !!hasIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    try {
      const rolodexService = runtime.getService("rolodex") as RolodexService;
      if (!rolodexService) {
        throw new Error("RolodexService not available");
      }

      // Build state for prompt composition
      const removeState: State = {
        values: {
          ...state?.values,
          message: message.content.text,
          senderName: state?.values?.senderName || "User",
          senderId: message.entityId,
        },
        data: state?.data || {},
        text: state?.text || "",
      };

      const prompt = composePromptFromState({
        state: removeState,
        template: removeContactTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      const parsed = parseKeyValueXml<RemoveContactXmlResult>(response);

      if (!parsed?.contactName) {
        logger.warn("[RemoveContact] No contact name provided");
        await callback?.({
          text: "I couldn't determine which contact to remove. Please specify the contact name.",
        });
        return;
      }

      if (parsed.confirmed !== "yes") {
        await callback?.({
          text: `To remove ${parsed.contactName} from your contacts, please confirm by saying "yes, remove ${parsed.contactName}".`,
        });
        return;
      }

      const contacts = await rolodexService.searchContacts({
        searchTerm: parsed.contactName,
      });

      if (contacts.length === 0) {
        await callback?.({
          text: `I couldn't find a contact named "${parsed.contactName}" in the rolodex.`,
        });
        return;
      }

      const contact = contacts[0];

      const removed = await rolodexService.removeContact(contact.entityId);

      if (removed) {
        const responseText = `I've removed ${parsed.contactName} from your contacts.`;
        await callback?.({
          text: responseText,
          actions: ["REMOVE_CONTACT"],
        });

        logger.info(`[RemoveContact] Removed contact ${contact.entityId}`);

        return {
          success: true,
          values: { contactId: contact.entityId },
          data: { success: true },
          text: responseText,
        };
      } else {
        throw new Error("Failed to remove contact");
      }
    } catch (error) {
      logger.error(
        "[RemoveContact] Error:",
        error instanceof Error ? error.message : String(error),
      );
      await callback?.({
        text: "I encountered an error while removing the contact. Please try again.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remove John Doe from my contacts",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: 'To remove John Doe from your contacts, please confirm by saying "yes, remove John Doe".',
          actions: ["REMOVE_CONTACT"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Yes, remove John Doe",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I've removed John Doe from your contacts.",
          actions: ["REMOVE_CONTACT"],
        },
      },
    ],
  ],
};
