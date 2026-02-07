import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { updateContactTemplate } from "../../prompts.ts";
import type { ContactInfo, RolodexService } from "../../services/rolodex.ts";
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
const spec = requireActionSpec("UPDATE_CONTACT");
const UPDATE_CONTACT_INTENT = /update|edit|modify|change|add.*to|remove.*from/i;

interface UpdateContactXmlResult {
  contactName?: string;
  operation?: string;
  categories?: string;
  tags?: string;
  preferences?: string;
  customFields?: string;
  notes?: string;
}

const parseKeyValueList = (value?: string): Record<string, string> => {
  if (!value) return {};
  const result: Record<string, string> = {};
  const entries = value.split(",");
  for (const entry of entries) {
    const [key, val] = entry.split(":").map((s: string) => s.trim());
    if (key && val) {
      result[key] = val;
    }
  }
  return result;
};

export const updateContactAction: Action = {
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
    const hasIntent = UPDATE_CONTACT_INTENT.test(text);
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
      const updateState: State = {
        values: {
          ...state?.values,
          message: message.content.text,
          senderName: state?.values?.senderName || "User",
          senderId: message.entityId,
          currentDateTime: new Date().toISOString(),
        },
        data: state?.data || {},
        text: state?.text || "",
      };

      const prompt = composePromptFromState({
        state: updateState,
        template: updateContactTemplate,
      });

      // Get LLM response
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      const parsed = parseKeyValueXml<UpdateContactXmlResult>(response);
      if (!parsed) {
        logger.warn("[UpdateContact] Failed to parse response");
        await callback?.({
          text: "I couldn't understand the update request. Please try again.",
        });
        return;
      }

      const contactName = parsed.contactName?.trim();
      if (!contactName) {
        logger.warn("[UpdateContact] No contact name provided");
        await callback?.({
          text: "I couldn't determine which contact to update. Please specify the contact name.",
        });
        return;
      }

      // Find the contact entity
      const contacts = await rolodexService.searchContacts({
        searchTerm: contactName,
      });

      if (contacts.length === 0) {
        await callback?.({
          text: `I couldn't find a contact named "${contactName}" in the rolodex.`,
        });
        return;
      }

      const contact = contacts[0];
      const operation = parsed.operation || "replace";

      // Prepare update data
      const updateData: Partial<ContactInfo> = {};

      // Handle categories
      if (parsed.categories) {
        const newCategories = parsed.categories
          .split(",")
          .map((c: string) => c.trim())
          .filter(Boolean);
        if (operation === "add_to" && contact.categories) {
          updateData.categories = [
            ...new Set([...contact.categories, ...newCategories]),
          ];
        } else {
          updateData.categories = newCategories;
        }
      }

      // Handle tags
      if (parsed.tags) {
        const newTags = parsed.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean);
        if (operation === "add_to" && contact.tags) {
          updateData.tags = [...new Set([...contact.tags, ...newTags])];
        } else {
          updateData.tags = newTags;
        }
      }

      // Handle preferences
      if (parsed.preferences) {
        const newPrefs = parseKeyValueList(parsed.preferences);
        if (operation === "add_to" && contact.preferences) {
          updateData.preferences = { ...contact.preferences, ...newPrefs };
        } else {
          updateData.preferences = newPrefs;
        }
      }

      // Handle custom fields
      if (parsed.customFields) {
        const newFields = parseKeyValueList(parsed.customFields);
        if (operation === "add_to" && contact.customFields) {
          updateData.customFields = { ...contact.customFields, ...newFields };
        } else {
          updateData.customFields = newFields;
        }
      }

      // Update the contact
      const updated = await rolodexService.updateContact(
        contact.entityId,
        updateData,
      );

      if (updated) {
        const responseText = `I've updated ${contactName}'s contact information. ${
          updateData.categories
            ? `Categories: ${updateData.categories.join(", ")}. `
            : ""
        }${updateData.tags ? `Tags: ${updateData.tags.join(", ")}. ` : ""}`;

        await callback?.({
          text: responseText,
          actions: ["UPDATE_CONTACT_INFO"],
        });

        logger.info(`[UpdateContact] Updated contact ${contact.entityId}`);

        return {
          success: true,
          values: {
            contactId: contact.entityId,
            categoriesStr: updateData.categories?.join(",") ?? "",
            tagsStr: updateData.tags?.join(",") ?? "",
          },
          data: {
            success: true,
            updatedFieldsStr: Object.keys(updateData).join(","),
          },
          text: responseText,
        };
      } else {
        throw new Error("Failed to update contact");
      }
    } catch (error) {
      logger.error(
        "[UpdateContact] Error:",
        error instanceof Error ? error.message : String(error),
      );
      await callback?.({
        text: "I encountered an error while updating the contact. Please try again.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
};
