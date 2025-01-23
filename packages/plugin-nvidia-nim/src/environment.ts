import { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

// Environment Variables
let ENV: string = "production";

// NVIDIA NIM API Configuration
const NVIDIA_NIM_NETWORKS = {
    production: {
        baseUrl: process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1",
        apiKey: process.env.NVIDIA_NIM_API_KEY
    },
    sandbox: {
        baseUrl: process.env.NVIDIA_NIM_SANDBOX_URL || "https://integrate.api.nvidia.com/v1",
        apiKey: process.env.NVIDIA_NIM_SANDBOX_API_KEY
    }
} as const;

export const nvidiaEnvSchema = z.object({
    NVIDIA_NIM_ENV: z.enum(["production", "sandbox"]).default("production"),
    NVIDIA_NIM_SPASH: z.boolean().default(false),
    NVIDIA_NIM_API_KEY: z.string(),
    NVIDIA_NIM_MAX_RETRIES: z.string().transform(Number).default("3"),
    NVIDIA_NIM_RETRY_DELAY: z.string().transform(Number).default("1000"),
    NVIDIA_NIM_TIMEOUT: z.string().transform(Number).default("5000"),
    NVIDIA_NIM_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
    NVIDIA_GRANULAR_LOG: z.boolean().default(false),
    NVIDIA_OFFTOPIC_SYSTEM: z.string().default("You are a topic control assistant. Your role is to analyze if the user's message is on-topic or off-topic based on the context and guidelines provided. Respond with a clear analysis of whether the message is appropriate for the given context."),
    NVIDIA_OFFTOPIC_USER: z.string().default("Please analyze if this message is on-topic or off-topic."),
    NVIDIA_NIM_BASE_VISION_URL: z.string().optional(),
    NVIDIA_NIM_BASE_URL: z.string().optional(),
    NVIDIA_COSMOS_INVOKE_URL: z.string().optional(),
    NVIDIA_COSMOS_ASSET_URL: z.string().optional()
});

export type NvidiaNimConfig = z.infer<typeof nvidiaEnvSchema>;

export function getConfig(
    env: string | undefined | null = ENV ||
        process.env.NVIDIA_NIM_ENV
): NvidiaNimConfig {
    ENV = env || "production";

    return {
        NVIDIA_NIM_ENV: (env as "production" | "sandbox") || "production",
        NVIDIA_NIM_SPASH: process.env.NVIDIA_NIM_SPASH === "true" || false,
        NVIDIA_NIM_API_KEY: process.env.NVIDIA_NIM_API_KEY || "",
        NVIDIA_NIM_MAX_RETRIES: Number(process.env.NVIDIA_NIM_MAX_RETRIES || "3"),
        NVIDIA_NIM_RETRY_DELAY: Number(process.env.NVIDIA_NIM_RETRY_DELAY || "1000"),
        NVIDIA_NIM_TIMEOUT: Number(process.env.NVIDIA_NIM_TIMEOUT || "5000"),
        NVIDIA_NIM_LOG_LEVEL: (process.env.NVIDIA_NIM_LOG_LEVEL as "error" | "warn" | "info" | "debug") || "info",
        NVIDIA_GRANULAR_LOG: process.env.NVIDIA_GRANULAR_LOG === "true" || false,
        NVIDIA_OFFTOPIC_SYSTEM: process.env.NVIDIA_OFFTOPIC_SYSTEM || "You are a topic control assistant. Your role is to analyze if the user's message is on-topic or off-topic based on the context and guidelines provided. Respond with a clear analysis of whether the message is appropriate for the given context.",
        NVIDIA_OFFTOPIC_USER: process.env.NVIDIA_OFFTOPIC_USER || "Please analyze if this message is on-topic or off-topic.",
        NVIDIA_NIM_BASE_VISION_URL: process.env.NVIDIA_NIM_BASE_VISION_URL,
        NVIDIA_NIM_BASE_URL: process.env.NVIDIA_NIM_BASE_URL,
        NVIDIA_COSMOS_INVOKE_URL: process.env.NVIDIA_COSMOS_INVOKE_URL,
        NVIDIA_COSMOS_ASSET_URL: process.env.NVIDIA_COSMOS_ASSET_URL
    };
}

export async function validateNvidiaNimConfig(
    runtime: IAgentRuntime
): Promise<NvidiaNimConfig> {
    try {
        const envConfig = getConfig(
            runtime.getSetting("NVIDIA_NIM_ENV") ?? undefined
        );

        // Add debug logging
        console.log("Debug - API Key sources:", {
            env: process.env.NVIDIA_NIM_API_KEY ? "present" : "missing",
            runtime: runtime.getSetting("NVIDIA_NIM_API_KEY") ? "present" : "missing",
            envConfig: envConfig.NVIDIA_NIM_API_KEY ? "present" : "missing"
        });

        const config = {
            NVIDIA_NIM_ENV: process.env.NVIDIA_NIM_ENV || runtime.getSetting("NVIDIA_NIM_ENV") || envConfig.NVIDIA_NIM_ENV,
            NVIDIA_NIM_SPASH: process.env.NVIDIA_NIM_SPASH || runtime.getSetting("NVIDIA_NIM_SPASH") || envConfig.NVIDIA_NIM_SPASH,
            NVIDIA_NIM_API_KEY: runtime.getSetting("NVIDIA_NIM_API_KEY") || process.env.NVIDIA_NIM_API_KEY || "",
            NVIDIA_NIM_MAX_RETRIES: process.env.NVIDIA_NIM_MAX_RETRIES || runtime.getSetting("NVIDIA_NIM_MAX_RETRIES") || envConfig.NVIDIA_NIM_MAX_RETRIES.toString(),
            NVIDIA_NIM_RETRY_DELAY: process.env.NVIDIA_NIM_RETRY_DELAY || runtime.getSetting("NVIDIA_NIM_RETRY_DELAY") || envConfig.NVIDIA_NIM_RETRY_DELAY.toString(),
            NVIDIA_NIM_TIMEOUT: process.env.NVIDIA_NIM_TIMEOUT || runtime.getSetting("NVIDIA_NIM_TIMEOUT") || envConfig.NVIDIA_NIM_TIMEOUT.toString(),
            NVIDIA_NIM_LOG_LEVEL: process.env.NVIDIA_NIM_LOG_LEVEL || runtime.getSetting("NVIDIA_NIM_LOG_LEVEL") || envConfig.NVIDIA_NIM_LOG_LEVEL,
            NVIDIA_GRANULAR_LOG: process.env.NVIDIA_GRANULAR_LOG === "true" || runtime.getSetting("NVIDIA_GRANULAR_LOG") === "true" || envConfig.NVIDIA_GRANULAR_LOG,
            NVIDIA_OFFTOPIC_SYSTEM: process.env.NVIDIA_OFFTOPIC_SYSTEM || runtime.getSetting("NVIDIA_OFFTOPIC_SYSTEM") || envConfig.NVIDIA_OFFTOPIC_SYSTEM,
            NVIDIA_OFFTOPIC_USER: process.env.NVIDIA_OFFTOPIC_USER || runtime.getSetting("NVIDIA_OFFTOPIC_USER") || envConfig.NVIDIA_OFFTOPIC_USER,
            NVIDIA_NIM_BASE_VISION_URL: process.env.NVIDIA_NIM_BASE_VISION_URL || envConfig.NVIDIA_NIM_BASE_VISION_URL,
            NVIDIA_NIM_BASE_URL: process.env.NVIDIA_NIM_BASE_URL || envConfig.NVIDIA_NIM_BASE_URL,
            NVIDIA_COSMOS_INVOKE_URL: process.env.NVIDIA_COSMOS_INVOKE_URL || envConfig.NVIDIA_COSMOS_INVOKE_URL,
            NVIDIA_COSMOS_ASSET_URL: process.env.NVIDIA_COSMOS_ASSET_URL || envConfig.NVIDIA_COSMOS_ASSET_URL
        };

        // Add validation logging
        console.log("Debug - Final config:", {
            env: config.NVIDIA_NIM_ENV,
            hasApiKey: !!config.NVIDIA_NIM_API_KEY,
            apiKeyLength: config.NVIDIA_NIM_API_KEY.length
        });

        return nvidiaEnvSchema.parse(config);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Config validation error:", errorMessage);
        throw new Error(`Failed to validate NVIDIA NIM configuration: ${errorMessage}`);
    }
}

// Export network configurations
export const getNetworkConfig = (env: string = ENV) => {
    const network = NVIDIA_NIM_NETWORKS[env as keyof typeof NVIDIA_NIM_NETWORKS];
    return {
        ...network,
        baseVisionUrl: process.env.NVIDIA_NIM_BASE_VISION_URL || 'https://ai.api.nvidia.com/v1/vlm'
    };
};

// AlphaFold2 Configuration
export const ALPHAFOLD2_CONFIG = {
    API_KEY: process.env.NVIDIA_NIM_API_KEY,
    NGC_KEY: process.env.NVIDIA_NGC_API_KEY,
    API_URL: process.env.ALPHAFOLD_API_URL || 'https://health.api.nvidia.com/v1/biology/deepmind/alphafold2-multimer',
    STATUS_URL: process.env.ALPHAFOLD_STATUS_URL || 'https://health.api.nvidia.com/v1/status',
    SEQUENCES: {
        SEQ1: process.env.SEQUENCE_ALPHA_FOLD2_1,
        SEQ2: process.env.SEQUENCE_ALPHA_FOLD2_2
    }
} as const;

export interface NetworkConfig {
    baseUrl: string;
    baseVisionUrl: string;
}
