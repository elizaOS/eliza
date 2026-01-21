/**
 * Deployment Validation Utilities - Node.js Only
 *
 * File system operations for deployment management.
 * These functions require Node.js and are NOT compatible with browser/edge runtime.
 *
 * @remarks Import from '@polyagent/contracts/deployment/validation-node' for Node.js scripts only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DeploymentEnv } from "./env-detection";
import { logger } from "./logger";
import type { ContractAddresses, DeploymentInfo } from "./validation";

/**
 * Save deployment information to JSON file.
 *
 * @remarks This function uses Node.js file system APIs and is not compatible
 * with edge runtime. Only use in Node.js environments (scripts, build-time, etc.).
 *
 * @param env - Deployment environment
 * @param deployment - Deployment information to save
 * @throws Error if file system access is not available
 */
export async function saveDeployment(
  env: DeploymentEnv,
  deployment: DeploymentInfo,
): Promise<void> {
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "saveDeployment requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const deploymentPaths = {
    localnet: "packages/contracts/deployments/local",
    testnet: "packages/contracts/deployments/base-sepolia",
    mainnet: "packages/contracts/deployments/base",
  };

  const dirpath = path.join(process.cwd(), deploymentPaths[env]);
  const filepath = path.join(dirpath, "index.json");

  if (!fs.existsSync(dirpath)) {
    fs.mkdirSync(dirpath, { recursive: true });
  }

  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  logger.info(
    `Deployment saved to ${filepath}`,
    undefined,
    "DeploymentValidation",
  );
}

/**
 * Update environment file with contract addresses
 *
 * NOTE: This function uses Node.js file system APIs and is not compatible with edge runtime.
 * Only use this in Node.js environments (scripts, build-time, etc.).
 */
export async function updateEnvFile(
  env: DeploymentEnv,
  contracts: ContractAddresses,
): Promise<void> {
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "updateEnvFile requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const envFiles = {
    localnet: ".env.local",
    testnet: ".env.testnet",
    mainnet: ".env.production",
  };

  const envFile = path.join(process.cwd(), envFiles[env]);

  let envContent = "";
  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, "utf-8");
  }

  const updates: Record<string, string | undefined> = {
    NEXT_PUBLIC_DIAMOND_ADDRESS: contracts.diamond,
    NEXT_PUBLIC_IDENTITY_REGISTRY: contracts.identityRegistry,
    NEXT_PUBLIC_REPUTATION_SYSTEM: contracts.reputationSystem,
    NEXT_PUBLIC_PREDICTION_MARKET_FACET: contracts.predictionMarketFacet,
    NEXT_PUBLIC_ORACLE_FACET: contracts.oracleFacet,
    NEXT_PUBLIC_LIQUIDITY_POOL_FACET: contracts.liquidityPoolFacet,
    NEXT_PUBLIC_PERPETUAL_MARKET_FACET: contracts.perpetualMarketFacet,
    NEXT_PUBLIC_REFERRAL_SYSTEM_FACET: contracts.referralSystemFacet,
    NEXT_PUBLIC_BAN_MANAGER: contracts.banManager,
    NEXT_PUBLIC_POLYAGENT_ORACLE: contracts.polyagentOracle,
    NEXT_PUBLIC_TEST_TOKEN: contracts.testToken,
  };

  if (contracts.chainlinkOracle) {
    updates.NEXT_PUBLIC_CHAINLINK_ORACLE = contracts.chainlinkOracle;
  }

  if (contracts.mockOracle) {
    updates.NEXT_PUBLIC_MOCK_ORACLE = contracts.mockOracle;
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      const match = envContent.match(regex);
      if (match) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }
  }

  fs.writeFileSync(envFile, envContent);
  logger.info(
    `Updated ${envFile} with contract addresses`,
    undefined,
    "DeploymentValidation",
  );
}
