#!/usr/bin/env bun

/**
 * Wait for Hardhat Node and Deploy Contracts
 *
 * This script:
 * 1. Waits for Hardhat node to be ready
 * 2. Deploys contracts once Hardhat is ready (including NFT contract)
 * 3. Seeds NFT collection and creates test snapshot
 * 4. Keeps running to monitor Hardhat (used during dev startup)
 *
 * Note: For local development, the API uses Hardhat's default account #0
 * (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) which is pre-funded with 10000 ETH.
 * No manual funding is required.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeployment } from "@polyagent/contracts";
import { $ } from "bun";

const HARDHAT_RPC_URL = "http://localhost:8545";

// Hardhat default account #0 (has 10000 ETH) - used by API for local dev transactions
const HARDHAT_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Hardhat default account #0 private key - used for signing NFT mint messages
const HARDHAT_ACCOUNT_0_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * Check if a contract is deployed at the given address using direct JSON-RPC
 * This is more reliable than using cast which can have issues with hardhat
 */
async function isContractDeployed(address: string): Promise<boolean> {
  const response = await fetch(HARDHAT_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getCode",
      params: [address, "latest"],
      id: 1,
    }),
  }).catch(() => null);

  if (!response) return false;

  const data = (await response.json().catch(() => null)) as {
    result?: string;
  } | null;
  const code = data?.result ?? "0x";

  // Contract is deployed if code is not empty
  return code !== "0x" && code !== "0x0" && code.length > 2;
}

/**
 * Wait for Hardhat node to be ready
 */
