/**
 * Deployment Validation Utilities
 *
 * Validate that contracts are deployed and working correctly.
 * This file contains only browser-compatible code.
 *
 * @remarks For Node.js file system operations (saveDeployment, updateEnvFile),
 * import from '@polyagent/contracts/deployment/validation-node'.
 */

import { ethers } from "ethers";
import type { DeploymentEnv } from "./env-detection";
import { logger } from "./logger";

/**
 * Contract addresses for a deployment.
 *
 * Includes all core contracts and optional components that may be deployed.
 */
export interface ContractAddresses {
  /** Diamond proxy contract address */
  diamond: string;
  /** DiamondCut facet address */
  diamondCutFacet: string;
  /** DiamondLoupe facet address */
  diamondLoupeFacet: string;
  /** PredictionMarket facet address */
  predictionMarketFacet: string;
  /** Oracle facet address */
  oracleFacet: string;
  /** LiquidityPool facet address (optional) */
  liquidityPoolFacet?: string;
  /** PerpetualMarket facet address (optional) */
  perpetualMarketFacet?: string;
  /** ReferralSystem facet address (optional) */
  referralSystemFacet?: string;
  /** ERC-8004 Identity Registry address */
  identityRegistry: string;
  /** ERC-8004 Reputation System address */
  reputationSystem: string;
  /** Polyagent Game Oracle address (optional) */
  polyagentOracle?: string;
  /** Ban Manager address (optional) */
  banManager?: string;
  /** Chainlink Oracle mock address (testnet only) */
  chainlinkOracle?: string;
  /** Mock Oracle address (testnet only) */
  mockOracle?: string;
  /** Test ERC20 token address (testnet only) */
  testToken?: string;
}

export interface DeploymentInfo {
  network: string;
  chainId: number;
  contracts: ContractAddresses;
  deployer: string;
  timestamp: string;
  blockNumber?: number;
  gasUsed?: string;
  explorer?: Record<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  deployed: boolean;
  errors: string[];
  warnings: string[];
  contracts: Partial<ContractAddresses>;
}

/**
 * Load deployment information from module imports.
 *
 * @param env - Deployment environment to load
 * @returns Deployment info or null if not found
 */
export async function loadDeployment(
  env: DeploymentEnv,
): Promise<DeploymentInfo | null> {
  if (env === "localnet") {
    const deployment = await import("../../deployments/local");
    return deployment.default as DeploymentInfo;
  }
  if (env === "testnet") {
    const deployment = await import("../../deployments/base-sepolia");
    return deployment.default as DeploymentInfo;
  }
  if (env === "mainnet") {
    const deployment = await import("../../deployments/base");
    return deployment.default as DeploymentInfo;
  }

  return null;
}

/**
 * Validate contract deployment
 */
