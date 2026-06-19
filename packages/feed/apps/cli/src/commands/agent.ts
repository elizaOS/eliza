#!/usr/bin/env bun

/**
 * @fileoverview Agent management commands
 *
 * Provides commands for creating test agents, listing agents, and managing
 * autonomous features for agents. Also includes Agent0 integration configuration.
 *
 * @module cli/commands/agent
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestAgent } from "@feed/agents";
import { closeDatabase, db, desc, eq, userAgentConfigs, users } from "@feed/db";
import { getFlag, getOption, parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";

function printHelp(): void {
  console.log(`
Agent Management

USAGE:
  feed agent <command> [options]

COMMANDS:
  spawn     Create test agents for simulation/training
  list      List agents in the system
  enable    Enable autonomous features for an agent
  disable   Disable autonomous features for an agent

OPTIONS (spawn):
  -c, --count=N          Number of agents to create (default: 5)
  -p, --prefix=NAME      Prefix for agent usernames (default: test-agent)
  --trading              Enable autonomous trading
  --posting              Enable autonomous posting
  --all                  Enable all autonomous features

OPTIONS (list):
  --active               Only show agents with active features
  --limit=N              Limit results (default: 20)

OPTIONS (enable/disable):
  --id=ID                Agent ID (required)
  --trading              Toggle trading
  --posting              Toggle posting
  --commenting           Toggle commenting
  --dms                  Toggle DMs
  --groups               Toggle group chats
  --all                  Toggle all features

EXAMPLES:
  feed agent spawn --count=10 --trading --posting
  feed agent spawn -c 5 -p scammer --all
  feed agent list --active
  feed agent enable --id=abc123 --trading
  feed agent disable --id=abc123 --all
`);
}

async function spawnAgents(args: ReturnType<typeof parseArgs>): Promise<void> {
  const count = parseInt(getOption(args, "count", "c") || "5", 10);
  const prefix = getOption(args, "prefix", "p") || "test-agent";
  const enableTrading = getFlag(args, "trading");
  const enablePosting = getFlag(args, "posting");
  const enableAll = getFlag(args, "all");

  logger.header("Spawn Test Agents");

  console.log(`Creating ${count} agents with prefix "${prefix}"...`);

  const createdAgents: Array<{ username: string; id: string }> = [];

  for (let i = 0; i < count; i++) {
    const result = await createTestAgent(`${prefix}-${i}`, {
      autonomousTrading: enableTrading || enableAll,
      autonomousPosting: enablePosting || enableAll,
      autonomousCommenting: enableAll,
      autonomousDMs: enableAll,
      autonomousGroupChats: enableAll,
    });

    createdAgents.push({
      username: result.agent.username,
      id: result.agent.id,
    });
    console.log(`  ✅ Created: ${result.agent.username} (${result.agent.id})`);
  }

  logger.header("Summary");
  console.log(`Created: ${createdAgents.length}/${count} agents`);

  if (createdAgents.length > 0) {
    console.log("\nAgents created:");
    for (const agent of createdAgents) {
      console.log(`  - ${agent.username} (${agent.id})`);
    }
  }
}

async function listAgents(args: ReturnType<typeof parseArgs>): Promise<void> {
  const activeOnly = getFlag(args, "active");
  const limit = parseInt(getOption(args, "limit") || "20", 10);

  logger.header("Agents");

  // Query agents with their configs using a join
  const baseQuery = db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      createdAt: users.createdAt,
      virtualBalance: users.virtualBalance,
      autonomousTrading: userAgentConfigs.autonomousTrading,
      autonomousPosting: userAgentConfigs.autonomousPosting,
      autonomousCommenting: userAgentConfigs.autonomousCommenting,
      autonomousDMs: userAgentConfigs.autonomousDMs,
      autonomousGroupChats: userAgentConfigs.autonomousGroupChats,
    })
    .from(users)
    .leftJoin(userAgentConfigs, eq(users.id, userAgentConfigs.userId))
    .where(eq(users.isAgent, true))
    .orderBy(desc(users.createdAt))
    .limit(limit);

  const agents = await baseQuery;

  // Filter for active agents if requested
  const filteredAgents = activeOnly
    ? agents.filter(
        (a) =>
          a.autonomousTrading ||
          a.autonomousPosting ||
          a.autonomousCommenting ||
          a.autonomousDMs ||
          a.autonomousGroupChats,
      )
    : agents;

  if (filteredAgents.length === 0) {
    console.log("No agents found.");
    console.log("\nCreate agents with: feed agent spawn");
    return;
  }

  console.log(`Found ${filteredAgents.length} agent(s):\n`);

  for (const agent of filteredAgents) {
    const features = [];
    if (agent.autonomousTrading) features.push("trading");
    if (agent.autonomousPosting) features.push("posting");
    if (agent.autonomousCommenting) features.push("commenting");
    if (agent.autonomousDMs) features.push("dms");
    if (agent.autonomousGroupChats) features.push("groups");

    console.log(`${"─".repeat(60)}`);
    console.log(`Username:   ${agent.username || "N/A"}`);
    console.log(`ID:         ${agent.id}`);
    console.log(`Balance:    ${Number(agent.virtualBalance ?? 0).toFixed(2)}`);
    console.log(
      `Features:   ${features.length > 0 ? features.join(", ") : "none"}`,
    );
    console.log(`Created:    ${agent.createdAt.toISOString()}`);
  }
  console.log(`${"─".repeat(60)}`);
}

function getEnvValue(envContent: string, key: string): string | null {
  const regex = new RegExp(`^${key}=(.*)$`, "m");
  const match = envContent.match(regex);
  return match?.[1] ? match[1].trim().replace(/['"]/g, "") : null;
}

async function configureAgent0(): Promise<void> {
  logger.header("Agent0 Configuration");

  const envPath = join(process.cwd(), ".env.testnet");
  let envContent = "";

  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  // Check current configuration
  console.log("Current Agent0 configuration:\n");

  const currentConfig = {
    enabled: getEnvValue(envContent, "AGENT0_ENABLED"),
    network: getEnvValue(envContent, "AGENT0_NETWORK"),
    rpcUrl: getEnvValue(envContent, "AGENT0_RPC_URL"),
    privateKey: getEnvValue(envContent, "FEED_GAME_PRIVATE_KEY"),
    subgraphUrl: getEnvValue(envContent, "AGENT0_SUBGRAPH_URL"),
    ipfsProvider: getEnvValue(envContent, "AGENT0_IPFS_PROVIDER"),
    pinataJwt: getEnvValue(envContent, "PINATA_JWT"),
  };

  console.log(
    `  AGENT0_ENABLED:         ${currentConfig.enabled || "not set"}`,
  );
  console.log(
    `  AGENT0_NETWORK:         ${currentConfig.network || "not set"}`,
  );
  console.log(
    `  AGENT0_RPC_URL:         ${currentConfig.rpcUrl ? "✅ set" : "❌ not set"}`,
  );
  console.log(
    `  FEED_GAME_PRIVATE_KEY: ${currentConfig.privateKey ? "✅ set" : "❌ not set"}`,
  );
  console.log(
    `  AGENT0_SUBGRAPH_URL:    ${currentConfig.subgraphUrl || "not set"}`,
  );
  console.log(
    `  AGENT0_IPFS_PROVIDER:   ${currentConfig.ipfsProvider || "node"}`,
  );

  // Update configuration
  const updates: Record<string, string> = {};

  if (!currentConfig.enabled || currentConfig.enabled !== "true") {
    updates.AGENT0_ENABLED = "true";
  }

  if (!currentConfig.network || currentConfig.network !== "sepolia") {
    updates.AGENT0_NETWORK = "sepolia";
  }

  if (!currentConfig.rpcUrl) {
    updates.AGENT0_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
    updates.ETHEREUM_SEPOLIA_RPC_URL =
      "https://ethereum-sepolia-rpc.publicnode.com";
  }

  if (!currentConfig.subgraphUrl) {
    updates.AGENT0_SUBGRAPH_URL =
      "https://api.studio.thegraph.com/query/your-subgraph-id/agent0/version/latest";
  }

  if (!currentConfig.ipfsProvider) {
    updates.AGENT0_IPFS_PROVIDER = "node";
  }

  // Apply updates
  if (Object.keys(updates).length > 0) {
    console.log("\nApplying configuration updates...");

    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (envContent.match(regex)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    writeFileSync(envPath, envContent);
    logger.success("Configuration updated in .env.testnet");
  } else {
    console.log("\n✅ Configuration is already up to date");
  }

  // Show next steps
  console.log(`\n${"─".repeat(60)}`);
  console.log("Next steps:\n");

  if (!currentConfig.privateKey) {
    console.log("1. Set FEED_GAME_PRIVATE_KEY in .env.testnet");
    console.log("   (Private key for game agent, needs ETH for registration)");
  }

  if (
    !currentConfig.subgraphUrl ||
    currentConfig.subgraphUrl.includes("your-subgraph-id")
  ) {
    console.log("2. Update AGENT0_SUBGRAPH_URL in .env.testnet");
    console.log("   (Get from The Graph Studio)");
  }

  if (!currentConfig.pinataJwt) {
    console.log("3. (Optional) Set PINATA_JWT for Pinata IPFS");
    console.log("   (Get from https://pinata.cloud)");
  }

  console.log("\n4. Start testnet dev: bun run dev:testnet");
}

async function toggleAgentFeatures(
  args: ReturnType<typeof parseArgs>,
  enable: boolean,
): Promise<void> {
  const agentId = getOption(args, "id");

  if (!agentId) {
    logger.fail("--id is required");
    printHelp();
    process.exit(1);
  }

  const agentResult = await db
    .select()
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);
  const agent = agentResult[0] || null;

  if (!agent) {
    logger.fail(`Agent not found: ${agentId}`);
    process.exit(1);
  }

  if (!agent.isAgent) {
    logger.fail("User is not an agent");
    process.exit(1);
  }

  const updates: Record<string, boolean> = {};

  if (getFlag(args, "trading")) updates.autonomousTrading = enable;
  if (getFlag(args, "posting")) updates.autonomousPosting = enable;
  if (getFlag(args, "commenting")) updates.autonomousCommenting = enable;
  if (getFlag(args, "dms")) updates.autonomousDMs = enable;
  if (getFlag(args, "groups")) updates.autonomousGroupChats = enable;

  if (getFlag(args, "all")) {
    updates.autonomousTrading = enable;
    updates.autonomousPosting = enable;
    updates.autonomousCommenting = enable;
    updates.autonomousDMs = enable;
    updates.autonomousGroupChats = enable;
  }

  if (Object.keys(updates).length === 0) {
    logger.fail("No features specified");
    console.log("\nSpecify features to toggle:");
    console.log("  --trading, --posting, --commenting, --dms, --groups, --all");
    process.exit(1);
  }

  // Check if agent config exists
  const configResult = await db
    .select()
    .from(userAgentConfigs)
    .where(eq(userAgentConfigs.userId, agentId))
    .limit(1);

  if (!configResult[0]) {
    logger.fail(`Agent config not found for: ${agentId}`);
    console.log("\nThe agent may not have been properly initialized.");
    process.exit(1);
  }

  await db
    .update(userAgentConfigs)
    .set(updates)
    .where(eq(userAgentConfigs.userId, agentId));

  const action = enable ? "Enabled" : "Disabled";
  logger.success(`${action} features for ${agent.username || agentId}`);

  console.log("\nUpdated features:");
  for (const [key, value] of Object.entries(updates)) {
    const featureName = key.replace("autonomous", "").toLowerCase();
    console.log(`  ${featureName}: ${value ? "✅" : "❌"}`);
  }
}

/**
 * Main entry point for agent domain commands.
 *
 * @param args - Raw command-line arguments for the agent domain
 */
export async function runAgentCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  switch (parsed.command) {
    case "spawn":
      await spawnAgents(parsed);
      break;

    case "list":
      await listAgents(parsed);
      break;

    case "enable":
      await toggleAgentFeatures(parsed, true);
      break;

    case "disable":
      await toggleAgentFeatures(parsed, false);
      break;

    case "agent0-config":
      await configureAgent0();
      break;

    default:
      if (parsed.command) {
        logger.fail(`Unknown command: ${parsed.command}`);
      }
      printHelp();
      process.exit(parsed.command ? 1 : 0);
  }

  await closeDatabase();
}
