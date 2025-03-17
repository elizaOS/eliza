// If a user is new to the server, greet them in the general channel
// Only available if the SHOULD_GREET_NEW_PERSONS setting is true, which should be loaded from the cache from settings

import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
/**
 * Action to greet new users in the configured channel
 * @typedef {Object} Action
 * @property {string} name - The name of the action
 * @property {string[]} similes - Array of similar actions
 * @property {string} description - Description of the action
 * @property {Function} validate - Function to validate the action
 * @property {Function} handler - Function to handle the action
 * @property {ActionExample[][]} examples - Array of examples for the action
 */
export const greetAction: Action = {
  name: 'GREET_NEW_PERSON',
  similes: ['WELCOME_USER', 'SAY_HELLO', 'INTRODUCE'],
  description: 'Greets new users in the configured channel',
  validate: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<boolean> => {
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error('No room found');
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error('No server ID found 1');
    }

    try {
      // Check if greeting is enabled for this server
      const settings = await runtime.getCache<any>(`server_${serverId}_settings_greet`);

      if (!settings?.enabled) {
        return false;
      }

      // Check if this is a new user join event or command to greet
      const isNewUser = message.content.text.includes('joined the server');
      const isGreetCommand =
        message.content.text?.toLowerCase().includes('greet') ||
        message.content.text?.toLowerCase().includes('welcome');

      return isNewUser || isGreetCommand;
    } catch (error) {
      logger.error('Error validating greet action:', error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<void> => {
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error('No room found');
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error('No server ID found 2');
    }

    try {
      // Get greeting settings
      const settings = await runtime.getCache<any>(`server_${serverId}_settings_greet`);

      if (!settings?.enabled || !settings.channelId) {
        logger.error('Greeting settings not properly configured');
        await runtime.createMemory(
          {
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: message.roomId,
            content: {
              thought:
                "Greeting settings were not properly configured so I couldn't greet the new person",
              actions: ['GREET_NEW_PERSON'],
              result: 'failed',
            },
          },
          'messages'
        );
        return;
      }

      // Build greeting message
      const greeting =
        settings.message ||
        `Welcome! I'm ${runtime.character.name}, the community manager. Feel free to introduce yourself!`;

      const content: Content = {
        text: greeting,
        actions: ['GREET_NEW_PERSON'],
        source: 'discord',
      };

      // Create memory of greeting
      await runtime.createMemory(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content,
          createdAt: Date.now(),
        },
        'messages'
      );

      // Send greeting
      await callback(content);
    } catch (error) {
      logger.error('Error in greet handler:', error);
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}} joined the server',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Welcome {{name2}}! I'm the community manager. Feel free to introduce yourself!",
          actions: ['GREET_NEW_PERSON'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can someone greet {{name2}}?',
          source: 'discord',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'Hi {{name2}}! Welcome to our community!',
          actions: ['GREET_NEW_PERSON'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default greetAction;
