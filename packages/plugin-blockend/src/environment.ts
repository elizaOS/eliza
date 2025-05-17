import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const blockendEnvSchema = z
    .object({
        WALLET_KEYPAIR: z.string().min(1, "Wallet keypair is required"), // Solana public key
    })
    .required({
        WALLET_KEYPAIR: true,
    })
    .and(
        z
            .object({
                WALLET_PRIVATE_KEY: z
                    .string()
                    .min(1, "Wallet private key is required"), // EVM wallet public key
            })
            .required({
                WALLET_PRIVATE_KEY: true,
            })
    )
    .and(
        z
            .object({
                BLOCKEND_INTEGRATOR_ID: z.string(), // Blockend integrator ID
            })
            .required({
                BLOCKEND_INTEGRATOR_ID: true,
            })
    )
    .and(
        z
            .object({
                SOLANA_RPC_URL: z.string().optional(),
            })
            .required({
                SOLANA_RPC_URL: true,
            })
    );

export type BlockendConfig = z.infer<typeof blockendEnvSchema>;

export async function validateBlockendConfig(
    runtime: IAgentRuntime
): Promise<BlockendConfig> {
    try {
        const config = {
            WALLET_KEYPAIR:
                runtime.getSetting("WALLET_KEYPAIR") ||
                process.env.WALLET_KEYPAIR,
            WALLET_PRIVATE_KEY:
                runtime.getSetting("WALLET_PRIVATE_KEY") ||
                process.env.WALLET_PRIVATE_KEY,
            BLOCKEND_INTEGRATOR_ID:
                runtime.getSetting("BLOCKEND_INTEGRATOR_ID") ||
                process.env.BLOCKEND_INTEGRATOR_ID,
            SOLANA_RPC_URL:
                runtime.getSetting("SOLANA_RPC_URL") ||
                process.env.SOLANA_RPC_URL,
        };

        return blockendEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Blockend configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
