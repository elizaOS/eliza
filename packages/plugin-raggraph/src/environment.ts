import { z } from "zod";
import { IAgentRuntime } from "@ai16z/eliza";

export const raggraphEnvSchema = z.object({
    NEO4J_URI: z.string(),
    NEO4J_USER: z.string(),
    NEO4J_PASSWORD: z.string(),
});

export type RaggraphConfig = z.infer<typeof raggraphEnvSchema>;

export async function validateRaggraphConfig(
    runtime: IAgentRuntime
): Promise<RaggraphConfig> {
    try {
        const config = {
            NEO4J_URI: runtime.getSetting("NEO4J_URI") || process.env.NEO4J_URI,
            NEO4J_USER:
                runtime.getSetting("NEO4J_USER") || process.env.NEO4J_USER,
            NEO4J_PASSWORD:
                runtime.getSetting("NEO4J_PASSWORD") ||
                process.env.NEO4J_PASSWORD,
        };

        return raggraphEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Raggraph configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
