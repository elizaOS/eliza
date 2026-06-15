#!/usr/bin/env bun

/**
 * Status Commands
 *
 * Commands:
 *   game    - Game status (running/paused, tick info)
 *   wallet  - Wallet status (balance, nonce, pending txs)
 *   agent0  - Agent0 registration and configuration
 *   all     - Show all status (default)
 */

import { execSync } from "node:child_process";
import { getAgentLLMStatus } from "@feed/agents/llm";
import {
  actorState,
  checkDatabaseHealth,
  closeDatabase,
  db,
  count as drizzleCount,
  eq,
  gameConfigs,
  games,
  gte,
  isNotNull,
  organizationState,
  posts,
  questions,
  worldEvents,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { ethers } from "ethers";
import { parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";

function printHelp(): void {
  console.log(`
System Status

USAGE:
  feed status [target]

TARGETS:
  game      Game status (running/paused, tick info)
  wallet    Wallet status (balance, nonce, pending txs)
  agent0    Agent0 registration and configuration
  llm       Agent LLM provider status
  all       Show all status (default)

EXAMPLES:
  feed status           Show all status
  feed status game      Game status only
  feed status llm       LLM provider status
`);
}

async function checkGameStatus(): Promise<void> {
  logger.header("🎮 Game Status");

  const isHealthy = await checkDatabaseHealth();
  if (isHealthy) {
    logger.success("Database connected");
  } else {
    logger.fail("Database connection failed");
    process.exit(1);
  }

  // Get actor count from static registry + actorState
  const staticActorCount = StaticDataRegistry.getAllActors().length;
  const actorStateCount = await db
    .select({ count: drizzleCount() })
    .from(actorState);
  const stateCount = Number(actorStateCount[0]?.count || 0);
  console.log(`Actors: ${staticActorCount} static, ${stateCount} with state`);

  if (staticActorCount === 0) {
    logger.warn("No actors defined! Check the active pack actor definitions.");
  }

  const questionCountResult = await db
    .select({ count: drizzleCount() })
    .from(questions);
  const questionCount = Number(questionCountResult[0]?.count || 0);

  const activeQuestionsResult = await db
    .select({ count: drizzleCount() })
    .from(questions)
    .where(eq(questions.status, "active"));
  const activeQuestions = Number(activeQuestionsResult[0]?.count || 0);
  console.log(`Questions: ${questionCount} total, ${activeQuestions} active`);

  const postCountResult = await db
    .select({ count: drizzleCount() })
    .from(posts);
  const postCount = Number(postCountResult[0]?.count || 0);

  const recentPostsResult = await db
    .select({ count: drizzleCount() })
    .from(posts)
    .where(gte(posts.createdAt, new Date(Date.now() - 5 * 60 * 1000)));
  const recentPosts = Number(recentPostsResult[0]?.count || 0);
  console.log(`Posts: ${postCount} total, ${recentPosts} in last 5 minutes`);

  if (recentPosts === 0 && postCount > 0) {
    logger.warn("No recent posts - game tick might not be running");
  } else if (recentPosts > 0) {
    logger.success("Content is being generated");
  }

  const gameResult = await db
    .select()
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);
  const game = gameResult[0] || null;
  if (game) {
    console.log("\nGame State:");
    console.log(`  Status: ${game.isRunning ? "✅ RUNNING" : "⏸️  PAUSED"}`);
    console.log(`  Current Day: ${game.currentDay}`);
    console.log(`  Current Date: ${game.currentDate.toLocaleString()}`);
    console.log(`  Active Questions: ${game.activeQuestions}`);
    console.log(`  Speed: ${game.speed}ms between ticks`);
    console.log(
      `  Last Tick: ${game.lastTickAt ? game.lastTickAt.toLocaleString() : "Never"}`,
    );

    if (!game.isRunning) {
      console.log("\n💡 To start: feed game start");
    }
  } else {
    logger.warn("No game state found");
  }

  const eventCountResult = await db
    .select({ count: drizzleCount() })
    .from(worldEvents);
  const eventCount = Number(eventCountResult[0]?.count || 0);

  const recentEventsResult = await db
    .select({ count: drizzleCount() })
    .from(worldEvents)
    .where(gte(worldEvents.createdAt, new Date(Date.now() - 5 * 60 * 1000)));
  const recentEvents = Number(recentEventsResult[0]?.count || 0);
  console.log(
    `\nEvents: ${eventCount} total, ${recentEvents} in last 5 minutes`,
  );

  // Get organization count from static registry + organizationState
  const staticOrgCount = StaticDataRegistry.getAllOrganizations().length;
  const companyCount =
    StaticDataRegistry.getOrganizationsByType("company").length;

  const orgsWithPricesResult = await db
    .select({ count: drizzleCount() })
    .from(organizationState)
    .where(isNotNull(organizationState.currentPrice));
  const orgsWithPrices = Number(orgsWithPricesResult[0]?.count || 0);
  console.log(
    `Organizations: ${staticOrgCount} total, ${companyCount} companies, ${orgsWithPrices} with prices`,
  );
}

async function checkWalletStatus(): Promise<void> {
  logger.header("💳 Wallet Status");

  const gamePrivateKey =
    process.env.FEED_GAME_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  const gameWalletAddress = process.env.FEED_GAME_WALLET_ADDRESS;

  if (!gamePrivateKey || !gameWalletAddress) {
    logger.fail("Missing FEED_GAME_PRIVATE_KEY or FEED_GAME_WALLET_ADDRESS");
    return;
  }

  const rpcUrl =
    process.env.NEXT_PUBLIC_RPC_URL ||
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com";

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(gamePrivateKey, provider);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Expected: ${gameWalletAddress}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`\n💰 Balance: ${ethers.formatEther(balance)} ETH`);

  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const pendingNonce = await provider.getTransactionCount(
    wallet.address,
    "pending",
  );

  console.log(`📊 Nonce (confirmed): ${nonce}`);
  console.log(`📊 Nonce (pending): ${pendingNonce}`);

  if (pendingNonce > nonce) {
    logger.warn(`${pendingNonce - nonce} pending transaction(s) detected`);
  } else {
    logger.success("No pending transactions");
  }

  const feeData = await provider.getFeeData();
  console.log("\n⛽ Current Gas Price:");
  console.log(
    `   Max Fee: ${feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, "gwei") : "N/A"} gwei`,
  );
  console.log(
    `   Max Priority Fee: ${feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, "gwei") : "N/A"} gwei`,
  );

  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  console.log("\n🌐 Network Status:");
  console.log(`   Latest Block: ${blockNumber}`);
  console.log(
    `   Block Time: ${block?.timestamp ? new Date(block.timestamp * 1000).toISOString() : "N/A"}`,
  );
  console.log(
    `   Base Fee: ${block?.baseFeePerGas ? ethers.formatUnits(block?.baseFeePerGas, "gwei") : "N/A"} gwei`,
  );
}

