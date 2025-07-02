import {
  type IAgentRuntime,
  type Memory,
  type State,
  type Content,
  createUniqueUuid,
  type UUID,
  logger,
  type TargetInfo,
} from '@elizaos/core';
import { dailyChannelSummary } from '../actions/summary';

/**
 * Task worker for scheduled execution of daily channel summaries
 */
export const dailyChannelSummaryTask = {
  name: 'DAILY_CHANNEL_SUMMARY_TASK',
  description: 'Scheduled task to generate daily channel summaries',
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    // Check if it's time to run (this will be called by the task service)
    const channelId = runtime.getSetting('DAILY_SUMMARY_CHANNEL_ID');
    return !!channelId;
  },
  execute: async (runtime: IAgentRuntime, options: any): Promise<void> => {
    logger.info('[Daily Summary] Starting generation');

    const channelId = options?.channelId || runtime.getSetting('DAILY_SUMMARY_CHANNEL_ID');
    const roomId = createUniqueUuid(runtime, channelId) as UUID;

    // Create a mock message for the handler
    const mockMessage: Memory = {
      id: createUniqueUuid(runtime, `daily-summary-${Date.now()}`) as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: 'Generating daily summary',
        source: 'discord',
      },
      createdAt: Date.now(),
    };

    // Execute the daily summary action
    await dailyChannelSummary.handler(
      runtime,
      mockMessage,
      await runtime.composeState(mockMessage),
      {
        channelId,
        channelName: options?.channelName || 'channel',
        messageLimit: options?.messageLimit || 500,
        hoursToSummarize: options?.hoursToSummarize || 24,
        guildId: runtime.getSetting('DISCORD_GUILD_ID'),
      },
      // Callback to post the summary - this sends the message to Discord
      async (content: Content): Promise<Memory[]> => {
        try {
          // Get the Discord service to send the message
          const discordService = runtime.getService('discord') as any;

          if (!discordService || !discordService.handleSendMessage) {
            throw new Error('Discord service not available');
          }

          // Use the Discord service's handleSendMessage method
          const targetInfo: TargetInfo = {
            channelId,
            source: 'discord',
            // No entityId needed for channel messages
          };

          await discordService.handleSendMessage(runtime, targetInfo, content);

          logger.info(`[Daily Summary] Posted to channel ${channelId}`);

          const memory: Memory = {
            id: createUniqueUuid(runtime, `summary-sent-${Date.now()}`) as UUID,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId,
            content,
            createdAt: Date.now(),
          };

          return [memory];
        } catch (error) {
          logger.error(`[Daily Summary] Failed to send: ${error}`);
          throw error;
        }
      }
    );

    logger.info('[Daily Summary] Generation completed');
  },
};

/**
 * Initialize the daily channel summary task
 */
export async function initializeDailyChannelSummaryTask(runtime: IAgentRuntime): Promise<void> {
  // Wait for rooms to be created to avoid worldId errors
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Register the task worker
  runtime.registerTaskWorker(dailyChannelSummaryTask);

  // Check if daily summary is configured
  const channelId = runtime.getSetting('DAILY_SUMMARY_CHANNEL_ID');
  if (!channelId) {
    logger.debug('[Daily Summary] No DAILY_SUMMARY_CHANNEL_ID configured, skipping task creation');
    return;
  }

  // Check if task already exists
  const existingTasks = await runtime.getTasksByName('DAILY_CHANNEL_SUMMARY_TASK');
  if (existingTasks.length > 0) {
    logger.debug('[Daily Summary] Task already exists, skipping creation');
    return;
  }

  // Get configuration from settings
  const channelName = runtime.getSetting('DAILY_SUMMARY_CHANNEL_NAME') || 'channel';
  const messageLimit = parseInt(runtime.getSetting('DAILY_SUMMARY_MESSAGE_LIMIT') || '1000');
  const hoursToSummarize = parseInt(runtime.getSetting('DAILY_SUMMARY_HOURS') || '03');
  const scheduledHour = parseInt(runtime.getSetting('DAILY_SUMMARY_HOUR') || '00');
  const scheduledMinute = parseInt(runtime.getSetting('DAILY_SUMMARY_MINUTE') || '00');

  // Get world ID for the task
  const roomId = createUniqueUuid(runtime, channelId) as UUID;
  const room = await runtime.getRoom(roomId);

  // Format time for display
  const timeString = `${scheduledHour.toString().padStart(2, '0')}:${scheduledMinute.toString().padStart(2, '0')} UTC`;

  console.log('#### SCHEDULED HOUR', scheduledHour);
  console.log('#### SCHEDULED MINUTE', scheduledMinute);

  // Create the task
  await runtime.createTask({
    name: 'DAILY_CHANNEL_SUMMARY_TASK',
    description: `Daily summary for ${channelName} channel at ${timeString}`,
    worldId: room?.worldId,
    metadata: {
      updatedAt: 0, // First run indicator
      updateInterval: 24 * 60 * 60 * 1000, // 24 hours - prevents multiple runs
      channelId,
      channelName,
      messageLimit,
      hoursToSummarize,
      scheduledHour,
      scheduledMinute,
    },
    tags: ['queue', 'repeat'],
  });

  logger.info(`[Daily Summary] Task created for ${channelName} channel at ${timeString}`);
}
