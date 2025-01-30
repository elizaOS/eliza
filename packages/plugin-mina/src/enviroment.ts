import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const minaEnvSchema = z.object({
    MINA_PRIVATE_KEY: z.string().min(1, "Mina private key is required"),
    MINA_NETWORK: z.enum(["mainnet", "devnet", "localnet"]),
});

export type MinaConfig = z.infer<typeof minaEnvSchema>;

export async function validateMinaConfig(
    runtime: IAgentRuntime
): Promise<MinaConfig> {
    try {
        const config = {
            MINA_PRIVATE_KEY:
                runtime.getSetting("MINA_PRIVATE_KEY") ||
                process.env.MINA_PRIVATE_KEY,
            MINA_NETWORK:
                runtime.getSetting("MINA_NETWORK") || process.env.MINA_NETWORK,
        };

        return minaEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Mina configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
