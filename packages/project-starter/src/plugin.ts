import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, logger } from '@elizaos/core';
import { z } from 'zod';
import { dailyChannelSummary } from './actions/summary';
import { initializeDailyChannelSummaryTask } from './schedule/summary';

/**
 * Configuration schema for the Daily Summary plugin
 */
const configSchema = z.object({
  DAILY_SUMMARY_CHANNEL_ID: z.string().min(1, 'Daily summary channel ID is required').optional(),
  DAILY_SUMMARY_ENABLED: z.string().optional().default('disabled'), // Default to disabled if not specified
  DAILY_SUMMARY_CHANNEL_NAME: z.string().optional(),
  DAILY_SUMMARY_MESSAGE_LIMIT: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 500)),
  DAILY_SUMMARY_HOURS: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 24)),
  DAILY_SUMMARY_HOUR: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val) : 9)),
});

/**
 * Wait for Discord service to be available
 */
async function waitForDiscordService(
  runtime: IAgentRuntime,
  maxAttempts: number = 30,
  delayMs: number = 2000
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const discordService = runtime.getService('discord') as any;

    // Check if service exists and client is ready
    if (discordService && discordService.client && discordService.client.isReady()) {
      logger.info('Discord service is ready');
      return true;
    }

    if (attempt < maxAttempts - 1) {
      logger.info(
        `Waiting for Discord service to be ready... (attempt ${attempt + 1}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

const plugin: Plugin = {
  name: 'daily-summary',
  description: 'A plugin that provides daily channel summaries for Discord',
  // Depend on discord plugin to ensure it's loaded first
  dependencies: ['discord'],
  priority: 0,
  config: {
    DAILY_SUMMARY_CHANNEL_ID: process.env.DAILY_SUMMARY_CHANNEL_ID,
    DAILY_SUMMARY_ENABLED: process.env.DAILY_SUMMARY_ENABLED,
    DAILY_SUMMARY_CHANNEL_NAME: process.env.DAILY_SUMMARY_CHANNEL_NAME,
    DAILY_SUMMARY_MESSAGE_LIMIT: process.env.DAILY_SUMMARY_MESSAGE_LIMIT,
    DAILY_SUMMARY_HOURS: process.env.DAILY_SUMMARY_HOURS,
    DAILY_SUMMARY_HOUR: process.env.DAILY_SUMMARY_HOUR,
  },
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info('*** Initializing Daily Summary plugin ***');

    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Check if daily summary is enabled
      if (validatedConfig.DAILY_SUMMARY_ENABLED !== 'enabled') {
        logger.info(
          'Daily Summary is disabled (DAILY_SUMMARY_ENABLED is not set to "enabled") - Daily Summary plugin is loaded but task will not be scheduled'
        );
        logger.info(
          'To enable Daily Summary functionality, set DAILY_SUMMARY_ENABLED=enabled in your .env file'
        );
        return;
      }

      // Check if required channel ID is provided
      if (!validatedConfig.DAILY_SUMMARY_CHANNEL_ID) {
        logger.info(
          'Daily Summary Channel ID not provided - Daily Summary plugin is loaded but task will not be scheduled'
        );
        logger.info(
          'To enable Daily Summary functionality, please provide DAILY_SUMMARY_CHANNEL_ID in your .env file'
        );
        return;
      }

      logger.info('Daily Summary is enabled - scheduling task');

      // Start async initialization in background
      (async () => {
        try {
          logger.info('Starting async initialization of Daily Summary plugin...');

          // Wait for Discord service to be ready
          const isDiscordReady = await waitForDiscordService(runtime);

          if (!isDiscordReady) {
            logger.error(
              'Discord service did not become ready within timeout - Daily Summary task will not be scheduled'
            );
            return;
          }

          // Initialize the daily channel summary task
          logger.info('Discord service is ready, initializing daily channel summary task');
          await initializeDailyChannelSummaryTask(runtime);

          logger.info('Daily Summary plugin async initialization completed successfully');
        } catch (error) {
          logger.error('Error during Daily Summary plugin async initialization:', error);
        }
      })();

      // Return immediately to not block plugin loading
      logger.info('Daily Summary plugin init completed, task initialization running in background');
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Daily Summary plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  actions: [dailyChannelSummary],
  providers: [],
  services: [],
};

export default plugin;
