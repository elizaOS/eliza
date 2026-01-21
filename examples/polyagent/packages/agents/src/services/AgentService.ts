/**
 * Agent Service v2 - Agents are Users
 *
 * Core service for agent lifecycle management. Agents are implemented as users
 * with isAgent=true, allowing them to participate fully in the platform.
 *
 * @remarks
 * Architecture: Agents ARE users (isAgent=true), not separate entities.
 * They can post, comment, join chats, trade, and do everything users can do.
 * The creating user "manages" them via the managedBy field.
 * Agent configuration is stored in the UserAgentConfig table.
 *
 * @packageDocumentation
 */

import {
  agentLogs,
  agentMessages,
  agentPerformanceMetrics,
  agentPointsTransactions,
  agentTrades,
  and,
  balanceTransactions,
  count,
  db,
  desc,
  eq,
  isNotNull,
  lt,
  positions,
  sql,
  type User,
  type UserAgentConfig,
  userAgentConfigs,
  users,
  withTransaction,
} from "@babylon/db";
import type { AgentCapabilities } from "@babylon/shared";
import {
  BABYLON_POINTS_SYMBOL,
  getCurrentChainId,
  IDENTITY_REGISTRY_BASE_SEPOLIA,
  REPUTATION_SYSTEM_BASE_SEPOLIA,
} from "@babylon/shared";
import { AuthorizationError } from "../errors";
import { agentIdentityService } from "../identity/AgentIdentityService";
import { agentRuntimeManager } from "../runtime/AgentRuntimeManager";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";
import type { AgentPerformance, CreateAgentParams } from "../types";
import type { JsonValue } from "../types/common";
import { agentRegistry } from "./agent-registry.service";

/** User with agent configuration */
export type UserWithConfig = User & { agentConfig: UserAgentConfig | null };

/**
 * Get agent config for a user
 */
