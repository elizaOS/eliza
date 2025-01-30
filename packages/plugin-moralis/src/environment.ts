import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const moralisEnvSchema = z.object({
    MORALIS_API_KEY: z.string().min(1, "Moralis API key is required"),
});

export type MoralisConfig = z.infer<typeof moralisEnvSchema>;

export async function validateMoralisConfig(
    runtime: IAgentRuntime
): Promise<MoralisConfig> {
    try {
        const config = {
            MORALIS_API_KEY: runtime.getSetting("MORALIS_API_KEY"),
        };
        return moralisEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Moralis configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