export async function validateDeployment(
  env: DeploymentEnv,
  rpcUrl: string,
  expectedContracts?: Partial<ContractAddresses>,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contracts: Partial<ContractAddresses> = {};

  const deployment = await loadDeployment(env);

  if (!deployment) {
    return {
      valid: false,
      deployed: false,
      errors: [
        `No deployment found for ${env}`,
        "Run the deployment script to deploy contracts",
      ],
      warnings: [],
      contracts: {},
    };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const deploymentChainId = BigInt(deployment.chainId);
  if (network.chainId !== deploymentChainId) {
    errors.push(
      `Chain ID mismatch: provider is ${network.chainId}, deployment is ${deploymentChainId}`,
    );
  }

  const contractsToValidate = expectedContracts || deployment.contracts;

  if (contractsToValidate.diamond) {
    const code = await provider.getCode(contractsToValidate.diamond);
    if (code === "0x" || code === "0x0") {
      errors.push(`Diamond not deployed at ${contractsToValidate.diamond}`);
    } else {
      contracts.diamond = contractsToValidate.diamond;
      logger.info(
        `✅ Diamond verified at ${contractsToValidate.diamond}`,
        undefined,
        "DeploymentValidation",
      );
    }
  }

  if (contractsToValidate.identityRegistry) {
    const code = await provider.getCode(contractsToValidate.identityRegistry);
    if (code === "0x" || code === "0x0") {
      errors.push(
        `Identity Registry not deployed at ${contractsToValidate.identityRegistry}`,
      );
    } else {
      contracts.identityRegistry = contractsToValidate.identityRegistry;
      logger.info(
        `✅ Identity Registry verified at ${contractsToValidate.identityRegistry}`,
        undefined,
        "DeploymentValidation",
      );
    }
  }

  if (contractsToValidate.reputationSystem) {
    const code = await provider.getCode(contractsToValidate.reputationSystem);
    if (code === "0x" || code === "0x0") {
      errors.push(
        `Reputation System not deployed at ${contractsToValidate.reputationSystem}`,
      );
    } else {
      contracts.reputationSystem = contractsToValidate.reputationSystem;
      logger.info(
        `✅ Reputation System verified at ${contractsToValidate.reputationSystem}`,
        undefined,
        "DeploymentValidation",
      );
    }
  }

  if (contracts.diamond) {
    const diamondContract = new ethers.Contract(
      contracts.diamond,
      ["function getBalance(address) view returns (uint256)"],
      provider,
    );

    if (diamondContract.getBalance) {
      await diamondContract.getBalance(ethers.ZeroAddress);
    }
    logger.info(
      "✅ Diamond contract is functional",
      undefined,
      "DeploymentValidation",
    );
  }

  return {
    valid: errors.length === 0,
    deployed: Object.keys(contracts).length > 0,
    errors,
    warnings,
    contracts,
  };
}

/**
 * Check if a contract is deployed at an address
 */
export async function isContractDeployed(
  rpcUrl: string,
  address: string,
): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const code = await provider.getCode(address);
  return code !== "0x" && code !== "0x0";
}

/**
 * Print deployment validation result
 */
export function printDeploymentValidationResult(
  result: ValidationResult,
  env: DeploymentEnv,
): void {
  if (!result.deployed) {
    logger.error(
      `❌ No contracts deployed for ${env}`,
      undefined,
      "DeploymentValidation",
    );
    for (const error of result.errors) {
      logger.error(`   ${error}`, undefined, "DeploymentValidation");
    }

    logger.info(
      "\nTo deploy contracts, run:",
      undefined,
      "DeploymentValidation",
    );
    logger.info(
      `   bun run contracts:deploy:${env === "testnet" ? "testnet" : env === "mainnet" ? "mainnet" : "local"}`,
      undefined,
      "DeploymentValidation",
    );
    return;
  }

  if (result.warnings.length > 0) {
    logger.warn("Warnings:", undefined, "DeploymentValidation");
    for (const warning of result.warnings) {
      logger.warn(`  ⚠️  ${warning}`, undefined, "DeploymentValidation");
    }
  }

  if (result.errors.length > 0) {
    logger.error("Validation errors:", undefined, "DeploymentValidation");
    for (const error of result.errors) {
      logger.error(`  ❌ ${error}`, undefined, "DeploymentValidation");
    }
    throw new Error("Contract validation failed");
  }

  if (!result.valid) {
    throw new Error("Contract validation failed");
  }

  logger.info(
    "✅ All contracts validated successfully",
    undefined,
    "DeploymentValidation",
  );
}

/**
 * Wait for transaction confirmation.
 *
 * Polls the network until the transaction has the required number of confirmations.
 *
 * @param provider - Ethers provider instance
 * @param txHash - Transaction hash to wait for
 * @param confirmations - Number of confirmations required (default: 1)
 * @returns Transaction receipt or null if timeout
 * @throws Error if confirmation timeout is reached
 */
export async function waitForTransaction(
  provider: ethers.Provider,
  txHash: string,
  confirmations = 1,
): Promise<ethers.TransactionReceipt | null> {
  logger.info(
    `Waiting for transaction ${txHash}...`,
    undefined,
    "DeploymentValidation",
  );

  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt?.blockNumber) {
      const currentBlock = await provider.getBlockNumber();
      const confirmedBlocks = currentBlock - receipt.blockNumber;

      if (confirmedBlocks >= confirmations) {
        logger.info(
          `✅ Transaction confirmed (${confirmedBlocks} blocks)`,
          undefined,
          "DeploymentValidation",
        );
        return receipt;
      }

      logger.info(
        `Transaction has ${confirmedBlocks}/${confirmations} confirmations`,
        undefined,
        "DeploymentValidation",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempts++;
  }

  throw new Error("Transaction confirmation timeout");
}
