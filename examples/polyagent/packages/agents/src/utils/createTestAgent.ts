/**
 * Test Agent Creation Utility
 *
 * Creates test agents for benchmarking and RL training with proper configuration.
 *
 * @packageDocumentation
 */

import { db, eq, like, userAgentConfigs, users } from "@polyagent/db";
import { ethers } from "ethers";
import { agentRegistry } from "../services/agent-registry.service";
import { getAgentConfig } from "../shared/agent-config";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";

export interface TestAgentConfig {
  username?: string;
  displayName?: string;
  virtualBalance?: number;
  autonomousTrading?: boolean;
  autonomousPosting?: boolean;
  autonomousCommenting?: boolean;
  autonomousDMs?: boolean;
  autonomousGroupChats?: boolean;
  systemPrompt?: string;
  modelTier?: "lite" | "standard" | "pro";
}

export interface CreateTestAgentResult {
  agentId: string;
  created: boolean;
  agent: {
    id: string;
    username: string;
    displayName: string | null;
    isAgent: boolean;
  };
}

/**
 * Creates or gets a test agent
 *
 * @param prefix - Username prefix for the test agent
 * @param config - Test agent configuration
 * @returns Test agent creation result
 */
export async function createTestAgent(
  prefix = "test-agent",
  config: TestAgentConfig = {},
): Promise<CreateTestAgentResult> {
  const {
    username,
    displayName = `${prefix} ${Date.now().toString().slice(-6)}`,
    virtualBalance = 10000,
    autonomousTrading = true,
    autonomousPosting = true,
    autonomousCommenting = true,
    autonomousDMs = false,
    autonomousGroupChats = false,
    systemPrompt = "You are an autonomous trading agent on Polyagent prediction markets. Make smart trading decisions based on market analysis.",
    modelTier = "lite",
  } = config;

  // Try to find existing agent with same prefix
  let agentResult;
  if (username) {
    agentResult = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
  } else {
    agentResult = await db
      .select()
      .from(users)
      .where(like(users.username, `${prefix}%`))
      .limit(1);
  }

  let agent = agentResult[0];
  let created = false;

  if (!agent) {
    // Create new agent
    const agentId = await generateSnowflakeId();
    const finalUsername = username || `${prefix}-${agentId.slice(-6)}`;

    // Insert user record
    const newAgentResult = await db
      .insert(users)
      .values({
        id: agentId,
        privyId: `did:privy:${prefix}-${agentId}`,
        username: finalUsername,
        displayName,
        walletAddress: ethers.Wallet.createRandom().address,
        isAgent: true,
        virtualBalance: String(virtualBalance),
        reputationPoints: 1000,
        isTest: true,
        updatedAt: new Date(),
      })
      .returning();

    agent = newAgentResult[0]!;

    // Insert agent config record
    const configId = await generateSnowflakeId();
    await db.insert(userAgentConfigs).values({
      id: configId,
      userId: agentId,
      autonomousTrading,
      autonomousPosting,
      autonomousCommenting,
      autonomousDMs,
      autonomousGroupChats,
      systemPrompt,
      modelTier,
      updatedAt: new Date(),
    });

    created = true;

    logger.info("Created test agent", {
      agentId: agent.id,
      username: agent.username,
      displayName: agent.displayName,
    });
  } else {
    logger.info("Using existing test agent", {
      agentId: agent.id,
      username: agent.username,
    });
  }

  // Register in Agent Registry if not already registered
  if (agent.isAgent) {
    try {
      // Check if already registered
      const existingReg = await agentRegistry.getAgentById(agent.id);

      if (!existingReg) {
        logger.info("Registering user agent...", { userId: agent.id });

        // Get agent config for system prompt
        const agentConfig = await getAgentConfig(agent.id);

        await agentRegistry.registerUserAgent({
          userId: agent.id,
          name: agent.displayName || agent.username || "Test Agent",
          systemPrompt:
            agentConfig?.systemPrompt ||
            "You are a helpful AI agent on Polyagent prediction market.",
          capabilities: {
            strategies: [
              "prediction_markets",
              "social_interaction",
              "trading_analysis",
            ],
            markets: ["prediction", "perpetual", "spot"],
            actions: [
              "trade",
              "post",
              "comment",
              "like",
              "message",
              "analyze_market",
              "manage_portfolio",
            ],
            version: "1.0.0",
            x402Support: true,
            platform: "polyagent",
            userType: "user_controlled",
            skills: [],
            domains: [],
          },
        });
        logger.info("Registered test agent in registry", {
          agentId: agent.id,
        });
      }
    } catch (err) {
      // Registration may fail if already registered, that's ok
      logger.debug("Agent registry registration", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    agentId: agent.id,
    created,
    agent: {
      id: agent.id,
      username: agent.username!,
      displayName: agent.displayName,
      isAgent: agent.isAgent,
    },
  };
}

/**
 * Helper to create multiple test agents
 *
 * @param count - Number of agents to create
 * @param prefix - Username prefix
 * @param baseConfig - Base configuration for all agents
 * @returns Array of created agents
 */
export async function createTestAgents(
  count: number,
  prefix = "test-agent",
  baseConfig: TestAgentConfig = {},
): Promise<CreateTestAgentResult[]> {
  const results: CreateTestAgentResult[] = [];

  for (let i = 0; i < count; i++) {
    const result = await createTestAgent(`${prefix}-${i}`, baseConfig);
    results.push(result);
  }

  return results;
}

/**
 * Cleanup test agents
 *
 * @param prefix - Username prefix to match
 * @returns Number of agents deleted
 */
export async function cleanupTestAgents(
  prefix = "test-agent",
): Promise<number> {
  // Get test agents
  const testAgents = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.username, `${prefix}%`));

  if (testAgents.length === 0) {
    return 0;
  }

  // Delete agent configs first
  for (const agent of testAgents) {
    await db
      .delete(userAgentConfigs)
      .where(eq(userAgentConfigs.userId, agent.id));
  }

  // Delete the agents
  const result = await db
    .delete(users)
    .where(like(users.username, `${prefix}%`))
    .returning({ id: users.id });

  logger.info(`Cleaned up ${result.length} test agents`);
  return result.length;
}
