import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const nodeEnvSchema = z.object({
    VITS_VOICE: z.string().optional(),
    VITS_MODEL: z.string().optional(),
});

export type NodeConfig = z.infer<typeof nodeEnvSchema>;

export async function validateNodeConfig(
    runtime: IAgentRuntime
): Promise<NodeConfig> {
    try {
        const voiceSettings = runtime.character.settings?.voice;

        // Only include what's absolutely required
        const config = {
            // VITS settings
            VITS_VOICE: voiceSettings?.model || process.env.VITS_VOICE,
            VITS_MODEL: process.env.VITS_MODEL,
        };

        return nodeEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Node configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
