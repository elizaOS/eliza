import { IAgentRuntime } from "@elizaos/core";
import { isAddress } from "viem";
import { z } from "zod";

export const CronosZkEVMEnvSchema = z.object({
    CRONOSZKEVM_ADDRESS: z
        .string()
        .min(1, "Cronos zkEVM address is required")
        .refine((address) => isAddress(address, { strict: false }), {
            message: "Cronos zkEVM address must be a valid address",
        }),
    CRONOSZKEVM_PRIVATE_KEY: z
        .string()
        .min(1, "Cronos zkEVM private key is required")
        .refine((key) => /^[a-fA-F0-9]{64}$/.test(key), {
            message:
                "Cronos zkEVM private key must be a 64-character hexadecimal string (32 bytes) without the '0x' prefix",
        }),
});

export type CronoszkEVMConfig = z.infer<typeof CronosZkEVMEnvSchema>;

export async function validateCronosZkevmConfig(
    runtime: IAgentRuntime
): Promise<CronoszkEVMConfig> {
    try {
        const config = {
            CRONOSZKEVM_ADDRESS:
                runtime.getSetting("CRONOSZKEVM_ADDRESS") ||
                process.env.CRONOSZKEVM_ADDRESS,
            CRONOSZKEVM_PRIVATE_KEY:
                runtime.getSetting("CRONOSZKEVM_PRIVATE_KEY") ||
                process.env.CRONOSZKEVM_PRIVATE_KEY,
        };

        return CronosZkEVMEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `CronosZkEVM configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
