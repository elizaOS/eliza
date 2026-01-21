/**
 * @packageDocumentation
 * @module @polyagent/contracts/deployment/env-detection
 *
 * Environment Detection and Validation
 *
 * Detects deployment environment (localnet, testnet, mainnet) and validates
 * required configuration. Provides utilities for environment detection,
 * configuration validation, and deployment information retrieval.
 */

import { logger } from "./logger";

/**
 * Supported deployment environments.
 */
export type DeploymentEnv = "localnet" | "testnet" | "mainnet";

/**
 * Chain configuration for a deployment environment.
 */
export interface ChainConfig {
  /** Chain ID for the network */
  chainId: number;
  /** Human-readable network name */
  name: string;
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Block explorer URL */
  explorerUrl: string;
  /** Native currency configuration */
  nativeCurrency: {
    /** Currency name */
    name: string;
    /** Currency symbol */
    symbol: string;
    /** Number of decimals */
    decimals: number;
  };
}

/**
 * Chain configurations for all supported deployment environments.
 */
export const CHAIN_CONFIGS: Record<DeploymentEnv, ChainConfig> = {
  localnet: {
    chainId: 31337,
    name: "Hardhat (Local)",
    rpcUrl: "http://localhost:8545",
    explorerUrl: "",
    nativeCurrency: {
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
    },
  },
  testnet: {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    nativeCurrency: {
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
    },
  },
  mainnet: {
    chainId: 8453,
    name: "Base",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeCurrency: {
      name: "Ethereum",
      symbol: "ETH",
      decimals: 18,
    },
  },
};

/**
 * Result of environment validation.
 */
export interface EnvValidationResult {
  /** Whether the environment configuration is valid */
  valid: boolean;
  /** Detected deployment environment */
  environment: DeploymentEnv;
  /** List of validation errors */
  errors: string[];
  /** List of validation warnings */
  warnings: string[];
  /** Chain configuration for the environment */
  config: ChainConfig;
}

/**
 * Detect deployment environment from environment variables.
 *
 * Checks multiple sources in order of precedence:
 * 1. `DEPLOYMENT_ENV` environment variable
 * 2. `USE_MAINNET` flag
 * 3. `NODE_ENV` (production defaults to testnet)
 * 4. `NEXT_PUBLIC_CHAIN_ID` chain ID
 * 5. RPC URL patterns
 *
 * @returns Detected deployment environment
 */
export function detectEnvironment(): DeploymentEnv {
  const explicitEnv = process.env.DEPLOYMENT_ENV;
  if (
    explicitEnv === "localnet" ||
    explicitEnv === "testnet" ||
    explicitEnv === "mainnet"
  ) {
    return explicitEnv;
  }

  if (process.env.USE_MAINNET === "true") {
    return "mainnet";
  }

  if (process.env.NODE_ENV === "production") {
    return "testnet";
  }

  const chainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (chainId) {
    switch (Number.parseInt(chainId, 10)) {
      case 31337:
        return "localnet";
      case 84532:
        return "testnet";
      case 8453:
        return "mainnet";
    }
  }

  const rpcUrl =
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.BASE_SEPOLIA_RPC_URL ||
    process.env.BASE_RPC_URL;
  if (rpcUrl) {
    if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
      return "localnet";
    }
    if (rpcUrl.includes("sepolia")) {
      return "testnet";
    }
    if (rpcUrl.includes("mainnet.base.org")) {
      return "mainnet";
    }
  }

  return "localnet";
}

/**
 * Validate environment configuration.
 *
 * Checks that all required environment variables are set for the detected
 * or specified environment. Returns validation results with errors and warnings.
 *
 * @param env - Optional environment to validate. If not provided, detects automatically.
 * @returns Validation result with errors, warnings, and configuration
 */
export function validateEnvironment(env?: DeploymentEnv): EnvValidationResult {
  const environment = env || detectEnvironment();
  const config = CHAIN_CONFIGS[environment];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required");
  }

  const privyAppId =
    process.env.NEXT_PUBLIC_PRIVY_APP_ID || process.env.PRIVY_APP_ID;
  if (!privyAppId) {
    errors.push("NEXT_PUBLIC_PRIVY_APP_ID (or PRIVY_APP_ID) is required");
  }

  switch (environment) {
    case "localnet":
      validateLocalnet(errors, warnings);
      break;
    case "testnet":
      validateTestnet(errors, warnings);
      break;
    case "mainnet":
      validateMainnet(errors, warnings);
      break;
  }

  return {
    valid: errors.length === 0,
    environment,
    errors,
    warnings,
    config,
  };
}

function validateLocalnet(_errors: string[], warnings: string[]): void {
  if (
    process.env.DEPLOYER_PRIVATE_KEY &&
    !process.env.DEPLOYER_PRIVATE_KEY.startsWith("0xac0974")
  ) {
    warnings.push(
      "Using non-default private key for localnet (this is OK if intentional)",
    );
  }

  if (!process.env.REDIS_URL) {
    warnings.push("REDIS_URL not set (SSE will use polling fallback)");
  }
}