export async function getAgentConfig(
  userId: string,
): Promise<UserAgentConfig | null> {
  const result = await db
    .select()
    .from(userAgentConfigs)
    .where(eq(userAgentConfigs.userId, userId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get user with their agent config
 */
export async function getUserWithConfig(
  userId: string,
): Promise<UserWithConfig | null> {
  const userResult = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const user = userResult[0];
  if (!user) return null;

  const config = await getAgentConfig(userId);
  return { ...user, agentConfig: config };
}

/**
 * Service for agent lifecycle management
 */
export class AgentServiceV2 {
  /**
   * Creates a new agent (creates a full User with isAgent=true)
   *
   * Creates a complete user account with agent capabilities, wallet, and
   * initial configuration. The agent can immediately participate in all
   * platform activities.
   *
   * @param params - Agent creation parameters
   * @returns Created user/agent entity
   * @throws Error if manager not found or insufficient points for deposit
   */
  async createAgent(params: CreateAgentParams): Promise<User> {
    const {
      userId: managerUserId,
      name,
      username: providedUsername,
      description,
      profileImageUrl,
      coverImageUrl,
      system,
      bio,
      personality,
      tradingStrategy,
      initialDeposit,
    } = params;

    const managerResult = await db
      .select()
      .from(users)
      .where(eq(users.id, managerUserId))
      .limit(1);

    const manager = managerResult[0];
    if (!manager) throw new Error("Manager user not found");

    if (initialDeposit && initialDeposit > 0) {
      const managerBalance = Number(manager.virtualBalance ?? 0);
      if (managerBalance < initialDeposit) {
        throw new Error(
          `Insufficient balance. Have: $${managerBalance.toFixed(2)}, Need: $${initialDeposit.toFixed(2)}`,
        );
      }
    }

    // Use provided username or generate one
    let agentUsername: string;
    if (providedUsername) {
      const trimmed = providedUsername.trim().toLowerCase();

      // Validate format - reject invalid characters instead of sanitizing
      if (!/^[a-z0-9_]+$/.test(trimmed)) {
        throw new Error(
          "Username can only contain lowercase letters, numbers, and underscores",
        );
      }

      // Validate username length
      if (trimmed.length < 3) {
        throw new Error("Username must be at least 3 characters");
      }
      if (trimmed.length > 20) {
        throw new Error("Username must be at most 20 characters");
      }

      agentUsername = trimmed;

      // Check uniqueness
      const existingUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, agentUsername))
        .limit(1);
      if (existingUser.length > 0) {
        throw new Error(`Username '${agentUsername}' is already taken`);
      }
    } else {
      // Auto-generate username for programmatic use cases
      const baseUsername = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .substring(0, 20);
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      agentUsername = `${baseUsername}_${randomSuffix}`;
    }
    const agentUserId = await generateSnowflakeId();

    const agent = await withTransaction(async (tx) => {
      // Create the user record
      const newAgentResult = await tx
        .insert(users)
        .values({
          id: agentUserId,
          username: agentUsername,
          displayName: name,
          bio:
            description ||
            `AI agent managed by ${manager.displayName || manager.username}`,
          profileImageUrl: profileImageUrl || null,
          coverImageUrl: coverImageUrl || null,
          isAgent: true,
          managedBy: managerUserId,
          virtualBalance: "0",
          totalDeposited: "0",
          reputationPoints: 0,
          profileComplete: true,
          hasUsername: true,
          hasBio: Boolean(description),
          hasProfileImage: Boolean(profileImageUrl),
          updatedAt: new Date(),
        })
        .returning();

      const newAgent = newAgentResult[0]!;

      // Create the agent config record with all autonomous capabilities enabled by default
      await tx.insert(userAgentConfigs).values({
        id: await generateSnowflakeId(),
        userId: agentUserId,
        systemPrompt: system ?? null,
        personality: personality ?? null,
        tradingStrategy: tradingStrategy ?? null,
        messageExamples: bio ? JSON.parse(JSON.stringify(bio)) : null,
        a2aEnabled: true,
        autonomousPosting: true,
        autonomousCommenting: true,
        autonomousTrading: true,
        autonomousDMs: true,
        autonomousGroupChats: true,
        updatedAt: new Date(),
      });

      // Transfer initial deposit from manager to agent's virtualBalance
      if (initialDeposit && initialDeposit > 0) {
        const initialManagerBalance = Number(manager.virtualBalance ?? 0);

        // Debit from manager's trading balance
        await tx
          .update(users)
          .set({
            virtualBalance: String(initialManagerBalance - initialDeposit),
            updatedAt: new Date(),
          })
          .where(eq(users.id, managerUserId));

        // Credit to agent's virtualBalance
        await tx
          .update(users)
          .set({
            virtualBalance: String(initialDeposit),
            totalDeposited: String(initialDeposit),
            updatedAt: new Date(),
          })
          .where(eq(users.id, agentUserId));

        // Record balance transaction for manager (debit)
        await tx.insert(balanceTransactions).values({
          id: await generateSnowflakeId(),
          userId: managerUserId,
          type: "agent_deposit",
          amount: String(-initialDeposit),
          balanceBefore: String(initialManagerBalance),
          balanceAfter: String(initialManagerBalance - initialDeposit),
          relatedId: agentUserId,
          description: `Initial deposit to agent: ${name}`,
        });

        // Record balance transaction for agent (credit)
        await tx.insert(balanceTransactions).values({
          id: await generateSnowflakeId(),
          userId: agentUserId,
          type: "owner_deposit",
          amount: String(initialDeposit),
          balanceBefore: "0",
          balanceAfter: String(initialDeposit),
          relatedId: managerUserId,
          description: "Initial deposit from owner",
        });
      }

      await tx.insert(agentLogs).values({
        id: await generateSnowflakeId(),
        agentUserId,
        type: "system",
        level: "info",
        message: `Agent created: ${name}`,
        metadata: { initialDeposit: initialDeposit || 0 },
      });

      return newAgent;
    });

    logger.info(
      `Agent user created: ${agentUserId} managed by ${managerUserId}`,
      undefined,
      "AgentService",
    );

    // Register agent in registry
    if (agentRegistry) {
      const capabilities: AgentCapabilities = {
        strategies: [
          "prediction_markets",
          "social_interaction",
          ...(tradingStrategy
            ? [`trading_${tradingStrategy.toLowerCase()}`]
            : []),
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
        platform: "babylon",
        userType: "user_controlled",
        gameNetwork: {
          chainId: getCurrentChainId(),
          registryAddress: IDENTITY_REGISTRY_BASE_SEPOLIA,
          reputationAddress: REPUTATION_SYSTEM_BASE_SEPOLIA,
        },
        skills: [],
        domains: [],
      };

      await agentRegistry.registerUserAgent({
        userId: agentUserId,
        name: name,
        systemPrompt:
          system || "You are a helpful AI agent on Babylon prediction market.",
        capabilities,
      });

      logger.info(
        `Agent ${agentUserId} registered in registry`,
        undefined,
        "AgentService",
      );
    }

    if (this.shouldAutoSetupAgentIdentity()) {
      void this.setupAgentIdentity(agentUserId);
    }

    return agent;
  }

  async getAgent(
    agentUserId: string,
    managerUserId?: string,
  ): Promise<User | null> {
    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agent = agentResult[0];
    if (!agent) return null;
    if (!agent.isAgent) throw new Error("User is not an agent");
    if (managerUserId && agent.managedBy !== managerUserId) {
      throw new AuthorizationError(
        "You do not have permission to access this agent. You can only chat with agents you own.",
        "agent",
        "chat",
      );
    }
    return agent;
  }

  /**
   * Get agent with config
   */
  async getAgentWithConfig(
    agentUserId: string,
    managerUserId?: string,
  ): Promise<UserWithConfig | null> {
    const agent = await this.getAgent(agentUserId, managerUserId);
    if (!agent) return null;

    const config = await getAgentConfig(agentUserId);
    return { ...agent, agentConfig: config };
  }

  async listUserAgents(
    managerUserId: string,
    filters?: { autonomousTrading?: boolean },
  ): Promise<User[]> {
    // If filtering by autonomousTrading, we need to join with userAgentConfigs
    if (filters?.autonomousTrading !== undefined) {
      const results = await db
        .select({ user: users })
        .from(users)
        .innerJoin(userAgentConfigs, eq(users.id, userAgentConfigs.userId))
        .where(
          and(
            eq(users.isAgent, true),
            eq(users.managedBy, managerUserId),
            eq(userAgentConfigs.autonomousTrading, filters.autonomousTrading),
          ),
        )
        .orderBy(desc(users.createdAt));

      return results.map((r) => r.user);
    }

    return db
      .select()
      .from(users)
      .where(and(eq(users.isAgent, true), eq(users.managedBy, managerUserId)))
      .orderBy(desc(users.createdAt));
  }

  async updateAgent(
    agentUserId: string,
    managerUserId: string,
    updates: Partial<{
      name: string;
      description: string;
      profileImageUrl: string;
      system: string;
      bio: string[]; // Bio array for ElizaOS agentMessageExamples
      personality: string;
      tradingStrategy: string;
      modelTier: "free" | "pro";
      autonomousTrading: boolean;
      autonomousPosting: boolean;
      autonomousCommenting: boolean;
      autonomousDMs: boolean;
      autonomousGroupChats: boolean;
      a2aEnabled: boolean;
    }>,
  ): Promise<User> {
    await this.getAgent(agentUserId, managerUserId); // Verify ownership

    if (
      updates.system ||
      updates.personality ||
      updates.modelTier ||
      updates.bio
    ) {
      await agentRuntimeManager.clearRuntime(agentUserId);
    }

    // Update user fields
    const userUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name) userUpdates.displayName = updates.name;
    if (updates.description) userUpdates.bio = updates.description;
    if (updates.profileImageUrl !== undefined)
      userUpdates.profileImageUrl = updates.profileImageUrl;

    if (Object.keys(userUpdates).length > 1) {
      await db.update(users).set(userUpdates).where(eq(users.id, agentUserId));
    }

    // Update agent config fields
    const configUpdates: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.system) configUpdates.systemPrompt = updates.system;
    if (updates.bio)
      configUpdates.messageExamples = JSON.stringify(updates.bio);
    if (updates.personality) configUpdates.personality = updates.personality;
    if (updates.tradingStrategy)
      configUpdates.tradingStrategy = updates.tradingStrategy;
    if (updates.modelTier) configUpdates.modelTier = updates.modelTier;
    if (updates.autonomousTrading !== undefined)
      configUpdates.autonomousTrading = updates.autonomousTrading;
    if (updates.autonomousPosting !== undefined)
      configUpdates.autonomousPosting = updates.autonomousPosting;
    if (updates.autonomousCommenting !== undefined)
      configUpdates.autonomousCommenting = updates.autonomousCommenting;
    if (updates.autonomousDMs !== undefined)
      configUpdates.autonomousDMs = updates.autonomousDMs;
    if (updates.autonomousGroupChats !== undefined)
      configUpdates.autonomousGroupChats = updates.autonomousGroupChats;
    if (updates.a2aEnabled !== undefined)
      configUpdates.a2aEnabled = updates.a2aEnabled;

    if (Object.keys(configUpdates).length > 1) {
      await db
        .update(userAgentConfigs)
        .set(configUpdates)
        .where(eq(userAgentConfigs.userId, agentUserId));
    }

    const updatedAgentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const updatedAgent = updatedAgentResult[0]!;

    await db.insert(agentLogs).values({
      id: await generateSnowflakeId(),
      agentUserId,
      type: "system",
      level: "info",
      message: "Agent configuration updated",
      metadata: updates,
    });

    logger.info(`Agent updated: ${agentUserId}`, undefined, "AgentService");
    return updatedAgent;
  }

  async deleteAgent(agentUserId: string, managerUserId: string): Promise<void> {
    const agentWithConfig = await this.getAgentWithConfig(
      agentUserId,
      managerUserId,
    );
    if (!agentWithConfig) throw new Error("Agent not found");

    // Get agent's remaining balance from users table
    const agentBalance = Number(agentWithConfig.virtualBalance ?? 0);

    await withTransaction(async (tx) => {
      // Return remaining balance to manager
      if (agentBalance > 0) {
        const managerResult = await tx
          .select({ virtualBalance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, managerUserId))
          .limit(1);

        const currentBalance = Number(managerResult[0]?.virtualBalance ?? 0);

        await tx
          .update(users)
          .set({
            virtualBalance: String(currentBalance + agentBalance),
            updatedAt: new Date(),
          })
          .where(eq(users.id, managerUserId));

        await tx.insert(balanceTransactions).values({
          id: await generateSnowflakeId(),
          userId: managerUserId,
          type: "agent_balance_return",
          amount: String(agentBalance),
          balanceBefore: String(currentBalance),
          balanceAfter: String(currentBalance + agentBalance),
          relatedId: agentUserId,
          description: `Balance returned from deleted agent: ${agentWithConfig.displayName}`,
        });
      }

      // Delete agent config
      await tx
        .delete(userAgentConfigs)
        .where(eq(userAgentConfigs.userId, agentUserId));

      // Delete agent user
      await tx.delete(users).where(eq(users.id, agentUserId));
    });

    // Clear runtime from agent runtime manager
    await agentRuntimeManager.clearRuntime(agentUserId);

    logger.info(`Agent deleted: ${agentUserId}`, undefined, "AgentService");
  }

  /**
   * Deposit to agent's virtualBalance from manager's virtualBalance
   * @deprecated Use depositTradingBalance instead - now unified
   *
   * @param agentUserId - Agent user ID
   * @param managerUserId - Manager (owner) user ID
   * @param amount - Amount to deposit
   * @returns Updated agent User
   * @throws Error if insufficient balance or agent not found
   */
  async depositPoints(
    agentUserId: string,
    managerUserId: string,
    amount: number,
  ): Promise<User> {
    // Delegate to depositTradingBalance - now unified
    return this.depositTradingBalance(agentUserId, managerUserId, amount);
  }

  /**
   * Withdraw from agent's virtualBalance to manager's virtualBalance
   * @deprecated Use withdrawTradingBalance instead - now unified
   */
  async withdrawPoints(
    agentUserId: string,
    managerUserId: string,
    amount: number,
  ): Promise<User> {
    // Delegate to withdrawTradingBalance - now unified
    return this.withdrawTradingBalance(agentUserId, managerUserId, amount);
  }

  /**
   * Deposit to agent's virtualBalance from manager's virtualBalance.
   *
   * This is the canonical method for all agent deposit operations.
   * The deprecated `depositPoints` method delegates to this.
   *
   * @param agentUserId - Agent user ID
   * @param managerUserId - Manager (owner) user ID
   * @param amount - Amount to deposit
   * @returns Updated agent User
   * @throws Error if insufficient balance or agent not found
   */
  async depositTradingBalance(
    agentUserId: string,
    managerUserId: string,
    amount: number,
  ): Promise<User> {
    if (amount <= 0) throw new Error("Amount must be positive");

    const agentWithConfig = await this.getAgentWithConfig(
      agentUserId,
      managerUserId,
    );
    if (!agentWithConfig) throw new Error("Agent not found");

    // Get manager's trading balance
    const managerResult = await db
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, managerUserId))
      .limit(1);

    const manager = managerResult[0];
    if (!manager) throw new Error("Manager not found");

    const managerBalance = Number(manager.virtualBalance ?? 0);
    if (managerBalance < amount) {
      throw new Error(
        `Insufficient trading balance. Have: $${managerBalance.toFixed(2)}, Need: $${amount.toFixed(2)}`,
      );
    }

    // Get agent's current balance and totalDeposited
    const agentResult = await db
      .select({
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agentBalance = Number(agentResult[0]?.virtualBalance ?? 0);
    const agentTotalDeposited = Number(agentResult[0]?.totalDeposited ?? 0);

    await withTransaction(async (tx) => {
      // Debit from manager
      await tx
        .update(users)
        .set({
          virtualBalance: String(managerBalance - amount),
          updatedAt: new Date(),
        })
        .where(eq(users.id, managerUserId));

      // Credit to agent (update both virtualBalance and totalDeposited)
      await tx
        .update(users)
        .set({
          virtualBalance: String(agentBalance + amount),
          totalDeposited: String(agentTotalDeposited + amount),
          updatedAt: new Date(),
        })
        .where(eq(users.id, agentUserId));

      // Record transaction for manager (debit)
      await tx.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId: managerUserId,
        type: "agent_deposit",
        amount: String(-amount),
        balanceBefore: String(managerBalance),
        balanceAfter: String(managerBalance - amount),
        relatedId: agentUserId,
        description: `Deposit to agent: ${agentWithConfig.displayName}`,
      });

      // Record transaction for agent (credit)
      await tx.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId: agentUserId,
        type: "owner_deposit",
        amount: String(amount),
        balanceBefore: String(agentBalance),
        balanceAfter: String(agentBalance + amount),
        relatedId: managerUserId,
        description: `Deposit from owner`,
      });
    });

    logger.info(
      `Deposited ${BABYLON_POINTS_SYMBOL}${amount} trading balance to agent ${agentUserId}`,
      undefined,
      "AgentService",
    );

    const finalResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    return finalResult[0]!;
  }

  /**
   * Withdraw trading balance (virtualBalance) from agent to manager.
   *
   * This is the canonical method for all agent withdrawal operations.
   * The deprecated `withdrawPoints` method delegates to this.
   * Transfers USD from agent's trading balance back to user's trading balance.
   *
   * @param agentUserId - Agent user ID
   * @param managerUserId - Manager (owner) user ID
   * @param amount - Amount to withdraw
   * @returns Updated agent User
   * @throws Error if insufficient balance or agent not found
   */
  async withdrawTradingBalance(
    agentUserId: string,
    managerUserId: string,
    amount: number,
  ): Promise<User> {
    if (amount <= 0) throw new Error("Amount must be positive");

    const agentWithConfig = await this.getAgentWithConfig(
      agentUserId,
      managerUserId,
    );
    if (!agentWithConfig) throw new Error("Agent not found");

    // Get agent's trading balance and totalWithdrawn
    const agentResult = await db
      .select({
        virtualBalance: users.virtualBalance,
        totalWithdrawn: users.totalWithdrawn,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agentBalance = Number(agentResult[0]?.virtualBalance ?? 0);
    const agentTotalWithdrawn = Number(agentResult[0]?.totalWithdrawn ?? 0);
    if (agentBalance < amount) {
      throw new Error(
        `Insufficient agent trading balance. Have: $${agentBalance.toFixed(2)}, Need: $${amount.toFixed(2)}`,
      );
    }

    // Get manager's current balance
    const managerResult = await db
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, managerUserId))
      .limit(1);

    const managerBalance = Number(managerResult[0]?.virtualBalance ?? 0);

    await withTransaction(async (tx) => {
      // Debit from agent (update both virtualBalance and totalWithdrawn)
      await tx
        .update(users)
        .set({
          virtualBalance: String(agentBalance - amount),
          totalWithdrawn: String(agentTotalWithdrawn + amount),
          updatedAt: new Date(),
        })
        .where(eq(users.id, agentUserId));

      // Credit to manager
      await tx
        .update(users)
        .set({
          virtualBalance: String(managerBalance + amount),
          updatedAt: new Date(),
        })
        .where(eq(users.id, managerUserId));

      // Record transaction for agent (debit)
      await tx.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId: agentUserId,
        type: "owner_withdraw",
        amount: String(-amount),
        balanceBefore: String(agentBalance),
        balanceAfter: String(agentBalance - amount),
        relatedId: managerUserId,
        description: `Withdrawal to owner`,
      });

      // Record transaction for manager (credit)
      await tx.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId: managerUserId,
        type: "agent_withdraw",
        amount: String(amount),
        balanceBefore: String(managerBalance),
        balanceAfter: String(managerBalance + amount),
        relatedId: agentUserId,
        description: `Withdrawal from agent: ${agentWithConfig.displayName}`,
      });
    });

    logger.info(
      `Withdrew ${BABYLON_POINTS_SYMBOL}${amount} trading balance from agent ${agentUserId}`,
      undefined,
      "AgentService",
    );

    const finalResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);
    return finalResult[0]!;
  }

  /**
   * Deduct from agent's virtualBalance for AI operations (chat, tick, post).
   *
   * @param agentUserId - Agent user ID
   * @param amount - Amount to deduct
   * @param reason - Reason for deduction (used to determine transaction type)
   * @param relatedId - Optional related entity ID
   * @returns New balance after deduction
   */
  async deductPoints(
    agentUserId: string,
    amount: number,
    reason: string,
    relatedId?: string,
  ): Promise<number> {
    // Fetch and validate balance inside transaction with row-level locking to prevent race conditions
    const newBalance = await withTransaction(async (tx) => {
      // Get agent's current virtualBalance with FOR UPDATE lock to prevent concurrent deductions
      const userResult = await tx
        .select({
          virtualBalance: users.virtualBalance,
          managedBy: users.managedBy,
        })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1)
        .for("update");

      const agent = userResult[0];
      if (!agent) throw new Error("Agent not found");

      const currentBalance = Number(agent.virtualBalance ?? 0);
      if (currentBalance < amount) {
        throw new Error(
          `Insufficient balance. Have: ${currentBalance.toFixed(2)}, Need: ${amount.toFixed(2)}`,
        );
      }

      // Deduct from agent's virtualBalance
      const result = await tx
        .update(users)
        .set({
          virtualBalance: String(currentBalance - amount),
          updatedAt: new Date(),
        })
        .where(eq(users.id, agentUserId))
        .returning({ virtualBalance: users.virtualBalance });

      const managedBy = agent.managedBy || agentUserId;

      // Record the transaction for tracking
      await tx.insert(agentPointsTransactions).values({
        id: await generateSnowflakeId(),
        type: reason.includes("chat")
          ? "spend_chat"
          : reason.includes("post")
            ? "spend_post"
            : "spend_tick",
        amount: -amount,
        balanceBefore: String(currentBalance),
        balanceAfter: String(currentBalance - amount),
        description: reason,
        relatedId: relatedId ?? null,
        agentUserId: agentUserId,
        managerUserId: managedBy,
      });

      // Also record in balance transactions for unified history
      await tx.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId: agentUserId,
        type: reason.includes("chat")
          ? "agent_chat"
          : reason.includes("post")
            ? "agent_post"
            : "agent_tick",
        amount: String(-amount),
        balanceBefore: String(currentBalance),
        balanceAfter: String(currentBalance - amount),
        relatedId: relatedId ?? null,
        description: reason,
      });

      return Number(result[0]?.virtualBalance ?? 0);
    });

    return newBalance;
  }

  async getPerformance(agentUserId: string): Promise<AgentPerformance> {
    const agentResult = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    const agent = agentResult[0];
    if (!agent || !agent.isAgent) throw new Error("Agent not found");

    // Get pre-calculated performance metrics from agentPerformanceMetrics table
    const metricsResult = await db
      .select()
      .from(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, agentUserId))
      .limit(1);

    const metrics = metricsResult[0];

    // If metrics exist, use them; otherwise fall back to calculating from trades
    if (metrics) {
      // Get trades for avgTradeSize calculation
      const trades = await db
        .select()
        .from(agentTrades)
        .where(eq(agentTrades.agentUserId, agentUserId));

      const tradesWithPnl = trades.filter((t) => t.pnl !== null);
      const avgTradeSize =
        tradesWithPnl.length > 0
          ? tradesWithPnl.reduce((sum, t) => sum + t.amount, 0) /
            tradesWithPnl.length
          : 0;

      return {
        lifetimePnL: Number(agent.lifetimePnL),
        totalTrades: metrics.totalTrades,
        profitableTrades: metrics.profitableTrades,
        winRate: metrics.winRate,
        avgTradeSize,
      };
    }

    // Fallback: calculate from agentTrades if no metrics record exists
    const trades = await db
      .select()
      .from(agentTrades)
      .where(eq(agentTrades.agentUserId, agentUserId));

    const closedTrades = trades.filter((t) => t.pnl !== null);
    const avgTradeSize =
      trades.length > 0
        ? trades.reduce((sum, t) => sum + t.amount, 0) / trades.length
        : 0;

    return {
      lifetimePnL: Number(agent.lifetimePnL),
      totalTrades: trades.length,
      profitableTrades: closedTrades.filter((t) => t.pnl && t.pnl > 0).length,
      winRate:
        closedTrades.length > 0
          ? closedTrades.filter((t) => t.pnl && t.pnl > 0).length /
            closedTrades.length
          : 0,
      avgTradeSize,
    };
  }

  async updatePerformanceMetricsForAgents(
    agentUserIds: string[],
  ): Promise<void> {
    if (agentUserIds.length === 0) return;

    const uniqueIds = Array.from(new Set(agentUserIds));

    for (const agentUserId of uniqueIds) {
      const tradeAgg = await db
        .select({
          totalTrades: count(),
          profitableTrades: sql<number>`count(*) filter (where ${agentTrades.pnl} > 0)`,
          realizedPnL: sql<number>`coalesce(sum(${agentTrades.pnl}), 0)`,
          avgTradeSize: sql<number>`coalesce(avg(${agentTrades.amount}), 0)`,
          averageROI: sql<number>`coalesce(avg(case when ${agentTrades.amount} > 0 and ${agentTrades.pnl} is not null then ${agentTrades.pnl} / ${agentTrades.amount} else null end), 0)`,
          lastTradeAt: sql<Date | null>`max(${agentTrades.executedAt})`,
        })
        .from(agentTrades)
        .where(eq(agentTrades.agentUserId, agentUserId));

      const openAgg = await db
        .select({
          unrealizedPnL: sql<number>`coalesce(sum(${positions.pnl}), 0)`,
        })
        .from(positions)
        .where(
          and(
            eq(positions.userId, agentUserId),
            eq(positions.status, "active"),
            isNotNull(positions.pnl),
          ),
        );

      const tradeRow = tradeAgg[0];
      const openRow = openAgg[0];

      const totalTrades = Number(tradeRow?.totalTrades ?? 0);
      const profitableTrades = Number(tradeRow?.profitableTrades ?? 0);
      const realizedPnL = Number(tradeRow?.realizedPnL ?? 0);
      const unrealizedPnL = Number(openRow?.unrealizedPnL ?? 0);
      const lifetimePnL = realizedPnL + unrealizedPnL;
      const winRate = totalTrades > 0 ? profitableTrades / totalTrades : 0;
      const avgTradeSize = Number(tradeRow?.avgTradeSize ?? 0);
      const averageROI = Number(tradeRow?.averageROI ?? 0);
      const lastTradeAt = tradeRow?.lastTradeAt ?? null;

      await db
        .insert(agentPerformanceMetrics)
        .values({
          id: await generateSnowflakeId(),
          userId: agentUserId,
          totalTrades,
          profitableTrades,
          winRate,
          averageROI,
          lastActivityAt: lastTradeAt ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: agentPerformanceMetrics.userId,
          set: {
            totalTrades,
            profitableTrades,
            winRate,
            averageROI,
            lastActivityAt: lastTradeAt ?? null,
            updatedAt: new Date(),
          },
        });

      await db
        .update(users)
        .set({
          lifetimePnL: lifetimePnL.toFixed(2),
          updatedAt: new Date(),
        })
        .where(eq(users.id, agentUserId));

      // Store avg trade size for analytics if needed later (in logs for now)
      logger.debug(
        "Updated agent performance metrics",
        { agentUserId, totalTrades, avgTradeSize, winRate, lifetimePnL },
        "AgentPerformance",
      );
    }
  }

  async getChatHistory(
    agentUserId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{
    messages: (typeof agentMessages.$inferSelect)[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    // Build the query with optional cursor
    let query = db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.agentUserId, agentUserId))
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit + 1); // Fetch one extra to check if there are more

    // If cursor provided, fetch messages older than the cursor
    if (cursor) {
      const cursorDate = new Date(cursor);
      query = db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.agentUserId, agentUserId),
            lt(agentMessages.createdAt, cursorDate),
          ),
        )
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit + 1);
    }

    const results = await query;

    // Check if there are more messages
    const hasMore = results.length > limit;
    const messages = hasMore ? results.slice(0, limit) : results;

    // Get the cursor for the next page (oldest message's createdAt)
    const nextCursor =
      hasMore && messages.length > 0
        ? messages[messages.length - 1]?.createdAt.toISOString()
        : null;

    return { messages, hasMore, nextCursor };
  }

  async getLogs(
    agentUserId: string,
    filters?: { type?: string; level?: string; limit?: number },
  ) {
    const query = db
      .select()
      .from(agentLogs)
      .where(
        and(
          eq(agentLogs.agentUserId, agentUserId),
          ...(filters?.type ? [eq(agentLogs.type, filters.type)] : []),
          ...(filters?.level ? [eq(agentLogs.level, filters.level)] : []),
        ),
      )
      .orderBy(desc(agentLogs.createdAt))
      .limit(filters?.limit || 100);

    return query;
  }

  async createLog(
    agentUserId: string,
    log: {
      type:
        | "chat"
        | "tick"
        | "trade"
        | "error"
        | "system"
        | "post"
        | "comment"
        | "dm"
        | "like"
        | "repost";
      level: "info" | "warn" | "error" | "debug";
      message: string;
      prompt?: string;
      completion?: string;
      thinking?: string;
      metadata?: Record<string, JsonValue>;
    },
  ) {
    const result = await db
      .insert(agentLogs)
      .values({
        id: await generateSnowflakeId(),
        agentUserId,
        type: log.type,
        level: log.level,
        message: log.message,
        prompt: log.prompt ?? null,
        completion: log.completion ?? null,
        thinking: log.thinking ?? null,
        metadata: log.metadata
          ? JSON.parse(JSON.stringify(log.metadata))
          : null,
      })
      .returning();

    return result[0]!;
  }

  private shouldAutoSetupAgentIdentity(): boolean {
    if (process.env.AUTO_CREATE_AGENT_WALLETS === "false") {
      return false;
    }

    // Require Privy credentials outside development so we do not spam errors
    const hasPrivyConfig = Boolean(
      process.env.NEXT_PUBLIC_PRIVY_APP_ID && process.env.PRIVY_APP_SECRET,
    );

    if (!hasPrivyConfig && process.env.NODE_ENV !== "development") {
      logger.warn(
        "Skipping automatic agent identity setup - Privy credentials missing",
        undefined,
        "AgentService",
      );
      return false;
    }

    return true;
  }

  private async setupAgentIdentity(agentUserId: string): Promise<void> {
    const skipAgent0Registration = process.env.AGENT0_ENABLED !== "true";

    const agent = await agentIdentityService.setupAgentIdentity(agentUserId, {
      skipAgent0Registration,
    });

    logger.info(
      "Agent identity setup complete",
      {
        agentUserId,
        walletProvisioned: Boolean(agent.walletAddress),
        agent0TokenId: agent.agent0TokenId,
        skippedAgent0: skipAgent0Registration,
      },
      "AgentService",
    );
  }
}

export const agentService = new AgentServiceV2();
