import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const ethstorageEnvSchema = z.object({
    ETHSTORAGE_PRIVATE_KEY: z.string().min(1, "EthStorage private key is required"),
    ETHSTORAGE_ADDRESS: z.string().min(1, "EthStorage address is required"),
    ETHSTORAGE_RPC_URL: z.string().min(1, "EthStorage RPC url is required"),
});

export type ethstorageConfig = z.infer<typeof ethstorageEnvSchema>;

export async function ethstorageConfig(
    runtime: IAgentRuntime
): Promise<ethstorageConfig> {
    try {
        const config = {
            ETHSTORAGE_PRIVATE_KEY:
                runtime.getSetting("ETHSTORAGE_PRIVATE_KEY") || process.env.ETHSTORAGE_PRIVATE_KEY,
            ETHSTORAGE_ADDRESS:
                runtime.getSetting("ETHSTORAGE_ADDRESS") || process.env.ETHSTORAGE_ADDRESS,
            ETHSTORAGE_RPC_URL:
                runtime.getSetting("ETHSTORAGE_RPC_URL") || process.env.ETHSTORAGE_RPC_URL,
        };

        return ethstorageEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `EthStorage configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
