import {
  addHeader,
  ChannelType,
  CustomMetadata,
  formatMessages,
  formatPosts,
  getEntityDetails,
  createUniqueUuid,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type UUID,
} from '@elizaos/core';

const AUTO_ROOM_SEED = 'autonomous_room_singleton'; // Ensure this matches service.ts

/**
 * A provider object that retrieves recent messages, interactions, and memories based on a given message.
 * @typedef {object} Provider
 * @property {string} name - The name of the provider ("AUTONOMOUS_FEED").
 * @property {string} description - A description of the provider's purpose ("Recent messages, interactions and other memories").
 * @property {number} position - The position of the provider (100).
 * @property {Function} get - Asynchronous function that retrieves recent messages, interactions, and memories.
 * @param {IAgentRuntime} runtime - The runtime context for the agent.
 * @param {Memory} message - The message to retrieve data from.
 * @returns {object} An object containing data, values, and text sections.
 */
export const autonomousFeedProvider: Provider = {
  name: 'AUTONOMOUS_FEED',
  description: 'Raw feed of messages, interactions and other memories',
  position: 100,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const autonomousRoomId = createUniqueUuid(runtime, AUTO_ROOM_SEED);
    const conversationLength = runtime.getConversationLength();

    // Parallelize initial data fetching operations including recentInteractions
    let room = null;

    const [entitiesData, recentMessagesData] = await Promise.all([
      getEntityDetails({ runtime, roomId: autonomousRoomId }),
      runtime.getMemories({
        tableName: 'messages',
        roomId: autonomousRoomId,
        count: conversationLength,
        unique: false,
      }),
    ]);

    // Get room if function exists
    if (typeof runtime.getRoom === 'function') {
      try {
        room = await runtime.getRoom(autonomousRoomId);
      } catch (error) {
        console.error('Error in recentMessagesProvider:', error);
      }
    }

    // Format recent messages and posts in parallel
    const formattedRecentMessages = await formatMessages({
      messages: recentMessagesData,
      entities: entitiesData,
    });

    const metaData = message.metadata as CustomMetadata;
    const senderName = metaData?.entityName || 'Autonomous Loop Prompt';

    const recentMessages =
      formattedRecentMessages && formattedRecentMessages.length > 0
        ? addHeader('# Conversation Messages', formattedRecentMessages)
        : '';

    const data = {
      recentMessages: recentMessagesData,
    };

    const values = {
      recentMessages,
    };

    // Combine all text sections
    const text = [recentMessages].filter(Boolean).join('\n\n');

    console.log('MESSAGE FEED TEXT: ', text);

    return {
      data,
      values,
      text,
    };
  },
};
