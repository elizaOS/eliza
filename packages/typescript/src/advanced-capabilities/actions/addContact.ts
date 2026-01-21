import { findEntityByName } from "../../entities.ts";
import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { addContactTemplate } from "../../prompts.ts";
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
import { asUUID, ModelType } from "../../types/index.ts";
import {
  composePromptFromState,
  parseKeyValueXml,
  stringToUuid,
} from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("ADD_CONTACT");
const ADD_KEYWORDS = [
  "add",
  "save",
  "remember",
  "categorize",
  "contact",
  "rolodex",
];

interface AddContactXmlResult {
  contactName?: string;
  entityId?: string;
  categories?: string;
  notes?: string;
  timezone?: string;
  language?: string;
  reason?: string;
}

export const addContactAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  examples: (spec.examples ?? []) as ActionExample[][],

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

    const messageText = message.content.text?.toLowerCase() || "";
    if (!messageText) return false;
    return ADD_KEYWORDS.some((keyword) => messageText.includes(keyword));
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
      stopSequences: [],
    });

    const parsedResponse = parseKeyValueXml<AddContactXmlResult>(response);
    if (!parsedResponse) {
      logger.warn(
        "[AddContact] Failed to parse contact information from response",
      );
      throw new Error("Could not extract contact information");
    }

    const contactName = parsedResponse.contactName?.trim();
    if (!contactName) {
      logger.warn("[AddContact] Missing contact name in response");
      throw new Error("Could not extract contact name");
    }

    let entityId = parsedResponse.entityId
      ? asUUID(parsedResponse.entityId)
      : null;

    if (!entityId) {
      const entity = await findEntityByName(runtime, message, state);

      if (entity?.id) {
        entityId = entity.id;
      } else {
        // Create a new entity ID based on the name
        entityId = stringToUuid(`contact-${contactName}-${runtime.agentId}`);
      }
    }

    if (!entityId) {
      throw new Error("Could not determine entity ID for contact");
    }

    // Parse categories
    const categories = parsedResponse.categories
      ? parsedResponse.categories
          .split(",")
          .map((c: string) => c.trim())
          .filter(Boolean)
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

    logger.info(`[AddContact] Added contact ${contactName} (${entityId})`);

    const responseText = `I've added ${contactName} to your contacts as ${categories.join(", ")}. ${
      parsedResponse.reason || "They have been saved to your rolodex."
    }`;

    if (callback) {
      await callback({
        text: responseText,
        action: "ADD_CONTACT",
        metadata: {
          contactId: entityId,
          contactName,
          categories,
          success: true,
        },
      });
    }

    return {
      success: true,
      values: {
        contactId: entityId,
        contactName,
        categoriesStr: categories.join(","),
      },
      data: {
        contactId: entityId,
        contactName,
        categories: categories.join(","),
      },
      text: responseText,
    };
  },
};
