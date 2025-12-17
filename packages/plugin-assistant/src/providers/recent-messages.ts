import {
  addHeader,
  ChannelType,
  CustomMetadata,
  formatMessages,
  formatPosts,
  getEntityDetails,
  MemoryType,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  logger,
} from '@elizaos/core';

/**
 * Helper to extract the display name from an entity.
 * Priority order:
 * 1. metadata.web.userName
 * 2. metadata.web.name
 * 3. names[0]
 */
function getEntityDisplayName(entity: Entity): string {
  try {
    // Parse metadata if it's stored in data field as string
    let metadata: Record<string, unknown> | undefined;

    if (typeof (entity as any).data === 'string') {
      metadata = JSON.parse((entity as any).data);
    } else if (entity.metadata) {
      metadata = entity.metadata as Record<string, unknown>;
    }

    // Try to get from metadata.web.userName first
    if (metadata?.web && typeof metadata.web === 'object') {
      const webMetadata = metadata.web as Record<string, unknown>;
      if (webMetadata.userName && typeof webMetadata.userName === 'string') {
        return webMetadata.userName;
      }
      // Fall back to metadata.web.name
      if (webMetadata.name && typeof webMetadata.name === 'string') {
        return webMetadata.name;
      }
    }
  } catch (e) {
    // If parsing fails, fall through to names[0]
  }

  // Final fallback to names[0]
  return entity.names[0] || 'Unknown';
}

/**
 * Helper to check if a Memory message is a dialogue message (not an action result).
 * Action results have both content.type and metadata.type set to 'action_result'.
 */
