// I want to create an action that lets anyone create or update a component for an entity.
// Components represent different sources of data about an entity (telegram, twitter, etc)
// Sources can be registered by plugins or inferred from room context and available components
// The action should first check if the component exists for the entity, and if not, create it.
// We want to use an LLM (runtime.useModel) to generate the component data.
// We should include the prior component data if it exists, and have the LLM output an update to the component.
// sourceEntityId represents who is making the update, entityId is who they are talking about

import {
  type Action,
  type ActionExample,
  Component,
  composePromptFromState,
  findEntityByName,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
  type UUID,
  type ActionResult,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

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
\`\`\`json
{{existingData}}
\`\`\`
{{/if}}

# Instructions:
1. Analyze the conversation to identify:
   - The source/platform being referenced (e.g. telegram, twitter, discord)
   - Any specific component data being shared

2. Generate updated component data that:
   - Is specific to the identified platform/source
   - Preserves existing data when appropriate
   - Includes the new information from the conversation
   - Contains only valid data for this component type

Return a JSON object with the following structure:
\`\`\`json
{
  "source": "platform-name",
  "data": {
    // Component-specific fields
    // e.g. username, username, displayName, etc.
  }
}
\`\`\`

Example outputs:
1. For "my telegram username is @dev_guru":
\`\`\`json
{
  "source": "telegram",
  "data": {
    "username": "dev_guru"
  }
}
\`\`\`

2. For "update my twitter handle to @tech_master":
\`\`\`json
{
  "source": "twitter",
  "data": {
    "username": "tech_master"
  }
}
\`\`\`

Make sure to include the \`\`\`json\`\`\` tags around the JSON object.`;

/**
 * Action for updating contact details for a user entity.
 *
 * @name UPDATE_ENTITY
 * @description Add or edit contact details for a user entity (like twitter, discord, email address, etc.)
 *
 * @param {IAgentRuntime} _runtime - The runtime environment.
 * @param {Memory} _message - The message data.
 * @param {State} _state - The current state.
 * @returns {Promise<boolean>} Returns a promise indicating if validation was successful.
 *
 * @param {IAgentRuntime} runtime - The runtime environment.
 * @param {Memory} message - The message data.
 * @param {State} state - The current state.
 * @param {any} _options - Additional options.
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
  name: 'UPDATE_CONTACT',
  similes: ['UPDATE_ENTITY'],
  description:
    'Add or edit contact details for a person you are talking to or observing in the conversation. Use this when you learn this information from the conversation about a contact. This is for the agent to relate entities across platforms, not for world settings or configuration.',

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
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
    _options?: any,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      if (!state) {
        logger.error('State is required for the updateEntity action');
        return {
          text: 'State is required for updateEntity action',
          values: {
            success: false,
            error: 'STATE_REQUIRED',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: 'State is required',
          },
          success: false,
          error: new Error('State is required for the updateEntity action'),
        };
      }

      if (!callback) {
        logger.error('Callback is required for the updateEntity action');
        return {
          text: 'Callback is required for updateEntity action',
          values: {
            success: false,
            error: 'CALLBACK_REQUIRED',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: 'Callback is required',
          },
          success: false,
          error: new Error('Callback is required for the updateEntity action'),
        };
      }

      if (!responses) {
        logger.error('Responses are required for the updateEntity action');
        return {
          text: 'Responses are required for updateEntity action',
          values: {
            success: false,
            error: 'RESPONSES_REQUIRED',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: 'Responses are required',
          },
          success: false,
          error: new Error('Responses are required for the updateEntity action'),
        };
      }

      if (!message) {
        logger.error('Message is required for the updateEntity action');
        return {
          text: 'Message is required for updateEntity action',
          values: {
            success: false,
            error: 'MESSAGE_REQUIRED',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: 'Message is required',
          },
          success: false,
          error: new Error('Message is required for the updateEntity action'),
        };
      }

      // Handle initial responses
      for (const response of responses) {
        await callback(response.content);
      }

      const sourceEntityId = message.entityId;
      const agentId = runtime.agentId;
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      const worldId = room.worldId;

      // First, find the entity being referenced
      const entity = await findEntityByName(runtime, message, state);

      if (!entity) {
        await callback({
          text: "I'm not sure which entity you're trying to update. Could you please specify who you're talking about?",
          actions: ['UPDATE_ENTITY_ERROR'],
          source: message.content.source,
        });
        return {
          text: 'Entity not found',
          values: {
            success: false,
            error: 'ENTITY_NOT_FOUND',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: 'Could not find entity to update',
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
      let parsedResult: any;
      try {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No valid JSON found in the LLM response');
        }

        parsedResult = JSON.parse(jsonMatch[0]);

        if (!parsedResult.source || !parsedResult.data) {
          throw new Error('Invalid response format - missing source or data');
        }
      } catch (error: any) {
        logger.error(`Failed to parse component data: ${error.message}`);
        await callback({
          text: "I couldn't properly understand the component information. Please try again with more specific information.",
          actions: ['UPDATE_ENTITY_ERROR'],
          source: message.content.source,
        });
        return {
          text: 'Failed to parse component data',
          values: {
            success: false,
            error: 'PARSE_ERROR',
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            error: error.message,
          },
          success: false,
          error: error,
        };
      }

      const componentType = parsedResult.source.toLowerCase();
      const componentData = parsedResult.data;

      // Now that we know the component type, get the existing component if it exists
      existingComponent = await runtime.getComponent(
        entity.id!,
        componentType,
        worldId,
        sourceEntityId
      );

      // Create or update the component
      if (existingComponent) {
        await runtime.updateComponent({
          id: existingComponent.id,
          entityId: entity.id!,
          worldId,
          type: componentType,
          data: componentData,
          agentId,
          roomId: message.roomId,
          sourceEntityId,
          createdAt: existingComponent.createdAt,
        });

        await callback({
          text: `I've updated the ${componentType} information for ${entity.names[0]}.`,
          actions: ['UPDATE_ENTITY'],
          source: message.content.source,
        });

        return {
          text: `Updated ${componentType} information`,
          values: {
            success: true,
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentUpdated: true,
            isNewComponent: false,
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentData,
            existingComponentId: existingComponent.id,
          },
          success: true,
        };
      } else {
        const newComponentId = uuidv4() as UUID;
        await runtime.createComponent({
          id: newComponentId,
          entityId: entity.id!,
          worldId,
          type: componentType,
          data: componentData,
          agentId,
          roomId: message.roomId,
          sourceEntityId,
          createdAt: Date.now(),
        });

        await callback({
          text: `I've added new ${componentType} information for ${entity.names[0]}.`,
          actions: ['UPDATE_ENTITY'],
          source: message.content.source,
        });

        return {
          text: `Added new ${componentType} information`,
          values: {
            success: true,
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentCreated: true,
            isNewComponent: true,
          },
          data: {
            actionName: 'UPDATE_CONTACT',
            entityId: entity.id,
            entityName: entity.names[0],
            componentType,
            componentData,
            newComponentId,
          },
          success: true,
        };
      }
    } catch (error) {
      logger.error(`Error in updateEntity handler: ${error}`);
      await callback?.({
        text: 'There was an error processing the entity information.',
        actions: ['UPDATE_ENTITY_ERROR'],
        source: message.content.source,
      });
      return {
        text: 'Error processing entity information',
        values: {
          success: false,
          error: 'HANDLER_ERROR',
        },
        data: {
          actionName: 'UPDATE_CONTACT',
          error: error instanceof Error ? error.message : String(error),
        },
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Please update my telegram username to @dev_guru',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated your telegram information.",
          actions: ['UPDATE_ENTITY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "Set Jimmy's twitter username to @jimmy_codes",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated Jimmy's twitter information.",
          actions: ['UPDATE_ENTITY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Update my discord username to dev_guru#1234',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated your discord information.",
          actions: ['UPDATE_ENTITY'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default updateEntityAction;
