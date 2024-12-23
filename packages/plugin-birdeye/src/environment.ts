import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const birdeyeEnvSchema = z.object({
    BIRDEYE_API_KEY: z.string().min(1, "Birdeye API key is required"),
});

export type BirdeyeConfig = z.infer<typeof birdeyeEnvSchema>;

export async function validateBirdeyeConfig(
    runtime: IAgentRuntime
): Promise<BirdeyeConfig> {
    try {
        const config = {
            BIRDEYE_API_KEY:
                runtime.getSetting("BIRDEYE_API_KEY") ||
                process.env.BIRDEYE_API_KEY,
            BIRDEYE_WALLET_ADDR:
                runtime.getSetting("BIRDEYE_WALLET_ADDR") ||
                process.env.BIRDEYE_WALLET_ADDR,
        };

        return birdeyeEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Birdeye configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
