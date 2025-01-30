import { elizaLogger } from "@elizaos/core";
import { HyperbolicConfig } from '../environment';

/**
 * Get the Hyperbolic API key from configuration
 * @param config The Hyperbolic configuration object
 * @returns The API key
 * @throws {Error} If HYPERBOLIC_API_KEY is not set
 */
export function getApiKey(config: Partial<HyperbolicConfig>): string {
    const apiKey = config.HYPERBOLIC_API_KEY;
    if (!apiKey) {
        const error = new Error('HYPERBOLIC_API_KEY is not set in configuration');
        elizaLogger.error('API key validation failed', { error });
        throw error;
    }
    return apiKey;
}

/**
 * Get API configuration including retry and timeout settings
 * @param config The Hyperbolic configuration object
 * @returns Object containing API configuration
 */
export function getApiConfig(config: Partial<HyperbolicConfig>): {
    apiKey: string;
    maxRetries: number;
    retryDelay: number;
    timeout: number;
    environment: string;
} {
    const apiKey = getApiKey(config);

    return {
        apiKey,
        maxRetries: Number(config.HYPERBOLIC_MAX_RETRIES || 3),
        retryDelay: Number(config.HYPERBOLIC_RETRY_DELAY || 1000),
        timeout: Number(config.HYPERBOLIC_TIMEOUT || 5000),
        environment: config.HYPERBOLIC_ENV || 'production'
    };
}

/**
 * Get CDP API configuration if available
 * @param config The Hyperbolic configuration object
 * @returns Object containing CDP API configuration or null if not configured
 */
export function getCdpConfig(config: Partial<HyperbolicConfig>): {
    keyName: string;
    privateKey: string;
} | null {
    if (!config.HYPERBOLIC_CDP_NAME || !config.HYPERBOLIC_CDP_PRIVATE_KEY) {
        return null;
    }

    return {
        keyName: config.HYPERBOLIC_CDP_NAME,
        privateKey: config.HYPERBOLIC_CDP_PRIVATE_KEY
    };
}
