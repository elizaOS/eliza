import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

// Environment Variables
let ENV= "production";

// ANKR API Configuration
export const ANKR_ENDPOINTS = {
    production: {
        multichain: "https://rpc.ankr.com/multichain/",
    },

} as const;

export const ankrEnvSchema = z.object({
    // API Configuration
    ANKR_ENV: z.enum(["production", "staging"]).default("production"),
    ANKR_WALLET: z.string().min(1, "ANKR_WALLET is required"),

    // Request Configuration
    ANKR_MAX_RETRIES: z.string().transform(Number).default("3"),
    ANKR_RETRY_DELAY: z.string().transform(Number).default("1000"),
    ANKR_TIMEOUT: z.string().transform(Number).default("5000"),

    // Logging Configuration
    ANKR_GRANULAR_LOG: z.boolean().default(true),
    ANKR_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),

    // Runtime Configuration
    ANKR_RUNTIME_CHECK_MODE: z.boolean().default(false),
    ANKR_SPASH: z.boolean().default(false)
});

export type ankrConfig = z.infer<typeof ankrEnvSchema>;

export function getConfig(
    env: string | undefined | null = ENV ||
        process.env.ANKR_ENV
): ankrConfig {
    ENV = env || "production";

    return {
        ANKR_ENV: (env as "production" | "staging") || "production",
        ANKR_WALLET: process.env.ANKR_WALLET || "",
        ANKR_MAX_RETRIES: Number(process.env.ANKR_MAX_RETRIES || "3"),
        ANKR_RETRY_DELAY: Number(process.env.ANKR_RETRY_DELAY || "1000"),
        ANKR_TIMEOUT: Number(process.env.ANKR_TIMEOUT || "5000"),
        ANKR_GRANULAR_LOG: process.env.ANKR_GRANULAR_LOG === "true" || false,
        ANKR_LOG_LEVEL: (process.env.ANKR_LOG_LEVEL as "error" | "warn" | "info" | "debug") || "info",
        ANKR_RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
        ANKR_SPASH: process.env.ANKR_SPASH === "true" || false
    };
}

export async function validateankrConfig(
    runtime: IAgentRuntime
): Promise<ankrConfig> {
    try {
        const envConfig = getConfig(
            runtime.getSetting("ankr_ENV") ?? undefined
        );

        const config = {
            ANKR_ENV: process.env.ANKR_ENV || runtime.getSetting("ANKR_ENV") || envConfig.ANKR_ENV,
            ANKR_WALLET: process.env.ANKR_WALLET || runtime.getSetting("ANKR_WALLET") || envConfig.ANKR_WALLET,
            ANKR_MAX_RETRIES: process.env.ANKR_MAX_RETRIES || runtime.getSetting("ANKR_MAX_RETRIES") || envConfig.ANKR_MAX_RETRIES.toString(),
            ANKR_RETRY_DELAY: process.env.ANKR_RETRY_DELAY || runtime.getSetting("ANKR_RETRY_DELAY") || envConfig.ANKR_RETRY_DELAY.toString(),
            ANKR_TIMEOUT: process.env.ANKR_TIMEOUT || runtime.getSetting("ANKR_TIMEOUT") || envConfig.ANKR_TIMEOUT.toString(),
            ANKR_GRANULAR_LOG: process.env.ANKR_GRANULAR_LOG === "true" || false,
            ANKR_LOG_LEVEL: process.env.ANKR_LOG_LEVEL || runtime.getSetting("ANKR_LOG_LEVEL") || envConfig.ANKR_LOG_LEVEL,
            ANKR_RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
            ANKR_SPASH: process.env.ANKR_SPASH === "true" || false
        };

        return ankrEnvSchema.parse(config);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to validate ANKR configuration: ${errorMessage}`);
    }
}

// Export endpoints configuration
export const getEndpoints = (env: string = ENV) =>
    ANKR_ENDPOINTS[env as keyof typeof ANKR_ENDPOINTS];

// Helper to get full endpoint URL
export function getEndpointUrl(endpoint: string, env: string = ENV): string {
    const endpoints = getEndpoints(env);
    const parts = endpoint.split('.');
    let current: Record<string, unknown> = endpoints;

    for (const part of parts) {
        if (current[part] === undefined) {
            throw new Error(`Invalid endpoint path: ${endpoint}`);
        }
        current = current[part] as Record<string, unknown>;
    }

    if (typeof current !== 'string') {
        throw new Error(`Invalid endpoint path: ${endpoint}`);
    }

    return current;
}