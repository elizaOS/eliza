import { z } from "zod";
import type { IAgentRuntime } from "@elizaos/core";

export const devinEnvSchema = z.object({
    DEVIN_API_TOKEN: z.string().min(1, "Devin API token is required"),
});

export type DevinConfig = z.infer<typeof devinEnvSchema>;

export async function validateDevinConfig(
    runtime: IAgentRuntime
): Promise<DevinConfig> {
    try {
        const config = {
            DEVIN_API_TOKEN:
                runtime.getSetting("DEVIN_API_TOKEN") ||
                process.env.DEVIN_API_TOKEN,
        };

        return devinEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Devin configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
