import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const discordEnvSchema = z.object({
    DISCORD_APPLICATION_ID: z
        .string()
        .min(1, "Discord application ID is required"),
    DISCORD_API_TOKEN: z.string().min(1, "Discord API token is required"),
});

export type DiscordConfig = z.infer<typeof discordEnvSchema>;

export async function validateDiscordConfig(
    runtime: IAgentRuntime
): Promise<DiscordConfig> {
    try {
        const config = {
            DISCORD_APPLICATION_ID:
                runtime.getSetting("DISCORD_APPLICATION_ID"),
            DISCORD_API_TOKEN:
                runtime.getSetting("DISCORD_API_TOKEN"),
        };

        return discordEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Discord configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