function isDialogueMessage(msg: Memory): boolean {
  return !(msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result');
}

/**
 * Recent Messages Provider
 *
 * Provides recent conversation messages with detailed context.
 * Fetches the most recent unsummarized messages from the conversation.
 *
 * Values returned:
 * - recentMessages: Formatted recent messages
 * - conversationLog: Simple timestamped conversation log
 * - conversationLogWithAgentThoughts: Conversation log including agent's internal thoughts
 * - receivedMessageHeader: Header showing the current message being responded to
 * - focusHeader: Instruction to focus response on the received message
 */
export const recentMessagesProvider: Provider = {
  name: 'RECENT_MESSAGES',
  description: 'Provides recent conversation messages with detailed context',
  position: 94,

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const memoryService = runtime.getService('memory') as any;
      const { roomId } = message;

      // Get configuration
      const config = memoryService?.getConfig() || {
        shortTermSummarizationThreshold: 16,
        shortTermRetainRecent: 6,
      };

      // Get conversation length setting
      const conversationLength = runtime.getConversationLength();

      // Determine how many messages to fetch and from where
      let messagesToFetch = config.shortTermRetainRecent;
      let startOffset = 0;

      // Check if we have a summary to determine offset and whether to use summarization mode
      let hasSummary = false;
      if (memoryService) {
        const currentSummary = await memoryService.getCurrentSessionSummary(roomId);
        if (currentSummary) {
          hasSummary = true;
          // When we have a summary, fetch recent messages after the summary offset
          startOffset = currentSummary.lastMessageOffset || 0;
        }
      }

      // If no summary exists, check if we should show all messages or just recent ones
      if (!hasSummary) {
        // Get all messages to count dialogue messages
        const allMessages = await runtime.getMemories({
          tableName: 'messages',
          roomId,
          count: conversationLength,
          unique: false,
        });

        const dialogueMessageCount = allMessages.filter(isDialogueMessage).length;

        // If below threshold, show all messages; otherwise show recent only
        if (dialogueMessageCount < config.shortTermSummarizationThreshold) {
          messagesToFetch = conversationLength;
        }
      }

      // Parallelize data fetching
      const [entitiesData, room, recentMessagesData] = await Promise.all([
        getEntityDetails({ runtime, roomId }),
        runtime.getRoom(roomId),
        runtime.getMemories({
          tableName: 'messages',
          roomId,
          count: messagesToFetch,
          unique: false,
          start: startOffset,
        }),
      ]);

      // Determine format based on room type
      const isPostFormat = room?.type
        ? room.type === ChannelType.FEED || room.type === ChannelType.THREAD
        : false;

      // Separate action results from regular dialogue messages
      // Action results have both content.type and metadata.type set to 'action_result'
      const actionResultMessages = recentMessagesData.filter(
        (msg) => msg.content?.type === 'action_result' && msg.metadata?.type === 'action_result'
      );

      // Filter to dialogue messages only (exclude action results)
      const dialogueMessages = recentMessagesData.filter(isDialogueMessage);

      // Format recent messages
      let recentMessagesText = '';
      if (dialogueMessages.length > 0) {
        if (isPostFormat) {
          recentMessagesText = formatPosts({
            messages: dialogueMessages,
            entities: entitiesData,
            conversationHeader: false,
          });
        } else {
          recentMessagesText = formatMessages({
            messages: dialogueMessages,
            entities: entitiesData,
          });
        }

        if (recentMessagesText) {
          recentMessagesText = addHeader('# Recent Messages', recentMessagesText);
        }
      }

      // Format conversation logs (simple format without IDs)
      const formatConversationLog = (messages: Memory[], includeThoughts: boolean): string => {
        return messages
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
          .map((msg) => {
            const entity = entitiesData.find((e: Entity) => e.id === msg.entityId);
            const entityName = entity
              ? getEntityDisplayName(entity)
              : msg.entityId === runtime.agentId
                ? runtime.character.name
                : 'Unknown';
            const timestamp = msg.createdAt
              ? new Date(msg.createdAt).toLocaleString()
              : 'Unknown time';

            const text = msg.content.text || '';
            const thought =
              includeThoughts && msg.content.thought
                ? `\n  [Internal thought: ${msg.content.thought}]`
                : '';

            return `[${timestamp}] ${entityName}: ${text}${thought}`;
          })
          .join('\n');
      };

      const conversationLog = addHeader(
        '# Conversation Messages',
        formatConversationLog(dialogueMessages, false)
      );
      const conversationLogWithAgentThoughts = addHeader(
        '# Conversation Messages',
        formatConversationLog(dialogueMessages, true)
      );

      // Build received message header
      const metaData = message.metadata as CustomMetadata;
      const senderEntity = entitiesData.find((entity: Entity) => entity.id === message.entityId);
      const senderName = senderEntity
        ? getEntityDisplayName(senderEntity)
        : metaData?.entityName || 'Unknown User';
      const receivedMessageContent = message.content.text;
      const hasReceivedMessage = !!receivedMessageContent?.trim();

      const receivedMessageHeader = hasReceivedMessage
        ? addHeader('# Received Message', `${senderName}: ${receivedMessageContent}`)
        : '';

      const focusHeader = hasReceivedMessage
        ? addHeader(
            '# Focus your response',
            `You are replying to the above message from **${senderName}**. Keep your answer relevant to that message.`
          )
        : '';

      // Combine sections for text output
      const text = [recentMessagesText, receivedMessageHeader, focusHeader]
        .filter(Boolean)
        .join('\n\n');

      return {
        data: {
          messages: dialogueMessages,
        },
        values: {
          recentMessages: recentMessagesText,
          conversationLog,
          conversationLogWithAgentThoughts,
          ...(receivedMessageHeader && { receivedMessageHeader }),
          ...(focusHeader && { focusHeader }),
        },
        text,
      };
    } catch (error) {
      logger.error({ error }, 'Error in recentMessagesProvider:');
      return {
        data: {
          messages: [],
        },
        values: {
          recentMessages: '',
          conversationLog: '',
          conversationLogWithAgentThoughts: '',
          receivedMessageHeader: '',
          focusHeader: '',
        },
        text: '',
      };
    }
  },
};
