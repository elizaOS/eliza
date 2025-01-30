import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const multiversxEnvSchema = z.object({
    MVX_PRIVATE_KEY: z
        .string()
        .min(1, "MultiversX wallet private key is required"),
    MVX_NETWORK: z.enum(["mainnet", "devnet", "testnet"]),
});

export type MultiversxConfig = z.infer<typeof multiversxEnvSchema>;

export async function validateMultiversxConfig(
    runtime: IAgentRuntime,
): Promise<MultiversxConfig> {
    try {
        const config = {
            MVX_PRIVATE_KEY:
                runtime.getSetting("MVX_PRIVATE_KEY") ||
                process.env.MVX_PRIVATE_KEY,
            MVX_NETWORK:
                runtime.getSetting("MVX_NETWORK") || process.env.MVX_NETWORK,
        };

        return multiversxEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `MultiversX configuration validation failed:\n${errorMessages}`,
            );
        }
        throw error;
    }
}
