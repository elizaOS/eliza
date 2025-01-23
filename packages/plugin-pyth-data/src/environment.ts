import type { IAgentRuntime} from "@elizaos/core";
import { z } from "zod";

// Environment Variables
let ENV = "mainnet";

// Pyth Network Configuration
const PYTH_NETWORKS = {
    mainnet: {
        hermes: process.env.PYTH_MAINNET_HERMES_URL || "https://hermes.pyth.network",
        wss: process.env.PYTH_MAINNET_WSS_URL || "wss://hermes.pyth.network/ws",
        pythnet: process.env.PYTH_MAINNET_PYTHNET_URL || "https://pythnet.rpcpool.com",
        contractRegistry: process.env.PYTH_MAINNET_CONTRACT_REGISTRY || "https://pyth.network/developers/price-feed-ids",
        programKey: process.env.PYTH_MAINNET_PROGRAM_KEY || "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH"
    },
    testnet: {
        hermes: process.env.PYTH_TESTNET_HERMES_URL || "https://hermes.pyth.network",
        wss: process.env.PYTH_TESTNET_WSS_URL || "wss://hermes.pyth.network/ws",
        pythnet: process.env.PYTH_TESTNET_PYTHNET_URL || "https://pythnet.rpcpool.com",
        contractRegistry: process.env.PYTH_TESTNET_CONTRACT_REGISTRY || "https://pyth.network/developers/price-feed-ids#testnet",
        programKey: process.env.PYTH_TESTNET_PROGRAM_KEY || "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH"
    }
} as const;

// // Log environment information
// elizaLogger.info("Environment sources", {
//     shellVars: Object.keys(process.env).filter(key => key.startsWith('PYTH_')),
// });

export const pythEnvSchema = z.object({
    PYTH_NETWORK_ENV: z.enum(["mainnet", "testnet"]).default("mainnet"),
    PYTH_MAX_RETRIES: z.string().transform(Number).default("3"),
    PYTH_RETRY_DELAY: z.string().transform(Number).default("1000"),
    PYTH_TIMEOUT: z.string().transform(Number).default("5000"),
    PYTH_GRANULAR_LOG: z.boolean().default(true),
    PYTH_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
    RUNTIME_CHECK_MODE: z.boolean().default(false),
    PYTH_ENABLE_PRICE_STREAMING: z.boolean().default(true),
    PYTH_MAX_PRICE_STREAMS: z.string().transform(Number).default("10"),
    PYTH_TEST_ID01: z.string().default("0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"),
    PYTH_TEST_ID02: z.string().default("0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"),

});

export type PythConfig = z.infer<typeof pythEnvSchema>;

export function getConfig(
    env: string | undefined | null = ENV ||
        process.env.PYTH_NETWORK_ENV
): PythConfig {
    ENV = env || "mainnet";

    return {
        PYTH_NETWORK_ENV: (env as "mainnet" | "testnet") || "mainnet",
        PYTH_MAX_RETRIES: Number(process.env.PYTH_MAX_RETRIES || "3"),
        PYTH_RETRY_DELAY: Number(process.env.PYTH_RETRY_DELAY || "1000"),
        PYTH_TIMEOUT: Number(process.env.PYTH_TIMEOUT || "5000"),
        PYTH_GRANULAR_LOG: process.env.PYTH_GRANULAR_LOG === "true" || false,
        PYTH_LOG_LEVEL: (process.env.PYTH_LOG_LEVEL as "error" | "warn" | "info" | "debug") || "info",
        RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
        PYTH_ENABLE_PRICE_STREAMING: process.env.PYTH_ENABLE_PRICE_STREAMING === "true" || true,
        PYTH_MAX_PRICE_STREAMS: Number(process.env.PYTH_MAX_PRICE_STREAMS || "10"),
        PYTH_TEST_ID01: process.env.PYTH_TEST_ID01 || "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
        PYTH_TEST_ID02: process.env.PYTH_TEST_ID02 || "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    };
}

export async function validatePythConfig(
    runtime: IAgentRuntime
): Promise<PythConfig> {
    try {
        const envConfig = getConfig(
            runtime.getSetting("PYTH_NETWORK_ENV") ?? undefined
        );

        const config = {
            PYTH_NETWORK_ENV: process.env.PYTH_NETWORK_ENV || runtime.getSetting("PYTH_NETWORK_ENV") || envConfig.PYTH_NETWORK_ENV,
            PYTH_MAX_RETRIES: process.env.PYTH_MAX_RETRIES || runtime.getSetting("PYTH_MAX_RETRIES") || envConfig.PYTH_MAX_RETRIES.toString(),
            PYTH_RETRY_DELAY: process.env.PYTH_RETRY_DELAY || runtime.getSetting("PYTH_RETRY_DELAY") || envConfig.PYTH_RETRY_DELAY.toString(),
            PYTH_GRANULAR_LOG: process.env.PYTH_GRANULAR_LOG === "true" || false,
            PYTH_LOG_LEVEL: process.env.PYTH_LOG_LEVEL || runtime.getSetting("PYTH_LOG_LEVEL") || envConfig.PYTH_LOG_LEVEL,
            RUNTIME_CHECK_MODE: process.env.RUNTIME_CHECK_MODE === "true" || false,
            PYTH_ENABLE_PRICE_STREAMING: process.env.PYTH_ENABLE_PRICE_STREAMING === "true" || true,
            PYTH_MAX_PRICE_STREAMS: process.env.PYTH_MAX_PRICE_STREAMS || runtime.getSetting("PYTH_MAX_PRICE_STREAMS") || envConfig.PYTH_MAX_PRICE_STREAMS.toString(),
            PYTH_TEST_ID01: process.env.PYTH_TEST_ID01 || envConfig.PYTH_TEST_ID01,
            PYTH_TEST_ID02: process.env.PYTH_TEST_ID02 || envConfig.PYTH_TEST_ID02,
        };

        return pythEnvSchema.parse(config);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to validate Pyth configuration: ${errorMessage}`);
    }
}

// Export network configurations
export const getNetworkConfig = (env: string = ENV) => PYTH_NETWORKS[env as keyof typeof PYTH_NETWORKS];
