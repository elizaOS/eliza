import type { IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';

export const telegramEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
});

/**
 * Represents the type definition for configuring a Telegram bot based on the inferred schema.
 */
export type TelegramConfig = z.infer<typeof telegramEnvSchema>;

/**
 * Validates the Telegram configuration by retrieving the Telegram bot token from the runtime settings or environment variables.
 * Returns null if validation fails instead of throwing an error.
 *
 * @param {IAgentRuntime} runtime - The agent runtime used to get the setting.
 * @returns {Promise<TelegramConfig | null>} A promise that resolves with the validated Telegram configuration or null if invalid.
 */
export async function validateTelegramConfig(
  runtime: IAgentRuntime
): Promise<TelegramConfig | null> {
  try {
    const config = {
      TELEGRAM_BOT_TOKEN:
        runtime.getSetting('TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN,
    };

    return telegramEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      console.warn(`Telegram configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}
