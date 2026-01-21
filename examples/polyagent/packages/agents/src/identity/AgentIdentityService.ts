/**
 * Agent Identity Service
 *
 * Handles agent identity management including Privy embedded wallet creation.
 *
 * @remarks
 * Agents are Users (isAgent=true) and participate fully in the platform.
 *
 * @packageDocumentation
 */

import {
  agentLogs,
  db,
  eq,
  type JsonValue,
  type User,
  users,
} from "@babylon/db";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";
import { agentWalletService } from "./AgentWalletService";

/**
 * Service for agent identity management
 */
export class AgentIdentityService {
  /**
   * Creates embedded wallet for agent user via Privy
   *
   * Delegates to AgentWalletService for actual Privy integration.
   *
   * @param agentUserId - Agent user ID
   * @returns Wallet address and Privy wallet ID
   * @throws Error if agent user not found
   */
  async createAgentWallet(agentUserId: string): Promise<{
    walletAddress: string;
    privyWalletId: string;
  }> {
    logger.info(
      `Creating wallet for agent user ${agentUserId}`,
      undefined,
      "AgentIdentityService",
    );

    const [agentUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agentUser || !agentUser.isAgent) {
      throw new Error("Agent user not found");
    }

    // Use Privy server SDK to create embedded wallet
    const { walletAddress, privyWalletId } =
      await agentWalletService.createEmbeddedWallet(agentUserId);

    // Update agent user with wallet address
    await db
      .update(users)
      .set({
        walletAddress,
        privyWalletId,
      })
      .where(eq(users.id, agentUserId));

    // Log wallet creation
    await db.insert(agentLogs).values({
      id: await generateSnowflakeId(),
      agentUserId,
      type: "wallet",
      level: "info",
      message: `Wallet created: ${walletAddress}`,
      metadata: { walletAddress, privyWalletId } as JsonValue,
    });

    return { walletAddress, privyWalletId };
  }

  /**
   * Setup complete agent identity
   */
  async setupAgentIdentity(agentUserId: string): Promise<User> {
    logger.info(
      `Setting up identity for agent ${agentUserId}`,
      undefined,
      "AgentIdentityService",
    );

    // First create wallet
    await this.createAgentWallet(agentUserId);

    // Return updated agent
    const [updatedAgent] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!updatedAgent) {
      throw new Error("Agent not found after identity setup");
    }

    return updatedAgent;
  }

  /**
   * Get agent wallet address
   */
  async getAgentWalletAddress(agentUserId: string): Promise<string | null> {
    const [agent] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    return agent?.walletAddress ?? null;
  }
}

export const agentIdentityService = new AgentIdentityService();
