import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const seiEnvSchema = z.object({
    SEI_PRIVATE_KEY: z.string().min(1, "Sui private key is required"),
    SEI_NETWORK: z.enum(["mainnet", "testnet", "devnet", "local"]),
});

export type SeiConfig = z.infer<typeof seiEnvSchema>;

export async function validateSeiConfig(
    runtime: IAgentRuntime
): Promise<SeiConfig> {
    try {
        const config = {
            SEI_PRIVATE_KEY:
                runtime.getSetting("SEI_PRIVATE_KEY") ||
                process.env.SEI_PRIVATE_KEY,
            SEI_NETWORK:
                runtime.getSetting("SEI_NETWORK") || process.env.SEI_NETWORK,
        };

        return seiEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Sei configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
