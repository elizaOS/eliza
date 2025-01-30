import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const lensEnvSchema = z.object({
    LENS_ADDRESS: z.string().min(1, "LENS address is required"),
    LENS_PRIVATE_KEY: z.string().min(1, "LENS private key is required"),
});

export type LensConfig = z.infer<typeof lensEnvSchema>;

export async function validateLensConfig(
    runtime: IAgentRuntime
): Promise<LensConfig> {
    try {
        const config = {
            LENS_ADDRESS: runtime.getSetting("LENS_ADDRESS"),
            LENS_PRIVATE_KEY: runtime.getSetting("LENS_PRIVATE_KEY"),
        };

        return lensEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Lens configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