async function checkLLMStatus(): Promise<void> {
  logger.header("🧠 Agent LLM Status");

  const status = await getAgentLLMStatus();

  console.log(`Provider: ${status.provider}`);
  console.log(`Available: ${status.available ? "✅ Yes" : "❌ No"}`);

  if (status.model) {
    console.log(`Model: ${status.model}`);
  }

  if (status.error) {
    logger.warn(`Error: ${status.error}`);
  }

  console.log("\nEnvironment:");
  console.log(
    `  AGENT_LLM_PROVIDER: ${process.env.AGENT_LLM_PROVIDER || "groq (default)"}`,
  );
  console.log(
    `  OLLAMA_HOST: ${process.env.OLLAMA_HOST || "http://localhost:11434"}`,
  );
  console.log(
    `  HUGGINGFACE_API_KEY: ${process.env.HUGGINGFACE_API_KEY ? "✅ Set" : "❌ Not set"}`,
  );
  console.log(
    `  GROQ_API_KEY: ${process.env.GROQ_API_KEY ? "✅ Set" : "❌ Not set"}`,
  );

  if (status.available) {
    logger.success("LLM provider is ready");
  } else {
    logger.fail("LLM provider is not available");
  }
}

async function checkAgent0Status(): Promise<void> {
  logger.header("🤖 Agent0 Status");

  console.log("Environment Variables:");
  console.log(`  AGENT0_ENABLED: ${process.env.AGENT0_ENABLED || "not set"}`);
  console.log(`  AGENT0_NETWORK: ${process.env.AGENT0_NETWORK || "not set"}`);
  console.log(
    `  FEED_REGISTRY_REGISTERED: ${process.env.FEED_REGISTRY_REGISTERED || "not set"}`,
  );
  console.log(
    `  FEED_GAME_WALLET_ADDRESS: ${process.env.FEED_GAME_WALLET_ADDRESS || "not set"}`,
  );
  console.log(
    `  PINATA_JWT: ${process.env.PINATA_JWT ? "✅ Set" : "❌ Not set"}`,
  );

  try {
    const configResult = await db
      .select()
      .from(gameConfigs)
      .where(eq(gameConfigs.key, "agent0_registration"))
      .limit(1);
    const config = configResult[0] || null;

    if (
      config?.value &&
      typeof config.value === "object" &&
      "tokenId" in config.value
    ) {
      const regValue = config.value as {
        tokenId: unknown;
        metadataCID?: unknown;
        registeredAt?: unknown;
      };

      console.log("\n✅ Database Registration Found:");
      console.log(`   Token ID: ${regValue.tokenId}`);
      console.log(`   Metadata CID: ${regValue.metadataCID}`);
      console.log(`   Registered At: ${regValue.registeredAt}`);

      const tokenId = Number(regValue.tokenId);
      const registryAddress = "0x8004a6090Cd10A7288092483047B097295Fb8847";
      const rpcUrl =
        process.env.NEXT_PUBLIC_RPC_URL ||
        process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia-rpc.publicnode.com";

      console.log("\n🔗 Checking On-Chain Registration:");
      console.log(`   Registry: ${registryAddress}`);
      console.log(`   Token ID: ${tokenId}`);

      try {
        const owner = execSync(
          `cast call ${registryAddress} "ownerOf(uint256)(address)" ${tokenId} --rpc-url ${rpcUrl}`,
          { encoding: "utf-8" },
        ).trim();

        logger.success("On-chain registration confirmed");
        console.log(`   Owner: ${owner}`);

        if (
          owner.toLowerCase() ===
          process.env.FEED_GAME_WALLET_ADDRESS?.toLowerCase()
        ) {
          logger.success("Owner matches FEED_GAME_WALLET_ADDRESS");
        } else {
          logger.warn("Owner does NOT match FEED_GAME_WALLET_ADDRESS");
        }

        const tokenURI = execSync(
          `cast call ${registryAddress} "tokenURI(uint256)(string)" ${tokenId} --rpc-url ${rpcUrl}`,
          { encoding: "utf-8" },
        )
          .trim()
          .replace(/"/g, "");

        console.log("\n📄 Token URI:");
        console.log(`   ${tokenURI}`);

        const cid = tokenURI.replace("ipfs://", "");
        console.log("\n🌐 View metadata:");
        console.log(`   https://ipfs.io/ipfs/${cid}`);
      } catch {
        logger.warn("Could not verify on-chain registration");
      }
    } else {
      logger.warn("No registration found in database");
      console.log("   See CLAUDE.md for Agent0 setup instructions");
    }
  } catch {
    logger.warn("Database not available");
  }
}

async function showAllStatus(): Promise<void> {
  await checkGameStatus();
  await checkWalletStatus();
  await checkAgent0Status();
  await checkLLMStatus();

  logger.header("✅ Status Check Complete");
}

/**
 * Main entry point for status domain commands.
 *
 * @param args - Raw command-line arguments for the status domain
 */
export async function runStatusCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (parsed.command || "all") {
      case "game":
        await checkGameStatus();
        break;

      case "wallet":
        await checkWalletStatus();
        break;

      case "agent0":
        await checkAgent0Status();
        break;

      case "llm":
        await checkLLMStatus();
        break;

      case "all":
        await showAllStatus();
        break;

      default:
        logger.fail(`Unknown target: ${parsed.command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await closeDatabase();
  }
}
