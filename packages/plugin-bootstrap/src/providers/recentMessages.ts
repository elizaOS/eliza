import {
  addHeader,
  ChannelType,
  CustomMetadata,
  formatMessages,
  formatPosts,
  getEntityDetails,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type UUID,
} from '@elizaos/core';

// Move getRecentInteractions outside the provider
/**
 * Retrieves the recent interactions between two entities in a specific context.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} A promise that resolves to an array of Memory objects representing recent interactions.
 */
/**
 * Retrieves the recent interactions between two entities in different rooms excluding a specific room.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} An array of Memory objects representing recent interactions between the two entities.
 */
const getRecentInteractions = async (
  runtime: IAgentRuntime,
  sourceEntityId: UUID,
  targetEntityId: UUID,
  excludeRoomId: UUID
): Promise<Memory[]> => {
  // Find all rooms where sourceEntityId and targetEntityId are participants
  const rooms = await runtime.getRoomsForParticipants([sourceEntityId, targetEntityId]);

  // Check the existing memories in the database
  return runtime.getMemoriesByRoomIds({
    tableName: 'messages',
    // filter out the current room id from rooms
    roomIds: rooms.filter((room) => room !== excludeRoomId),
    limit: 20,
  });
};

/**
 * A provider object that retrieves recent messages, interactions, and memories based on a given message.
 * @typedef {object} Provider
 * @property {string} name - The name of the provider ("RECENT_MESSAGES").
 * @property {string} description - A description of the provider's purpose ("Recent messages, interactions and other memories").
 * @property {number} position - The position of the provider (100).
 * @property {Function} get - Asynchronous function that retrieves recent messages, interactions, and memories.
 * @param {IAgentRuntime} runtime - The runtime context for the agent.
 * @param {Memory} message - The message to retrieve data from.
 * @returns {object} An object containing data, values, and text sections.
 */
export const recentMessagesProvider: Provider = {
  name: 'RECENT_MESSAGES',
  description: 'Recent messages, interactions and other memories',
  position: 100,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    const { roomId } = message;
    const conversationLength = runtime.getConversationLength();

    // Parallelize initial data fetching operations including recentInteractions
    const [entitiesData, room, recentMessagesData, recentInteractionsData] = await Promise.all([
      getEntityDetails({ runtime, roomId }),
      runtime.getRoom(roomId),
      runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: conversationLength,
        unique: false,
      }),
      message.entityId !== runtime.agentId
        ? getRecentInteractions(runtime, message.entityId, runtime.agentId, roomId)
        : Promise.resolve([]),
    ]);

    const isPostFormat = room?.type === ChannelType.FEED || room?.type === ChannelType.THREAD;

    // Format recent messages and posts in parallel
    const [formattedRecentMessages, formattedRecentPosts] = await Promise.all([
      formatMessages({
        messages: recentMessagesData,
        entities: entitiesData,
      }),
      formatPosts({
        messages: recentMessagesData,
        entities: entitiesData,
        conversationHeader: false,
      }),
    ]);

    // Create formatted text with headers
    const recentPosts =
      formattedRecentPosts && formattedRecentPosts.length > 0
        ? addHeader('# Posts in Thread', formattedRecentPosts)
        : '';

    const metaData = message.metadata as CustomMetadata;
    const senderName = metaData?.entityName || 'unknown';
    const receivedMessageContent = message.content.text;

    const receivedMessageHeader = addHeader(
      '# Received Message',
      `${senderName}: ${receivedMessageContent}`
    );

    const focusHeader = addHeader(
      '# ⚡ Focus your response',
      `You are replying to the above message from **${senderName}**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.`
    );

    const recentMessages =
      formattedRecentMessages && formattedRecentMessages.length > 0
        ? addHeader('# Conversation Messages', formattedRecentMessages)
        : '';

    // Preload all necessary entities for both types of interactions
    const interactionEntityMap = new Map<UUID, Entity>();

    // Only proceed if there are interactions to process
    if (recentInteractionsData.length > 0) {
      // Get unique entity IDs that aren't the runtime agent
      const uniqueEntityIds = [
        ...new Set(
          recentInteractionsData
            .map((message) => message.entityId)
            .filter((id) => id !== runtime.agentId)
        ),
      ];

      // Create a Set for faster lookup
      const uniqueEntityIdSet = new Set(uniqueEntityIds);

      // Add entities already fetched in entitiesData to the map
      const entitiesDataIdSet = new Set<UUID>();
      entitiesData.forEach((entity) => {
        if (uniqueEntityIdSet.has(entity.id)) {
          interactionEntityMap.set(entity.id, entity);
          entitiesDataIdSet.add(entity.id);
        }
      });

      // Get the remaining entities that weren't already loaded
      // Use Set difference for efficient filtering
      const remainingEntityIds = uniqueEntityIds.filter((id) => !entitiesDataIdSet.has(id));

      // Only fetch the entities we don't already have
      if (remainingEntityIds.length > 0) {
        const entities = await Promise.all(
          remainingEntityIds.map((entityId) => runtime.getEntityById(entityId))
        );

        entities.forEach((entity, index) => {
          if (entity) {
            interactionEntityMap.set(remainingEntityIds[index], entity);
          }
        });
      }
    }

    // Format recent message interactions
    const getRecentMessageInteractions = async (
      recentInteractionsData: Memory[]
    ): Promise<string> => {
      // Format messages using the pre-fetched entities
      const formattedInteractions = recentInteractionsData.map((message) => {
        const isSelf = message.entityId === runtime.agentId;
        let sender: string;

        if (isSelf) {
          sender = runtime.character.name;
        } else {
          sender = interactionEntityMap.get(message.entityId)?.metadata?.username || 'unknown';
        }

        return `${sender}: ${message.content.text}`;
      });

      return formattedInteractions.join('\n');
    };

    // Format recent post interactions
    const getRecentPostInteractions = async (
      recentInteractionsData: Memory[],
      entities: Entity[]
    ): Promise<string> => {
      // Combine pre-loaded entities with any other entities
      const combinedEntities = [...entities];

      // Add entities from interactionEntityMap that aren't already in entities
      const actorIds = new Set(entities.map((entity) => entity.id));
      for (const [id, entity] of interactionEntityMap.entries()) {
        if (!actorIds.has(id)) {
          combinedEntities.push(entity);
        }
      }

      const formattedInteractions = formatPosts({
        messages: recentInteractionsData,
        entities: combinedEntities,
        conversationHeader: true,
      });

      return formattedInteractions;
    };

    // Process both types of interactions in parallel
    const [recentMessageInteractions, recentPostInteractions] = await Promise.all([
      getRecentMessageInteractions(recentInteractionsData),
      getRecentPostInteractions(recentInteractionsData, entitiesData),
    ]);

    const data = {
      recentMessages: recentMessagesData,
      recentInteractions: recentInteractionsData,
    };

    const values = {
      recentPosts,
      recentMessages,
      recentMessageInteractions,
      recentPostInteractions,
      recentInteractions: isPostFormat ? recentPostInteractions : recentMessageInteractions,
    };

    // Combine all text sections
    const text = [isPostFormat ? recentPosts : recentMessages + receivedMessageHeader + focusHeader]
      .filter(Boolean)
      .join('\n\n');

    return {
      data,
      values,
      text,
    };
  },
};
