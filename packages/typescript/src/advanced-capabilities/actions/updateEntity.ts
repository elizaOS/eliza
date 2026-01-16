// I want to create an action that lets anyone create or update a component for an entity.
// Components represent different sources of data about an entity (telegram, x, etc)
// Sources can be registered by plugins or inferred from room context and available components
// The action should first check if the component exists for the entity, and if not, create it.
// We want to use an LLM (runtime.useModel) to generate the component data.
// We should include the prior component data if it exists, and have the LLM output an update to the component.
// sourceEntityId represents who is making the update, entityId is who they are talking about

import { v4 as uuidv4 } from "uuid";
import { findEntityByName } from "../../entities.ts";
import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  Component,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Metadata,
  ProviderValue,
  State,
  UUID,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UPDATE_ENTITY");

/** Shape of the component extraction XML response */
interface ComponentExtractionResult {
  source?: string;
  data?: Record<string, unknown>;
}

/**
 * Component Template for Task: Extract Source and Update Component Data
 *
 * @type {string}
 */
/**
 * Component Template for extracting source and updating component data.
 *
 * @type {string}
 */
const componentTemplate = `# Task: Extract Source and Update Component Data

{{recentMessages}}

{{#if existingData}}
# Existing Component Data:
{{existingData}}
{{/if}}

# Instructions:
1. Analyze the conversation to identify:
   - The source/platform being referenced (e.g. telegram, x, discord)
   - Any specific component data being shared

2. Generate updated component data that:
   - Is specific to the identified platform/source
   - Preserves existing data when appropriate
   - Includes the new information from the conversation
   - Contains only valid data for this component type

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with the following structure:
<response>
  <source>platform-name</source>
  <data>
    <username>username_value</username>
    <displayName>display_name_value</displayName>
    <!-- Add other component-specific fields as needed -->
  </data>
</response>

Example outputs:
1. For "my telegram username is @dev_guru":
<response>
  <source>telegram</source>
  <data>
    <username>dev_guru</username>
  </data>
</response>

2. For "update my x handle to @tech_master":
<response>
  <source>x</source>
  <data>
    <username>tech_master</username>
  </data>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

/**
 * Action for updating contact details for a user entity.
 *
 * @name UPDATE_ENTITY
 * @description Add or edit contact details for a user entity (like x, discord, email address, etc.)
 *
 * @param {IAgentRuntime} _runtime - The runtime environment.
 * @param {Memory} _message - The message data.
 * @param {State} _state - The current state.
 * @returns {Promise<boolean>} Returns a promise indicating if validation was successful.
 *
 * @param {IAgentRuntime} runtime - The runtime environment.
 * @param {Memory} message - The message data.
 * @param {State} state - The current state.
 * @param {HandlerOptions} _options - Additional options.
 * @param {HandlerCallback} callback - The callback function.
 * @param {Memory[]} responses - Array of responses.
 * @returns {Promise<void>} Promise that resolves after handling the update entity action.
 *
 * @example
 * [
 *    [
 *      {
 *        name: "{{name1}}",
 *        content: {
 *          text: "Please update my telegram username to @dev_guru",
 *        },
 *      },
 *      {
 *        name: "{{name2}}",
 *        content: {
 *          text: "I've updated your telegram information.",
 *          actions: ["UPDATE_ENTITY"],
 *        },
 *      },
 *    ],
 *    ...
 * ]
 */
export const updateEntityAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  examples: (spec.examples ?? []) as ActionExample[][],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if we have any registered sources or existing components that could be updated
    // const worldId = message.roomId;
    // const agentId = runtime.agentId;

    // // Get all components for the current room to understand available sources
    // const roomComponents = await runtime.getComponents(message.roomId, worldId, agentId);

    // // Get source types from room components
    // const availableSources = new Set(roomComponents.map(c => c.type));
    return true; // availableSources.size > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error(
        {
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId,
        },
        "State is required for the updateEntity action",
      );
      return {
        text: "State is required for updateEntity action",
        values: {
          success: false,
          error: "STATE_REQUIRED",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "State is required",
        },
        success: false,
        error: new Error("State is required for the updateEntity action"),
      };
    }

    if (!callback) {
      logger.error(
        {
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId,
        },
        "Callback is required for the updateEntity action",
      );
      return {
        text: "Callback is required for updateEntity action",
        values: {
          success: false,
          error: "CALLBACK_REQUIRED",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Callback is required",
        },
        success: false,
        error: new Error("Callback is required for the updateEntity action"),
      };
    }

    if (!responses) {
      logger.error(
        {
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId,
        },
        "Responses are required for the updateEntity action",
      );
      return {
        text: "Responses are required for updateEntity action",
        values: {
          success: false,
          error: "RESPONSES_REQUIRED",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Responses are required",
        },
        success: false,
        error: new Error("Responses are required for the updateEntity action"),
      };
    }

    if (!message) {
      logger.error(
        {
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId,
        },
        "Message is required for the updateEntity action",
      );
      return {
        text: "Message is required for updateEntity action",
        values: {
          success: false,
          error: "MESSAGE_REQUIRED",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Message is required",
        },
        success: false,
        error: new Error("Message is required for the updateEntity action"),
      };
    }

    // Handle initial responses
    for (const response of responses) {
      await callback(response.content);
    }

    const sourceEntityId = message.entityId;
    const agentId = runtime.agentId;
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room || !room.worldId) {
      return {
        text: "Could not find room or world",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Room or world not found",
        },
        success: false,
      };
    }

    const worldId = room.worldId;

    // First, find the entity being referenced
    const entity = await findEntityByName(runtime, message, state);

    if (!entity) {
      await callback({
        text: "I'm not sure which entity you're trying to update. Could you please specify who you're talking about?",
        actions: ["UPDATE_ENTITY_ERROR"],
        source: message.content.source,
      });
      return {
        text: "Entity not found",
        values: {
          success: false,
          error: "ENTITY_NOT_FOUND",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Could not find entity to update",
        },
        success: false,
      };
    }

    // Get existing component if it exists - we'll get this after the LLM identifies the source
    let existingComponent: Component | null = null;

    // Generate component data using the combined template
    const prompt = composePromptFromState({
      state,
      template: componentTemplate,
    });

    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    // Parse the generated data
    const parsedResult = parseKeyValueXml<ComponentExtractionResult>(result);

    if (!parsedResult || !parsedResult.source || !parsedResult.data) {
      logger.error(
        {
          src: "plugin:bootstrap:action:update_entity",
          agentId: runtime.agentId,
        },
        "Failed to parse component data - missing source or data",
      );
      await callback({
        text: "I couldn't properly understand the component information. Please try again with more specific information.",
        actions: ["UPDATE_ENTITY_ERROR"],
        source: message.content.source,
      });
      return {
        text: "Failed to parse component data",
        values: {
          success: false,
          error: "PARSE_ERROR",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Invalid response format - missing source or data",
        },
        success: false,
      };
    }

    const componentType = parsedResult.source.toLowerCase();
    const componentData = parsedResult.data as Metadata;

    // Now that we know the component type, get the existing component if it exists
    const entityId = entity.id;
    const entityName = entity.names[0] ?? "Unknown";
    if (!entityId) {
      return {
        text: "Entity ID is required",
        values: {
          success: false,
          error: "ENTITY_ID_REQUIRED",
        },
        data: {
          actionName: "UPDATE_CONTACT",
          error: "Entity ID is required",
        },
        success: false,
      };
    }

    existingComponent = await runtime.getComponent(
      entityId,
      componentType,
      worldId,
      sourceEntityId,
    );

    // Create or update the component
    if (existingComponent) {
      await runtime.updateComponent({
        id: existingComponent.id,
        entityId,
        worldId,
        type: componentType,
        data: componentData,
        agentId,
        roomId: message.roomId,
        sourceEntityId,
        createdAt: existingComponent.createdAt,
      });

      await callback({
        text: `I've updated the ${componentType} information for ${entityName}.`,
        actions: ["UPDATE_ENTITY"],
        source: message.content.source,
      });

      return {
        text: `Updated ${componentType} information`,
        values: {
          success: true,
          entityId: entity.id ?? null,
          entityName,
          componentType,
          componentUpdated: true,
          isNewComponent: false,
        },
        data: {
          actionName: "UPDATE_CONTACT",
          entityId: entity.id ?? null,
          entityName,
          componentType,
          componentData: componentData as ProviderValue,
          existingComponentId: existingComponent.id ?? null,
        },
        success: true,
      };
    } else {
      const newComponentId = uuidv4() as UUID;
      const now = Date.now();
      await runtime.createComponent({
        id: newComponentId,
        entityId,
        worldId,
        type: componentType,
        data: componentData,
        agentId,
        roomId: message.roomId,
        sourceEntityId,
        createdAt: now,
      });

      await callback({
        text: `I've added new ${componentType} information for ${entityName}.`,
        actions: ["UPDATE_ENTITY"],
        source: message.content.source,
      });

      return {
        text: `Added new ${componentType} information`,
        values: {
          success: true,
          entityId: entity.id ?? null,
          entityName,
          componentType,
          componentCreated: true,
          isNewComponent: true,
        },
        data: {
          actionName: "UPDATE_CONTACT",
          entityId: entity.id ?? null,
          entityName,
          componentType,
          componentData: componentData as ProviderValue,
          newComponentId: newComponentId ?? null,
        },
        success: true,
      };
    }
  },
};

export default updateEntityAction;
