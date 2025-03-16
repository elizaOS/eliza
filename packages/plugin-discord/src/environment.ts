import type { IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';

export const discordEnvSchema = z.object({
  DISCORD_API_TOKEN: z.string().min(1, 'Discord API token is required'),
});

/**
 * Represents the type of Discord configuration settings inferred from the discordEnvSchema.
 */
export type DiscordConfig = z.infer<typeof discordEnvSchema>;

/**
 * Validates the Discord configuration by retrieving the Discord API token from the runtime settings
 * and parsing it with the Discord environment schema.
 *
 * @param {IAgentRuntime} runtime The agent runtime instance.
 * @returns {Promise<DiscordConfig>} A promise that resolves with the validated Discord configuration.
 * @throws {Error} If the Discord configuration validation fails, an error with detailed error messages is thrown.
 */

export async function validateDiscordConfig(runtime: IAgentRuntime): Promise<DiscordConfig> {
  try {
    const config = {
      DISCORD_API_TOKEN: runtime.getSetting('DISCORD_API_TOKEN'),
    };

    return discordEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Discord configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}
