// action: SEND_MESSAGE
// send message to a user or room (other than this room we are in)

import {
  type Action,
  type ActionExample,
  composePromptFromState,
  findEntityByName,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from '@elizaos/core';

/**
 * Task: Extract Target and Source Information
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * Analyze the conversation to identify:
 * 1. The target type (user or room)
 * 2. The target platform/source (e.g. telegram, discord, etc)
 * 3. Any identifying information about the target
 *
 * Return a JSON object with:
 * {
 *   "targetType": "user|room",
 *   "source": "platform-name",
 *   "identifiers": {
 *     // Relevant identifiers for that target
 *     // e.g. username, roomName, etc.
 *   }
 * }
 *
 * Example outputs:
 * For "send a message to @dev_guru on telegram":
 * {
 *   "targetType": "user",
 *   "source": "telegram",
 *   "identifiers": {
 *     "username": "dev_guru"
 *   }
 * }
 *
 * For "post this in #announcements":
 * {
 *   "targetType": "room",
 *   "source": "discord",
 *   "identifiers": {
 *     "roomName": "announcements"
 *   }
 * }
 *
 * Make sure to include the ```json``` tags around the JSON object.
 */
/**
 * Task: Extract Target and Source Information
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * Analyze the conversation to identify:
 * 1. The target type (user or room)
 * 2. The target platform/source (e.g. telegram, discord, etc)
 * 3. Any identifying information about the target
 *
 * Return a JSON object with:
 * {
 *    "targetType": "user|room",
 *    "source": "platform-name",
 *    "identifiers": {
 *      // Relevant identifiers for that target
 *      // e.g. username, roomName, etc.
 *    }
 * }
 *
 * Example outputs:
 * 1. For "send a message to @dev_guru on telegram":
 * {
 *    "targetType": "user",
 *    "source": "telegram",
 *    "identifiers": {
 *      "username": "dev_guru"
 *    }
 * }
 *
 * 2. For "post this in #announcements":
 * {
 *    "targetType": "room",
 *    "source": "discord",
 *    "identifiers": {
 *      "roomName": "announcements"
 *    }
 * }
 *
 * Make sure to include the `json` tags around the JSON object.
 */
const targetExtractionTemplate = `# Task: Extract Target and Source Information

# Recent Messages:
{{recentMessages}}

# Instructions:
Analyze the conversation to identify:
1. The target type (user or room)
2. The target platform/source (e.g. telegram, discord, etc)
3. Any identifying information about the target

Return a JSON object with:
\`\`\`json
{
  "targetType": "user|room",
  "source": "platform-name",
  "identifiers": {
    // Relevant identifiers for that target
    // e.g. username, roomName, etc.
  }
}
\`\`\`
Example outputs:
1. For "send a message to @dev_guru on telegram":
\`\`\`json
{
  "targetType": "user",
  "source": "telegram",
  "identifiers": {
    "username": "dev_guru"
  }
}
\`\`\`

2. For "post this in #announcements":
\`\`\`json
{
  "targetType": "room",
  "source": "discord",
  "identifiers": {
    "roomName": "announcements"
  }
}
\`\`\`

Make sure to include the \`\`\`json\`\`\` tags around the JSON object.`;
/**
 * Represents an action to send a message to a user or room.
 *
 * @typedef {Action} sendMessageAction
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Additional names for the action.
 * @property {string} description - Description of the action.
 * @property {function} validate - Asynchronous function to validate if the action can be executed.
 * @property {function} handler - Asynchronous function to handle the action execution.
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action.
 */
export const sendMessageAction: Action = {
  name: 'SEND_MESSAGE',
  similes: ['DM', 'MESSAGE', 'SEND_DM', 'POST_MESSAGE'],
  description: 'Send a message to a user or room (other than the current one)',

  validate: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<boolean> => {
    // Check if we have permission to send messages
    const worldId = message.roomId;
    const agentId = runtime.agentId;

    // Get all components for the current room to understand available sources
    const roomComponents = await runtime.getComponents(message.roomId, worldId, agentId);

    // Get source types from room components
    const availableSources = new Set(roomComponents.map((c) => c.type));

    // TODO: Add ability for plugins to register their sources
    // const registeredSources = runtime.getRegisteredSources?.() || [];
    // availableSources.add(...registeredSources);

    return availableSources.size > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
    responses: Memory[]
  ): Promise<void> => {
    try {
      // Handle initial responses
      for (const response of responses) {
        await callback(response.content);
      }

      const sourceEntityId = message.entityId;
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      const worldId = room.worldId;

      // Extract target and source information
      const targetPrompt = composePromptFromState({
        state,
        template: targetExtractionTemplate,
      });

      const targetResult = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: targetPrompt,
        stopSequences: [],
      });

      const targetData = parseJSONObjectFromText(targetResult);
      if (!targetData?.targetType || !targetData?.source) {
        await callback({
          text: "I couldn't determine where you want me to send the message. Could you please specify the target (user or room) and platform?",
          actions: ['SEND_MESSAGE_ERROR'],
          source: message.content.source,
        });
        return;
      }

      const source = targetData.source.toLowerCase();

      if (targetData.targetType === 'user') {
        // Try to find the target user entity
        const targetEntity = await findEntityByName(runtime, message, state);

        if (!targetEntity) {
          await callback({
            text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
          return;
        }

        // Get the component for the specified source
        const userComponent = await runtime.getComponent(
          targetEntity.id!,
          source,
          worldId,
          sourceEntityId
        );

        if (!userComponent) {
          await callback({
            text: `I couldn't find ${source} information for that user. Could you please provide their ${source} details?`,
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
          return;
        }

        const sendDirectMessage = (runtime.getService(source) as any)?.sendDirectMessage;

        if (!sendDirectMessage) {
          await callback({
            text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
          return;
        }
        // Send the message using the appropriate client
        try {
          await sendDirectMessage(runtime, targetEntity.id!, source, message.content.text, worldId);

          await callback({
            text: `Message sent to ${targetEntity.names[0]} on ${source}.`,
            actions: ['SEND_MESSAGE'],
            source: message.content.source,
          });
        } catch (error) {
          logger.error(`Failed to send direct message: ${error.message}`);
          await callback({
            text: 'I encountered an error trying to send the message. Please try again.',
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
        }
      } else if (targetData.targetType === 'room') {
        // Try to find the target room
        const rooms = await runtime.getRooms(worldId);
        const targetRoom = rooms.find((r) => {
          // Match room name from identifiers
          return r.name.toLowerCase() === targetData.identifiers.roomName?.toLowerCase();
        });

        if (!targetRoom) {
          await callback({
            text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
          return;
        }

        const sendRoomMessage = (runtime.getService(source) as any)?.sendRoomMessage;

        if (!sendRoomMessage) {
          await callback({
            text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
          return;
        }

        // Send the message to the room
        try {
          await sendRoomMessage(runtime, targetRoom.id, source, message.content.text, worldId);

          await callback({
            text: `Message sent to ${targetRoom.name} on ${source}.`,
            actions: ['SEND_MESSAGE'],
            source: message.content.source,
          });
        } catch (error) {
          logger.error(`Failed to send room message: ${error.message}`);
          await callback({
            text: 'I encountered an error trying to send the message to the room. Please try again.',
            actions: ['SEND_MESSAGE_ERROR'],
            source: message.content.source,
          });
        }
      }
    } catch (error) {
      logger.error(`Error in sendMessage handler: ${error}`);
      await callback({
        text: 'There was an error processing your message request.',
        actions: ['SEND_MESSAGE_ERROR'],
        source: message.content.source,
      });
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: "Send a message to @dev_guru on telegram saying 'Hello!'",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to dev_guru on telegram.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "Post 'Important announcement!' in #announcements",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to announcements.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "DM Jimmy and tell him 'Meeting at 3pm'",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to Jimmy.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default sendMessageAction;
