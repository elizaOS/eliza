import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

// Environment Variables
let ENV= "production";

// Hyperbolic API Configuration
export const HYPERBOLIC_ENDPOINTS = {
    production: {
        marketplace: "https://api.hyperbolic.xyz/v1/marketplace",
        balance: "https://api.hyperbolic.xyz/billing/get_current_balance",
        history: "https://api.hyperbolic.xyz/billing/purchase_history",
        instances: {
            base: "https://api.hyperbolic.xyz/v1/marketplace/instances",
            history: "https://api.hyperbolic.xyz/v1/marketplace/instances/history",
            create: "https://api.hyperbolic.xyz/v1/marketplace/instances/create",
            terminate: "https://api.hyperbolic.xyz/v1/marketplace/instances/terminate",
            gpu_status: "https://api.hyperbolic.xyz/v1/marketplace/instances/{id}/status"
        }
    },
    staging: {
        marketplace: process.env.HYPERBOLIC_STAGING_MARKETPLACE || "https://api-staging.hyperbolic.xyz/v1/marketplace",
        balance: process.env.HYPERBOLIC_STAGING_BALANCE || "https://api-staging.hyperbolic.xyz/billing/get_current_balance",
        history: process.env.HYPERBOLIC_STAGING_HISTORY || "https://api-staging.hyperbolic.xyz/billing/purchase_history",
        instances: {
            base: process.env.HYPERBOLIC_STAGING_INSTANCES || "https://api-staging.hyperbolic.xyz/v1/marketplace/instances",
            history: process.env.HYPERBOLIC_STAGING_INSTANCES_HISTORY || "https://api-staging.hyperbolic.xyz/v1/marketplace/instances/history",
            create: process.env.HYPERBOLIC_STAGING_INSTANCES_CREATE || "https://api-staging.hyperbolic.xyz/v1/marketplace/instances/create",
            terminate: process.env.HYPERBOLIC_STAGING_INSTANCES_TERMINATE || "https://api-staging.hyperbolic.xyz/v1/marketplace/instances/terminate",
            gpu_status: "https://api.hyperbolic.xyz/v1/marketplace/instances/{id}/status"
        }
    }
} as const;

export const hyperbolicEnvSchema = z.object({
    // API Configuration
    HYPERBOLIC_ENV: z.enum(["production", "staging"]).default("production"),
    HYPERBOLIC_API_KEY: z.string().min(1, "HYPERBOLIC_API_KEY is required"),

    // Request Configuration
    HYPERBOLIC_MAX_RETRIES: z.string().transform(Number).default("3"),
    HYPERBOLIC_RETRY_DELAY: z.string().transform(Number).default("1000"),
    HYPERBOLIC_TIMEOUT: z.string().transform(Number).default("5000"),

    // Logging Configuration
    HYPERBOLIC_GRANULAR_LOG: z.boolean().default(true),
    HYPERBOLIC_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),

    // SSH Configuration
    HYPERBOLIC_SSH_PRIVATE_KEY_PATH: z.string().optional(),

    // Runtime Configuration
    HYPERBOLIC_RUNTIME_CHECK_MODE: z.boolean().default(false),
    HYPERBOLIC_SPASH: z.boolean().default(false)
});

export type HyperbolicConfig = z.infer<typeof hyperbolicEnvSchema>;

export function getConfig(
    env: string | undefined | null = ENV ||
        process.env.HYPERBOLIC_ENV
): HyperbolicConfig {
    ENV = env || "production";

    return {
        HYPERBOLIC_ENV: (env as "production" | "staging") || "production",
        HYPERBOLIC_API_KEY: process.env.HYPERBOLIC_API_KEY || "",
        HYPERBOLIC_MAX_RETRIES: Number(process.env.HYPERBOLIC_MAX_RETRIES || "3"),
        HYPERBOLIC_RETRY_DELAY: Number(process.env.HYPERBOLIC_RETRY_DELAY || "1000"),
        HYPERBOLIC_TIMEOUT: Number(process.env.HYPERBOLIC_TIMEOUT || "5000"),
        HYPERBOLIC_GRANULAR_LOG: process.env.HYPERBOLIC_GRANULAR_LOG === "true" || false,
        HYPERBOLIC_LOG_LEVEL: (process.env.HYPERBOLIC_LOG_LEVEL as "error" | "warn" | "info" | "debug") || "info",
        HYPERBOLIC_SSH_PRIVATE_KEY_PATH: process.env.SSH_PRIVATE_KEY_PATH,
        HYPERBOLIC_RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
        HYPERBOLIC_SPASH: process.env.HYPERBOLIC_SPASH === "true" || false
    };
}

export async function validateHyperbolicConfig(
    runtime: IAgentRuntime
): Promise<HyperbolicConfig> {
    try {
        const envConfig = getConfig(
            runtime.getSetting("HYPERBOLIC_ENV") ?? undefined
        );

        const config = {
            HYPERBOLIC_ENV: process.env.HYPERBOLIC_ENV || runtime.getSetting("HYPERBOLIC_ENV") || envConfig.HYPERBOLIC_ENV,
            HYPERBOLIC_API_KEY: process.env.HYPERBOLIC_API_KEY || runtime.getSetting("HYPERBOLIC_API_KEY") || envConfig.HYPERBOLIC_API_KEY,
            HYPERBOLIC_MAX_RETRIES: process.env.HYPERBOLIC_MAX_RETRIES || runtime.getSetting("HYPERBOLIC_MAX_RETRIES") || envConfig.HYPERBOLIC_MAX_RETRIES.toString(),
            HYPERBOLIC_RETRY_DELAY: process.env.HYPERBOLIC_RETRY_DELAY || runtime.getSetting("HYPERBOLIC_RETRY_DELAY") || envConfig.HYPERBOLIC_RETRY_DELAY.toString(),
            HYPERBOLIC_TIMEOUT: process.env.HYPERBOLIC_TIMEOUT || runtime.getSetting("HYPERBOLIC_TIMEOUT") || envConfig.HYPERBOLIC_TIMEOUT.toString(),
            HYPERBOLIC_GRANULAR_LOG: process.env.HYPERBOLIC_GRANULAR_LOG === "true" || false,
            HYPERBOLIC_LOG_LEVEL: process.env.HYPERBOLIC_LOG_LEVEL || runtime.getSetting("HYPERBOLIC_LOG_LEVEL") || envConfig.HYPERBOLIC_LOG_LEVEL,
            HYPERBOLIC_SSH_PRIVATE_KEY_PATH: process.env.SSH_PRIVATE_KEY_PATH || runtime.getSetting("SSH_PRIVATE_KEY_PATH"),
            HYPERBOLIC_RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
            HYPERBOLIC_SPASH: process.env.HYPERBOLIC_SPASH === "true" || false
        };

        return hyperbolicEnvSchema.parse(config);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to validate Hyperbolic configuration: ${errorMessage}`);
    }
}

// Export endpoints configuration
export const getEndpoints = (env: string = ENV) =>
    HYPERBOLIC_ENDPOINTS[env as keyof typeof HYPERBOLIC_ENDPOINTS];

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