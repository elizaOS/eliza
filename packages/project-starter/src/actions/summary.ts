import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type Content,
  type HandlerCallback,
  ModelType,
  composePromptFromState,
  getEntityDetails,
  type Media,
  createUniqueUuid,
  type UUID,
  logger,
} from '@elizaos/core';
import type { Message as DiscordMessage } from 'discord.js';

// Template for summarizing daily channel activity
const dailySummaryTemplate = `# Conversation Messages (last 24 hours)
{{formattedMessages}}

# Instructions
You are creating a professional daily summary for Discord. Your goal is to summarize conversations clearly and concisely while properly attributing statements to specific users.

**FORMATTING RULES:**
- NEVER use emojis anywhere in your response
- NEVER use brackets [ ] around links or anywhere else
- NEVER add any symbols or decorations to links
- Discord links should appear naturally in the text as: https://discord.com/channels/{{guildId}}/{{channelId}}/messageId
- Use Discord markdown for structure: **bold** for headers, • for bullet points
- Keep everything clean and minimal

**USER ATTRIBUTION RULES:**
- When mentioning discussions, naturally include who said what (e.g., "Ruby reported new developments...")
- For action items: Simply format as "Task description - assigned to Username"
- Keep usernames simple, no @ symbols or parentheses unless necessary
- Be concise - don't repeat usernames unnecessarily
- If multiple people agree on something, list them once (e.g., "The team including Laura, Jimmy, and EddyDevRel agreed...")

**CONTENT STRUCTURE:**

**Key Topics Discussed:**
• Main topic with natural attribution of who raised it
• Another discussion point mentioning the participants https://discord.com/channels/{{guildId}}/{{channelId}}/messageId
• Third topic with clear but concise user mentions

**Important Decisions/Conclusions:**
• Decision reached by specific users on topic X
• Agreement between named participants on Y

**Action Items:**
• Clear task description - assigned to Username
• Another task - assigned to Username2

**CRITICAL RULES:**
1. Each bullet point must be ONE concise sentence
2. Include Discord message links naturally within the text
3. NO emojis, NO brackets, NO special characters
4. Professional tone throughout
5. Focus only on the most important 20% of activity
6. Always attribute messages and actions to specific users, but keep it natural and readable

Remember: Clean, professional, concise. Natural user attribution without cluttering the format.`;

/**
 * Converts Discord messages to Memory format
 * @param runtime - The agent runtime instance
 * @param messages - Array of Discord messages to convert
 * @param roomId - The room ID to assign to the memories
 * @returns Array of Memory objects
 */
function convertDiscordMessagesToMemories(
  runtime: IAgentRuntime,
  messages: DiscordMessage[],
  roomId: UUID
): Memory[] {
  return messages.map((msg) => ({
    id: createUniqueUuid(runtime, msg.id) as UUID,
    entityId: createUniqueUuid(runtime, msg.author.id) as UUID,
    agentId: runtime.agentId,
    roomId,
    content: {
      text: msg.content,
      source: 'discord',
      attachments: msg.attachments.map((attachment) => ({
        id: attachment.id,
        url: attachment.url,
        title: attachment.name || 'Attachment',
      })) as Media[],
    },
    metadata: {
      type: 'message',
      entityName: msg.author.displayName || msg.author.username,
      username: msg.author.username,
      discriminator: msg.author.discriminator,
      discordMessageId: msg.id,
    },
    createdAt: msg.createdTimestamp,
  }));
}

