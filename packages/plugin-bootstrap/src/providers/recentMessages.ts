import {
  addHeader,
  ChannelType,
  CustomMetadata,
  formatMessages,
  formatPosts,
  parseBooleanFromText,
  processEntitiesForRoom,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  type UUID,
  logger,
} from '@elizaos/core';

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
 * Build entity details from room entities (optimized version without extra room fetch).
 * Uses the shared processEntitiesForRoom() from core to deduplicate and merge component data.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} roomId - The room ID.
 * @param {Pick<{ source?: string }, 'source'> | null} room - The pre-fetched room object to avoid duplicate fetch.
 * @returns {Promise<Entity[]>} Array of entity details.
 */
const getEntityDetailsWithRoom = async (
  runtime: IAgentRuntime,
  roomId: UUID,
  room: Pick<{ source?: string }, 'source'> | null
): Promise<Entity[]> => {
  const roomEntities = await runtime.getEntitiesForRoom(roomId, true);
  return processEntitiesForRoom(roomEntities, room?.source);
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
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Early validation - fail fast before any IO
    const { roomId } = message;
    if (!roomId) {
      logger.warn(
        { src: 'plugin:bootstrap:provider:recent-messages', agentId: runtime.agentId },
        'No roomId in message'
      );
      return { data: {}, values: {}, text: '' };
    }

    try {
      const conversationLength = runtime.getConversationLength();

      // Check if we should limit to only the last message
      const limitMessagesSetting = runtime.getSetting('LIMIT_TO_LAST_MESSAGE');
      const limitToLastMessage =
        limitMessagesSetting === true ||
        (typeof limitMessagesSetting === 'string'
          ? parseBooleanFromText(limitMessagesSetting)
          : limitMessagesSetting != null
            ? parseBooleanFromText(String(limitMessagesSetting))
            : false);
      const effectiveConversationLength = limitToLastMessage ? 1 : conversationLength;

      // Try to get room and entities from previous provider results (ENTITIES provider runs before us)
      // Safe access with explicit type checking - provider may not have run
      const entitiesProviderResult = state?.data?.providers?.ENTITIES;
      const entitiesProviderData =
        entitiesProviderResult &&
        typeof entitiesProviderResult === 'object' &&
        'data' in entitiesProviderResult
          ? (entitiesProviderResult.data as {
              room?: { type?: string; source?: string };
              entitiesData?: Entity[];
            })
          : undefined;

      // Only use cached data if it exists and is valid
      const cachedRoom = entitiesProviderData?.room;
      const cachedEntities = Array.isArray(entitiesProviderData?.entitiesData)
        ? entitiesProviderData.entitiesData
        : undefined;

      // Fetch room only if not in cache
      const [room, recentMessagesData, recentInteractionsData] = await Promise.all([
        cachedRoom ? Promise.resolve(cachedRoom) : runtime.getRoom(roomId),
        runtime.getMemories({
          tableName: 'messages',
          roomId,
          count: effectiveConversationLength,
          unique: false,
        }),
        message.entityId !== runtime.agentId
          ? getRecentInteractions(runtime, message.entityId, runtime.agentId, roomId)
          : Promise.resolve([]),
      ]);

      // Get entity details - use cache if available and valid, otherwise fetch
      const entitiesData =
        cachedEntities ?? (await getEntityDetailsWithRoom(runtime, roomId, room));

      // Build entity lookup map for O(1) access during formatting
      const entityMap = new Map<UUID, Entity>();
      for (const entity of entitiesData) {
        if (entity.id) {
          entityMap.set(entity.id, entity);
        }
      }

      // Separate action results from regular messages
      const actionResultMessages = recentMessagesData.filter(
        (msg) => msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result'
      );

      const dialogueMessages = recentMessagesData.filter(
        (msg) => !(msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result')
      );

      // Default to message format if room is not found or type is undefined
      const isPostFormat = room?.type
        ? room.type === ChannelType.FEED || room.type === ChannelType.THREAD
        : false;

      // Only format the type that will actually be used (optimization: avoid formatting both)
      let formattedRecentMessages = '';
      let formattedRecentPosts = '';

      if (isPostFormat) {
        formattedRecentPosts = formatPosts({
          messages: dialogueMessages,
          entities: entitiesData,
          conversationHeader: false,
        });
      } else {
        formattedRecentMessages = formatMessages({
          messages: dialogueMessages,
          entities: entitiesData,
        });
      }

      // Format action results separately
      let actionResultsText = '';
      if (actionResultMessages.length > 0) {
        // Group by runId using Map
        const groupedByRun = new Map<string, Memory[]>();

        for (const mem of actionResultMessages) {
          const runId: string = String(mem.content?.runId || 'unknown');
          if (!groupedByRun.has(runId)) {
            groupedByRun.set(runId, []);
          }
          const memories = groupedByRun.get(runId);
          if (memories) {
            memories.push(mem);
          }
        }

        const formattedActionResults = Array.from(groupedByRun.entries())
          .slice(-3) // Show last 3 runs
          .map(([runId, memories]) => {
            const sortedMemories = memories.sort(
              (a: Memory, b: Memory) => (a.createdAt || 0) - (b.createdAt || 0)
            );

            const thought = sortedMemories[0]?.content?.planThought || '';
            const runText = sortedMemories
              .map((mem: Memory) => {
                const actionName = mem.content?.actionName || 'Unknown';
                const status = mem.content?.actionStatus || 'unknown';
                const planStep = mem.content?.planStep || '';
                const text = mem.content?.text || '';
                const error = mem.content?.error || '';

                let memText = `  - ${actionName} (${status})`;
                if (planStep) {
                  memText += ` [${planStep}]`;
                }
                if (error) {
                  memText += `: Error - ${error}`;
                } else if (text && text !== `Executed action: ${actionName}`) {
                  memText += `: ${text}`;
                }

                return memText;
              })
              .join('\n');

            return `**Action Run ${runId.slice(0, 8)}**${thought ? ` - "${thought}"` : ''}\n${runText}`;
          })
          .join('\n\n');

        actionResultsText = formattedActionResults
          ? addHeader('# Recent Action Executions', formattedActionResults)
          : '';
      }

      // Create formatted text with headers
      const recentPosts =
        formattedRecentPosts && formattedRecentPosts.length > 0
          ? addHeader('# Posts in Thread', formattedRecentPosts)
          : '';

      const recentMessages =
        formattedRecentMessages && formattedRecentMessages.length > 0
          ? addHeader('# Conversation Messages', formattedRecentMessages)
          : '';

      // If there are no messages at all, and no current message to process, return a specific message.
      // The check for dialogueMessages.length === 0 ensures we only show this if there's truly nothing.
      if (
        !recentPosts &&
        !recentMessages &&
        dialogueMessages.length === 0 &&
        !message.content.text
      ) {
        return {
          data: {
            recentMessages: dialogueMessages,
            recentInteractions: [],
            actionResults: actionResultMessages,
          },
          values: {
            recentPosts: '',
            recentMessages: '',
            recentMessageInteractions: '',
            recentPostInteractions: '',
            recentInteractions: '',
            recentActionResults: actionResultsText,
          },
          text: 'No recent messages available',
        };
      }

      let recentMessage = 'No recent message available.';

      if (dialogueMessages.length > 0) {
        // Get the most recent dialogue message (messages are sorted newest first after getMemories)
        const mostRecentMessage = [...dialogueMessages].sort(
          (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
        )[0];

        // Inline format for the most recent message (avoids redundant formatMessages call)
        const senderEntity = entityMap.get(mostRecentMessage.entityId);
        const senderName = senderEntity?.names[0] || 'Unknown User';
        const messageText = mostRecentMessage.content?.text || '';
        const messageThought = mostRecentMessage.content?.thought;

        if (messageText || messageThought) {
          const parts: string[] = [];
          if (messageText) {
            parts.push(`${senderName}: ${messageText}`);
          }
          if (messageThought) {
            parts.push(`(${senderName}'s internal thought: ${messageThought})`);
          }
          recentMessage = parts.join('\n');
        }
      }

      const metaData = message.metadata as CustomMetadata;
      const currentSenderName =
        entityMap.get(message.entityId)?.names[0] || metaData?.entityName || 'Unknown User';
      const receivedMessageContent = message.content.text;

      const hasReceivedMessage = !!receivedMessageContent?.trim();

      const receivedMessageHeader = hasReceivedMessage
        ? addHeader('# Received Message', `${currentSenderName}: ${receivedMessageContent}`)
        : '';

      const focusHeader = hasReceivedMessage
        ? addHeader(
            '# Focus your response',
            `You are replying to the above message from **${currentSenderName}**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.`
          )
        : '';

      // Use the existing entityMap for interaction lookups, only fetch missing entities
      const interactionEntityMap = new Map<UUID, Entity>(entityMap);

      // Only proceed if there are interactions to process
      if (recentInteractionsData.length > 0) {
        // Get unique entity IDs that aren't the runtime agent and not already in our map
        const missingEntityIds = [
          ...new Set(
            recentInteractionsData
              .map((msg) => msg.entityId)
              .filter((id) => id !== runtime.agentId && !entityMap.has(id))
          ),
        ];

        // Only fetch the entities we don't already have
        if (missingEntityIds.length > 0) {
          const entities = await Promise.all(
            missingEntityIds.map((entityId) => runtime.getEntityById(entityId))
          );

          entities.forEach((entity, index) => {
            if (entity) {
              interactionEntityMap.set(missingEntityIds[index], entity);
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
            sender =
              (interactionEntityMap.get(message.entityId)?.metadata?.userName as string) ||
              'unknown';
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
        recentMessages: dialogueMessages,
        recentInteractions: recentInteractionsData,
        actionResults: actionResultMessages,
      };

      const values = {
        recentPosts,
        recentMessages,
        recentMessageInteractions,
        recentPostInteractions,
        recentInteractions: isPostFormat ? recentPostInteractions : recentMessageInteractions,
        recentActionResults: actionResultsText,
        recentMessage,
      };

      // Combine all text sections
      const text = [
        isPostFormat ? recentPosts : recentMessages,
        actionResultsText, // Include action results in the text output
        // Only add received message and focus headers if there are messages or a current message to process
        recentMessages || recentPosts || message.content.text ? receivedMessageHeader : '',
        recentMessages || recentPosts || message.content.text ? focusHeader : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return {
        data,
        values,
        text,
      };
    } catch (error) {
      logger.error(
        {
          src: 'plugin:bootstrap:provider:recent_messages',
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error in recentMessagesProvider'
      );
      // Return a default state in case of error, similar to the empty message list
      return {
        data: {
          recentMessages: [],
          recentInteractions: [],
          actionResults: [],
        },
        values: {
          recentPosts: '',
          recentMessages: '',
          recentMessageInteractions: '',
          recentPostInteractions: '',
          recentInteractions: '',
          recentActionResults: '',
        },
        text: 'Error retrieving recent messages.', // Or 'No recent messages available' as the test expects
      };
    }
  },
};
