import { IAgentRuntime } from "@elizaos/core";
import { isAddress } from "viem";
import { z } from "zod";

export const abstractEnvSchema = z.object({
    ABSTRACT_ADDRESS: z
        .string()
        .min(1, "Abstract address is required")
        .refine((address) => isAddress(address, { strict: false }), {
            message: "Abstract address must be a valid address",
        }),
    ABSTRACT_PRIVATE_KEY: z
        .string()
        .min(1, "Abstract private key is required")
        .refine((key) => /^[a-fA-F0-9]{64}$/.test(key), {
            message:
                "Abstract private key must be a 64-character hexadecimal string (32 bytes) without the '0x' prefix",
        }),
});

export type AbstractConfig = z.infer<typeof abstractEnvSchema>;

export async function validateAbstractConfig(
    runtime: IAgentRuntime
): Promise<AbstractConfig> {
    try {
        const config = {
            ABSTRACT_ADDRESS: runtime.getSetting("ABSTRACT_ADDRESS"),
            ABSTRACT_PRIVATE_KEY: runtime.getSetting("ABSTRACT_PRIVATE_KEY"),
        };

        return abstractEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Abstract configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