async function waitForHardhat(): Promise<boolean> {
  console.info("Waiting for Hardhat node to be ready...", undefined, "Script");

  for (let attempts = 0; attempts < 30; attempts++) {
    const response = await fetch(HARDHAT_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
    }).catch(() => null);

    if (response?.ok) {
      console.info("✅ Hardhat node is ready", undefined, "Script");
      return true;
    }

    if (attempts === 0) {
      console.info("Waiting for Hardhat node to start...", undefined, "Script");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function main() {
  // Wait for Hardhat to be ready
  const hardhatReady = await waitForHardhat();
  if (!hardhatReady) {
    console.error(
      "❌ Hardhat node failed to start within 30 seconds",
      undefined,
      "Script",
    );
    process.exit(1);
  }

  // Check if contracts are already deployed on-chain
  // Note: Hardhat has no persistence, so contracts only exist if deployed this session
  const deployment = await loadDeployment("localnet");
  let needsDeploy = true;

  if (deployment?.contracts.diamond) {
    const deployed = await isContractDeployed(deployment.contracts.diamond);
    if (deployed) {
      console.info(
        "✅ Contracts already deployed at saved addresses",
        undefined,
        "Script",
      );
      needsDeploy = false;
    } else {
      console.info(
        "Saved deployment addresses are stale (Hardhat restarted), redeploying...",
        undefined,
        "Script",
      );
    }
  } else {
    console.info(
      "No previous deployment found, deploying...",
      undefined,
      "Script",
    );
  }

  if (needsDeploy) {
    // Deploy contracts
    console.info("Deploying contracts to Hardhat...", undefined, "Script");
    try {
      await $`bun run deploy:local`;
      console.info("✅ Contracts deployed successfully", undefined, "Script");
    } catch (error) {
      console.error("❌ Contract deployment failed:", error, "Script");
      process.exit(1);
    }
  }

  // Deploy NFT contract for local development
  await deployNftContract();

  console.info(
    `✅ Using Hardhat account #0 (${HARDHAT_ACCOUNT_0}) for transactions`,
    undefined,
    "Script",
  );
  console.info("Contract deployment monitor running...", undefined, "Script");

  // Keep the process running to maintain concurrently
  await new Promise(() => {}); // Never resolves
}

/**
 * Deploy ProtoMonkeysNFT contract and set up NFT environment for local dev
 */
async function deployNftContract(): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  const contractsDir = join(process.cwd(), "packages", "contracts");

  // Check if NFT contract is already deployed in this session
  const existingAddress = process.env.NFT_CONTRACT_ADDRESS;
  if (
    existingAddress &&
    existingAddress !== "0x0000000000000000000000000000000000000000"
  ) {
    const deployed = await isContractDeployed(existingAddress);
    if (deployed) {
      console.info(
        `✅ NFT contract already deployed at ${existingAddress}`,
        undefined,
        "Script",
      );
      return;
    }
  }

  console.info("Deploying ProtoMonkeysNFT contract...", undefined, "Script");

  try {
    // Deploy NFT contract using Foundry script
    const result =
      await $`cd ${contractsDir} && NFT_SIGNER_ADDRESS=${HARDHAT_ACCOUNT_0} NFT_BASE_URI=http://localhost:3000/api/nft/metadata/ forge script script/DeployProtoMonkeysNFT.s.sol:DeployProtoMonkeysNFTLocal --rpc-url http://localhost:8545 --broadcast --sender ${HARDHAT_ACCOUNT_0}`.quiet();

    const output = result.text();

    // Parse NFT contract address from output
    const addressMatch = output.match(
      /ProtoMonkeysNFT deployed to:\s*(0x[a-fA-F0-9]{40})/,
    );
    if (!addressMatch) {
      console.warn(
        "⚠️  Could not parse NFT contract address from output",
        undefined,
        "Script",
      );
      return;
    }

    const nftContractAddress = addressMatch[1] as string;
    console.info(
      `✅ ProtoMonkeysNFT deployed to: ${nftContractAddress}`,
      undefined,
      "Script",
    );

    // Update .env with NFT configuration
    updateEnvFile(envPath, {
      NFT_CONTRACT_ADDRESS: nftContractAddress,
      NFT_CHAIN_ID: "31337",
      NFT_SIGNER_PRIVATE_KEY: HARDHAT_ACCOUNT_0_PRIVATE_KEY,
      NFT_SIGNER_ADDRESS: HARDHAT_ACCOUNT_0,
      NFT_BASE_URI: "http://localhost:3000/api/nft/metadata/",
    });

    // Set environment variables for current process
    process.env.NFT_CONTRACT_ADDRESS = nftContractAddress;
    process.env.NFT_CHAIN_ID = "31337";
    process.env.NFT_SIGNER_PRIVATE_KEY = HARDHAT_ACCOUNT_0_PRIVATE_KEY;
    process.env.NFT_SIGNER_ADDRESS = HARDHAT_ACCOUNT_0;
    process.env.NFT_BASE_URI = "http://localhost:3000/api/nft/metadata/";

    // Seed NFT collection and create test snapshot
    await seedNftData(nftContractAddress);
  } catch (error) {
    console.warn(
      "⚠️  NFT contract deployment failed (non-critical):",
      error,
      "Script",
    );
    console.warn(
      "   NFT minting will not be available in local dev",
      undefined,
      "Script",
    );
  }
}

/**
 * Update .env file with key-value pairs
 */
function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (envContent.match(regex)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  writeFileSync(envPath, envContent);
}

/**
 * Seed NFT collection and create test snapshot for local development
 */
async function seedNftData(contractAddress: string): Promise<void> {
  console.info("Seeding NFT collection...", undefined, "Script");

  try {
    // Set env vars for the seed script
    const env = {
      ...process.env,
      NFT_CONTRACT_ADDRESS: contractAddress,
      NFT_CHAIN_ID: "31337",
    };

    // Run the NFT collection seeder
    await $`bun run scripts/seed-nft-collection.ts`.env(env).quiet();
    console.info("✅ NFT collection seeded", undefined, "Script");

    // Create test snapshot for development (makes Hardhat account #0 eligible)
    await $`bun run scripts/seed-nft-snapshot-local.ts`
      .env(env)
      .quiet()
      .nothrow();
    console.info(
      "✅ Test NFT snapshot created (you can mint!)",
      undefined,
      "Script",
    );
  } catch (error) {
    console.warn("⚠️  NFT seeding had issues (non-critical):", error, "Script");
  }
}

main().catch((error) => {
  console.error("Failed to deploy contracts", error, "Script");
  process.exit(1);
});
