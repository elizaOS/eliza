import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const devaEnvSchema = z.object({
    DEVA_API_KEY: z.string().min(1, "Deva api key is required"),
});

export type DevaConfig = z.infer<typeof devaEnvSchema>;

export async function validateDevaConfig(
    runtime: IAgentRuntime
): Promise<DevaConfig> {
    try {
        const config = {
            DEVA_API_KEY:
                runtime.getSetting("DEVA_API_KEY") || process.env.DEVA_API_KEY,
        };

        return devaEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Deva configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
