import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const jeeterEnvSchema = z.object({
    SIMSAI_USERNAME: z.string().min(1, "SimsAI username is required"),
    SIMSAI_AGENT_ID: z.string().min(1, "SimsAI agent ID is required"),
    SIMSAI_API_KEY: z.string().min(1, "SimsAI API key is required"),
    SIMSAI_DRY_RUN: z
        .string()
        .optional()
        .default("false")
        .transform((val) => val.toLowerCase() === "true" || val === "1"),
});

export type JeeterConfig = z.infer<typeof jeeterEnvSchema>;

export async function validateJeeterConfig(
    runtime: IAgentRuntime
): Promise<JeeterConfig> {
    // Validate environment variables early
    const requiredEnvVars = [
        "SIMSAI_USERNAME",
        "SIMSAI_AGENT_ID",
        "SIMSAI_API_KEY",
    ];
    const missingEnvVars = requiredEnvVars.filter(
        (envVar) => !(runtime.getSetting(envVar) || process.env[envVar])
    );
    if (missingEnvVars.length > 0) {
        throw new Error(
            `Missing required environment variables: ${missingEnvVars.join(", ")}`
        );
    }

    try {
        const config = {
            SIMSAI_DRY_RUN:
                runtime.getSetting("SIMSAI_DRY_RUN") ||
                process.env.SIMSAI_DRY_RUN,
            SIMSAI_USERNAME:
                runtime.getSetting("SIMSAI_USERNAME") ||
                process.env.SIMSAI_USERNAME,
            SIMSAI_AGENT_ID:
                runtime.getSetting("SIMSAI_AGENT_ID") ||
                process.env.SIMSAI_AGENT_ID,
            SIMSAI_API_KEY:
                runtime.getSetting("SIMSAI_API_KEY") ||
                process.env.SIMSAI_API_KEY,
        };

        return jeeterEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            elizaLogger.error(
                `SimsAI configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}
