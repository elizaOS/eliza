import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const mplBubblegumEnvSchema = z.object({
    MPL_BUBBLEGUM_PRIVATE_KEY: z
        .string()
        .min(1, "Private key for Bubblegum is required."),
    MPL_BUBBLEGUM_RPC_URL: z
        .string()
        .min(1, "Bubblegum RPC URL with DAS API support is required."),
});

export type MplBubblegumConfig = z.infer<typeof mplBubblegumEnvSchema>;

export async function validateMplBubblegumConfig(
    runtime: IAgentRuntime
): Promise<MplBubblegumConfig> {
    try {
        const config = {
            MPL_BUBBLEGUM_PRIVATE_KEY:
                runtime.getSetting("MPL_BUBBLEGUM_PRIVATE_KEY") ||
                process.env.MPL_BUBBLEGUM_PRIVATE_KEY,
            MPL_BUBBLEGUM_RPC_URL:
                runtime.getSetting("MPL_BUBBLEGUM_RPC_URL") ||
                process.env.MPL_BUBBLEGUM_RPC_URL,
        };

        return mplBubblegumEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Mpl Bubblegum configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
