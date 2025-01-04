import { IAgentRuntime } from "@elizaos/core";
import { isAddress } from "viem";
import { z } from "zod";

export const zksyncEnvSchema = z.object({
    ZKSYNC_ADDRESS: z
        .string()
        .min(1, "ZKsync Era address is required")
        .refine((address) => isAddress(address, { strict: false }), {
            message: "ZKsync Era address must be a valid address",
        }),
    ZKSYNC_PRIVATE_KEY: z
        .string()
        .min(1, "ZKsync Era private key is required")
        .refine((key) => /^[a-fA-F0-9]{64}$/.test(key), {
            message:
                "ZKsync Era private key must be a 64-character hexadecimal string (32 bytes) without the '0x' prefix",
        }),
});

export type ZKsyncConfig = z.infer<typeof zksyncEnvSchema>;

export async function validateZKsyncConfig(
    runtime: IAgentRuntime
): Promise<ZKsyncConfig> {
    try {
        const config = {
            ZKSYNC_ADDRESS:
                runtime.getSetting("ZKSYNC_ADDRESS") ||
                process.env.ZKSYNC_ADDRESS,
            ZKSYNC_PRIVATE_KEY:
                runtime.getSetting("ZKSYNC_PRIVATE_KEY") ||
                process.env.ZKSYNC_PRIVATE_KEY,
        };

        return zksyncEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `ZKsync configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
