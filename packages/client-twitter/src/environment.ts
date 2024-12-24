import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const DEFAULT_MAX_TWEET_LENGTH = 280;

export const twitterEnvSchema = z.object({
    TWITTER_DRY_RUN: z
        .string()
        .transform((val) => val.toLowerCase() === "true"),
    TWITTER_USERNAME: z.string().min(1, "Twitter username is required"),
    TWITTER_PASSWORD: z.string().min(1, "Twitter password is required"),
    TWITTER_EMAIL: z.string().email("Valid Twitter email is required"),
    MAX_TWEET_LENGTH: z
        .string()
        .pipe(z.coerce.number().min(0).int())
        .default(DEFAULT_MAX_TWEET_LENGTH.toString()),
});

/**
 * Represents the configuration for Twitter settings.
 * This type is inferred from the 'twitterEnvSchema'.
 */
export type TwitterConfig = z.infer<typeof twitterEnvSchema>;

/**
 * Validates the Twitter configuration settings provided by the runtime and environment variables.
 * @param {IAgentRuntime} runtime - The runtime object containing the settings.
 * @returns {Promise<TwitterConfig>} - A promise that resolves with the validated Twitter configuration.
 */
export async function validateTwitterConfig(
    runtime: IAgentRuntime
): Promise<TwitterConfig> {
    try {
        const twitterConfig = {
            TWITTER_DRY_RUN:
                runtime.getSetting("TWITTER_DRY_RUN") ||
                process.env.TWITTER_DRY_RUN ||
                "false",
            TWITTER_USERNAME:
                runtime.getSetting("TWITTER_USERNAME") ||
                process.env.TWITTER_USERNAME,
            TWITTER_PASSWORD:
                runtime.getSetting("TWITTER_PASSWORD") ||
                process.env.TWITTER_PASSWORD,
            TWITTER_EMAIL:
                runtime.getSetting("TWITTER_EMAIL") ||
                process.env.TWITTER_EMAIL,
            MAX_TWEET_LENGTH:
                runtime.getSetting("MAX_TWEET_LENGTH") ||
                process.env.MAX_TWEET_LENGTH ||
                DEFAULT_MAX_TWEET_LENGTH.toString(),
        };

        return twitterEnvSchema.parse(twitterConfig);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Twitter configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
