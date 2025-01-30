import { z } from "zod";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";
import { elizaLogger } from "@elizaos/core";

// Base configuration schema
const baseConfigSchema = z.object({
    NVIDIA_NIM_ENV: z.enum(["production", "sandbox"]).default("production"),
    NVIDIA_NIM_API_KEY: z.string().min(1, "API key is required"),
    NVIDIA_NIM_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
    NVIDIA_GRANULAR_LOG: z.boolean().default(false)
});

// Action-specific schemas
const topicControlSchema = baseConfigSchema.extend({
    NVIDIA_OFFTOPIC_SYSTEM: z.string(),
    NVIDIA_OFFTOPIC_USER: z.string()
});

const safetySchema = baseConfigSchema.extend({
    NVIDIA_SAFETY_THRESHOLD: z.number().min(0).max(1).default(0.7)
});

const cosmosSchema = baseConfigSchema.extend({
    NVIDIA_COSMOS_MODEL: z.string().default("nvidia/vila"),
    NVIDIA_COSMOS_MAX_TOKENS: z.number().default(1000)
});

const deepfakeSchema = baseConfigSchema.extend({
    NVIDIA_DEEPFAKE_CONFIDENCE_THRESHOLD: z.number().min(0).max(1).default(0.8),
    NVIDIA_DEEPFAKE_MAX_SIZE: z.number().default(180000)
});

const alphafoldSchema = baseConfigSchema.extend({
    NVIDIA_NGC_API_KEY: z.string().optional(),
    ALPHAFOLD_API_URL: z.string().url(),
    ALPHAFOLD_STATUS_URL: z.string().url()
});

// Validation functions for each action
export async function validateTopicControl(config: Record<string, any>) {
    try {
        return topicControlSchema.parse(config);
    } catch (error) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Topic Control validation failed",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

export async function validateSafety(config: Record<string, any>) {
    try {
        return safetySchema.parse(config);
    } catch (error) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Safety validation failed",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

export async function validateCosmos(config: Record<string, any>) {
    try {
        return cosmosSchema.parse(config);
    } catch (error) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Cosmos validation failed",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

export async function validateDeepfake(config: Record<string, any>) {
    try {
        return deepfakeSchema.parse(config);
    } catch (error) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Deepfake validation failed",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

export async function validateAlphafold(config: Record<string, any>) {
    try {
        return alphafoldSchema.parse(config);
    } catch (error) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "Alphafold validation failed",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

// Utility function to validate all configurations
export async function validateAllConfigs(config: Record<string, any>) {
    const results = {
        topicControl: await validateTopicControl(config).catch(e => e),
        safety: await validateSafety(config).catch(e => e),
        cosmos: await validateCosmos(config).catch(e => e),
        deepfake: await validateDeepfake(config).catch(e => e),
        alphafold: await validateAlphafold(config).catch(e => e)
    };

    // Log validation results
    Object.entries(results).forEach(([key, value]) => {
        if (value instanceof Error) {
            elizaLogger.error(`Validation failed for ${key}:`, { error: value });
        } else {
            elizaLogger.info(`Validation passed for ${key}`);
        }
    });

    return results;
}