function validateTestnet(errors: string[], warnings: string[]): void {
  // Contract addresses are now in canonical config (packages/shared/src/config/default-config.ts)
  // Only warn if config has zero addresses (not deployed yet)
  warnings.push(
    "Ensure Base Sepolia contracts are deployed. Check packages/shared/src/config/default-config.ts",
  );

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    warnings.push(
      "DEPLOYER_PRIVATE_KEY not set (required for contract deployment)",
    );
  }

  if (process.env.AGENT0_ENABLED === "true") {
    if (!process.env.BASE_SEPOLIA_RPC_URL) {
      errors.push("BASE_SEPOLIA_RPC_URL is required when AGENT0_ENABLED=true");
    }
    if (!process.env.POLYAGENT_GAME_PRIVATE_KEY) {
      errors.push(
        "POLYAGENT_GAME_PRIVATE_KEY is required when AGENT0_ENABLED=true",
      );
    }
    if (!process.env.AGENT0_SUBGRAPH_URL) {
      warnings.push(
        "AGENT0_SUBGRAPH_URL not set (Agent0 discovery may not work)",
      );
    }
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    warnings.push(
      "ETHERSCAN_API_KEY not set (contract verification will fail)",
    );
  }
}

function validateMainnet(errors: string[], warnings: string[]): void {
  if (process.env.USE_MAINNET !== "true") {
    errors.push('USE_MAINNET must be set to "true" to deploy to mainnet');
    errors.push(
      "This is a safety check to prevent accidental mainnet deployments",
    );
  }

  // Contract addresses are now in canonical config (packages/shared/src/config/default-config.ts)
  // Only secrets should be validated from env vars
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    errors.push("DEPLOYER_PRIVATE_KEY is required for mainnet deployment");
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    errors.push(
      "ETHERSCAN_API_KEY is required for mainnet (contract verification)",
    );
  }

  if (process.env.AGENT0_ENABLED === "true") {
    if (!process.env.BASE_RPC_URL) {
      errors.push(
        "BASE_RPC_URL is required when AGENT0_ENABLED=true on mainnet",
      );
    }
    if (!process.env.POLYAGENT_GAME_PRIVATE_KEY) {
      errors.push(
        "POLYAGENT_GAME_PRIVATE_KEY is required when AGENT0_ENABLED=true",
      );
    }
    if (!process.env.AGENT0_SUBGRAPH_URL) {
      errors.push(
        "AGENT0_SUBGRAPH_URL is required for mainnet Agent0 integration",
      );
    }
  }

  if (process.env.NODE_ENV === "production") {
    const privyAppId =
      process.env.PRIVY_APP_ID || process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    if (!privyAppId || !process.env.PRIVY_APP_SECRET) {
      errors.push("Privy credentials required for production");
    }

    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      warnings.push("PostHog analytics not configured");
    }
  }
}

/**
 * Get required environment variables for an environment
 *
 * Note: Contract addresses are now in canonical config (packages/shared/src/config/default-config.ts)
 * Only secrets and runtime configuration should be in env vars.
 */
export function getRequiredEnvVars(env: DeploymentEnv): string[] {
  const common = ["DATABASE_URL"];

  switch (env) {
    case "localnet":
      return [...common];

    case "testnet":
      return [
        ...common,
        // NEXT_PUBLIC_CHAIN_ID is optional - defaults to local if not set
        // Contract addresses are in canonical config
      ];

    case "mainnet":
      return [
        ...common,
        "USE_MAINNET", // Safety flag for mainnet
        "DEPLOYER_PRIVATE_KEY",
        "ETHERSCAN_API_KEY",
      ];
  }
}

/**
 * Print validation result
 */
export function printValidationResult(result: EnvValidationResult): void {
  logger.info(
    `Environment: ${result.environment} (${result.config.name})`,
    undefined,
    "EnvDetection",
  );
  logger.info(`Chain ID: ${result.config.chainId}`, undefined, "EnvDetection");
  logger.info(`RPC URL: ${result.config.rpcUrl}`, undefined, "EnvDetection");

  if (result.warnings.length > 0) {
    logger.warn("Warnings:", undefined, "EnvDetection");
    for (const warning of result.warnings) {
      logger.warn(`  ⚠️  ${warning}`, undefined, "EnvDetection");
    }
  }

  if (result.errors.length > 0) {
    logger.error("Validation failed:", undefined, "EnvDetection");
    for (const error of result.errors) {
      logger.error(`  ❌ ${error}`, undefined, "EnvDetection");
    }
    throw new Error("Environment validation failed");
  }

  if (result.warnings.length === 0 && result.errors.length === 0) {
    logger.info("✅ Environment validation passed", undefined, "EnvDetection");
  }
}

/**
 * Load environment file for specific environment
 */
export function loadEnvFile(env: DeploymentEnv): void {
  const envFiles = {
    localnet: ".env.local",
    testnet: ".env.testnet",
    mainnet: ".env.production",
  };

  const envFile = envFiles[env];
  logger.info(`Loading environment from ${envFile}`, undefined, "EnvDetection");
}

/**
 * Get deployment info for display
 *
 * Note: Contract deployment status is now checked via canonical config
 */
export function getDeploymentInfo(): {
  environment: DeploymentEnv;
  chain: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  contractsDeployed: boolean;
  agent0Enabled: boolean;
} {
  const environment = detectEnvironment();
  const config = CHAIN_CONFIGS[environment];

  // For localnet, contracts are always considered deployed (canonical config has addresses)
  // For testnet/mainnet, check if contracts are in canonical config
  const contractsDeployed = environment === "localnet";

  return {
    environment,
    chain: config.name,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    explorerUrl: config.explorerUrl,
    contractsDeployed,
    agent0Enabled: process.env.AGENT0_ENABLED === "true",
  };
}