export const dailyChannelSummary: Action = {
  name: 'DAILY_CHANNEL_SUMMARY',
  similes: ['DAILY_SUMMARY', 'CHANNEL_DIGEST', 'DAILY_REPORT'],
  description: 'Generates a daily summary of channel activity',
  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    // TODO: consider to add validation here.
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<Memory[]> => {
    try {
      // Get configuration from options or environment
      const channelId = options?.channelId || runtime.getSetting('DAILY_SUMMARY_CHANNEL_ID');
      const guildId = options?.guildId || runtime.getSetting('DISCORD_GUILD_ID');
      const messageLimit = options?.messageLimit || 500;
      const hoursToSummarize = options?.hoursToSummarize || 24;

      logger.info(`Daily summary config - channelId: ${channelId}, guildId: ${guildId}`);

      if (!channelId) {
        logger.error('No channel ID provided for daily summary');
        return [];
      }

      if (!guildId) {
        logger.warn('No guild ID provided for daily summary - Discord message links will not work');
      }

      const roomId = createUniqueUuid(runtime, channelId) as UUID;

      let memories: Memory[] = [];

      // Always fetch directly from Discord
      logger.info('Fetching messages from Discord...');

      // Get Discord service from runtime - it should be available from the Discord plugin
      const discordService = runtime.getService('discord') as any;

      if (discordService && discordService.fetchChannelMessages) {
        const discordMessages = await discordService.fetchChannelMessages(
          channelId,
          messageLimit,
          hoursToSummarize
        );

        if (discordMessages.length > 0) {
          logger.info(`Fetched ${discordMessages.length} messages from Discord`);

          // Convert Discord messages to Memory format using the service method
          memories = convertDiscordMessagesToMemories(runtime, discordMessages, roomId);

          // Sort by creation time
          memories.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }
      } else {
        logger.error('Discord service not available for fetching messages');
        return [];
      }

      if (!memories || memories.length === 0) {
        logger.info('No messages found for daily summary');
        return [];
      }

      // Get entity details for proper attribution
      const entities = await getEntityDetails({
        runtime,
        roomId,
      });

      const actorMap = new Map(entities.map((entity) => [entity.id, entity]));

      // Format messages with attachments and Discord links
      const formattedMessages = memories
        .map((memory) => {
          const timestamp = new Date(memory.createdAt || 0).toLocaleTimeString();
          const author = actorMap.get(memory.entityId);
          const metadata = memory.metadata as any;
          const authorName = author?.name || metadata?.entityName || 'Unknown User';
          const authorUsername = author?.username || metadata?.username || '';

          // Get Discord message ID from metadata
          const messageId = metadata?.discordMessageId || '';
          const messageLink =
            messageId && guildId
              ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
              : '';

          let messageText = `[${timestamp}] ${authorName} (${authorUsername}): ${memory.content.text || ''}`;

          // Add Discord link if available - just append the raw URL
          if (messageLink) {
            messageText += ` ${messageLink}`;
          }

          // Include attachment descriptions
          if (memory.content.attachments && memory.content.attachments.length > 0) {
            const attachmentInfo = memory.content.attachments
              .map((attachment: Media) => {
                return `  Attachment: ${attachment.title || attachment.id}\n    ${attachment.description || 'No description'}\n    ${attachment.text || ''}`;
              })
              .join('\n');
            messageText += `\n${attachmentInfo}`;
          }

          return messageText;
        })
        .join('\n\n');

      // Prepare state for summarization
      const summaryState = state || (await runtime.composeState(message));
      summaryState.values = summaryState.values || {};
      summaryState.values.channelName = options?.channelName || 'core-dev';
      summaryState.values.summaryDate = new Date().toLocaleDateString();
      summaryState.values.messageCount = memories.length;
      summaryState.values.formattedMessages = formattedMessages;
      summaryState.values.guildId = guildId;
      summaryState.values.channelId = channelId;

      // Generate summary using the model
      const prompt = composePromptFromState({
        state: summaryState,
        template: dailySummaryTemplate,
      });

      const summary = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Format the final summary message
      const summaryHeader = `# 📊 Daily Channel Summary - ${summaryState.values.channelName}\n\n**Date**: ${summaryState.values.summaryDate}\n**Messages Analyzed**: ${summaryState.values.messageCount}\n**Time Period**: Last ${hoursToSummarize} hours\n\n---\n\n`;

      const finalSummary = summaryHeader + summary;

      // Create the response content
      const responseContent: Content = {
        text: finalSummary,
        actions: ['DAILY_SUMMARY_POSTED'],
        source: 'discord',
      };

      // Store the summary in memory for reference
      const summaryMemoryId = await runtime.createMemory(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content: {
            ...responseContent,
            metadata: {
              type: 'DAILY_CHANNEL_SUMMARY',
              channelId,
              summaryDate: summaryState.values.summaryDate,
              messageCount: summaryState.values.messageCount,
            },
          },
          createdAt: Date.now(),
        },
        'messages'
      );

      // Create the memory object
      const summaryMemory: Memory = {
        id: summaryMemoryId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId,
        content: responseContent,
        createdAt: Date.now(),
      };

      // Send the summary to the channel
      if (callback) {
        const result = await callback(responseContent);
        return result || [summaryMemory];
      }

      logger.info(
        `Daily summary generated for channel ${channelId} with ${memories.length} messages`
      );

      return [summaryMemory];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error generating daily channel summary:', errorMessage);

      // Create error memory
      const errorMemoryId = await runtime.createMemory(
        {
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content: {
            text: 'Failed to generate daily summary',
            thought: `Error: ${errorMessage}`,
            actions: ['DAILY_SUMMARY_FAILED'],
            source: 'discord',
          },
          metadata: {
            type: 'DAILY_CHANNEL_SUMMARY_ERROR',
            error: errorMessage,
          },
        },
        'messages'
      );

      const errorMemory: Memory = {
        id: errorMemoryId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: {
          text: 'Failed to generate daily summary',
          source: 'discord',
        },
        createdAt: Date.now(),
      };

      return [errorMemory];
    }
  },
  examples: [],
};

export default dailyChannelSummary;
