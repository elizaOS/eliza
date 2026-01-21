import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { removeContactTemplate } from "../../prompts.ts";
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
const spec = requireActionSpec("REMOVE_CONTACT");
const REMOVE_CONTACT_INTENT =
  /remove|delete|drop.*contact|remove.*from.*rolodex/i;

interface RemoveContactXmlResult {
  contactName?: string;
  confirmed?: string;
}

export const removeContactAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  examples: (spec.examples ?? []) as ActionExample[][],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const hasService = !!runtime.getService("rolodex");
    const text = message.content.text;
    if (!text) return false;
    const hasIntent = REMOVE_CONTACT_INTENT.test(text);
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
        stopSequences: [],
      });
      const parsed = parseKeyValueXml<RemoveContactXmlResult>(response);

      if (!parsed?.contactName) {
        logger.warn("[RemoveContact] No contact name provided");
        await callback?.({
          text: "I couldn't determine which contact to remove. Please specify the contact name.",
        });
        return;
      }

      const confirmed = parsed.confirmed?.trim().toLowerCase();
      if (confirmed !== "yes") {
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
};
