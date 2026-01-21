/**
 * Agent Wallet Service
 *
 * Handles agent wallet creation via Privy.
 *
 * @packageDocumentation
 */

import { agentLogs, db, eq, users } from "@babylon/db";
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../shared/logger";

/**
 * Privy wallet structure
 * @internal
 */
interface PrivyWallet {
  address: string;
  id: string;
}

/**
 * Privy user structure
 * @internal
 */
interface PrivyUser {
  id: string;
  wallet?: PrivyWallet;
}

/**
 * Privy create user parameters
 * @internal
 */
interface PrivyCreateUserParams {
  create_embedded_wallet: boolean;
  linked_accounts: Array<Record<string, unknown>>;
}

/**
 * Privy sign transaction parameters
 * @internal
 */
interface PrivySignTransactionParams {
  wallet_id: string;
  transaction: {
    to: string;
    value: string;
    data: string;
  };
}

/**
 * Privy signed transaction response
 * @internal
 */
interface PrivySignedTransaction {
  signed_transaction: string;
}

/**
 * Extended Privy client with additional methods
 * @internal
 */
interface ExtendedPrivyClient extends PrivyClient {
  createUser(params: PrivyCreateUserParams): Promise<PrivyUser>;
  signTransaction(
    params: PrivySignTransactionParams,
  ): Promise<PrivySignedTransaction>;
}

// Initialize Privy server client
const getPrivyClient = () => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    return null;
  }
  return new PrivyClient(appId, appSecret) as ExtendedPrivyClient;
};

export class AgentWalletService {
  /**
   * Create embedded wallet for agent via Privy (server-side, no user interaction)
   * Falls back to dev wallet in development if Privy is not configured.
   */
  async createEmbeddedWallet(agentUserId: string): Promise<{
    walletAddress: string;
    privyWalletId: string;
  }> {
    const [agent] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent || !agent.isAgent) {
      throw new Error("Agent user not found");
    }

    // Check if agent already has a wallet address
    if (agent.walletAddress) {
      logger.info(
        "Agent already has wallet address, skipping creation",
        {
          agentUserId,
          walletAddress: agent.walletAddress,
        },
        "AgentWalletService",
      );

      return {
        walletAddress: agent.walletAddress,
        privyWalletId: agent.privyWalletId || `dev_wallet_${agentUserId}`,
      };
    }

    const privy = getPrivyClient();

    // If Privy is not available, use development wallet
    if (!privy || typeof privy.createUser !== "function") {
      logger.info(
        "Privy not available, using development wallet",
        { agentUserId },
        "AgentWalletService",
      );

      // Create dev wallet directly
      const devWallet = ethers.Wallet.createRandom();
      const walletAddress = devWallet.address;
      const privyWalletId = `dev_wallet_${agentUserId}`;

      await db
        .update(users)
        .set({
          walletAddress,
          privyId: `dev_${agentUserId}`,
          privyWalletId,
        })
        .where(eq(users.id, agentUserId));

      return { walletAddress, privyWalletId };
    }

    // Try Privy wallet creation
    logger.info(
      `Creating Privy embedded wallet for agent ${agentUserId}`,
      undefined,
      "AgentWalletService",
    );

    const privyUser = await privy.createUser({
      create_embedded_wallet: true,
      linked_accounts: [],
    });

    if (!privyUser.wallet) {
      throw new Error("Failed to create embedded wallet");
    }

    const walletAddress = privyUser.wallet.address;
    const privyUserId = privyUser.id;
    const privyWalletId = privyUser.wallet.id;

    // Update agent user with wallet info
    await db
      .update(users)
      .set({
        walletAddress,
        privyId: privyUserId,
        privyWalletId,
      })
      .where(eq(users.id, agentUserId));

    // Log wallet creation
    await db.insert(agentLogs).values({
      id: uuidv4(),
      agentUserId,
      type: "system",
      level: "info",
      message: `Privy embedded wallet created: ${walletAddress}`,
      metadata: {
        privyUserId,
        privyWalletId,
        walletAddress,
      },
    });

    logger.info(
      `Privy wallet created for agent ${agentUserId}: ${walletAddress}`,
      undefined,
      "AgentWalletService",
    );

    return { walletAddress, privyWalletId };
  }

  /**
   * Sign transaction for agent (server-side, no user interaction)
   */
  async signTransaction(
    agentUserId: string,
    transactionData: {
      to: string;
      value: string;
      data: string;
    },
  ): Promise<string> {
    const [agent] = await db
      .select({
        id: users.id,
        isAgent: users.isAgent,
        privyId: users.privyId,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent || !agent.isAgent) {
      throw new Error("Agent not found");
    }

    if (!agent.privyId) {
      throw new Error("Agent does not have Privy wallet");
    }

    const privy = getPrivyClient();
    if (!privy) {
      throw new Error("Privy not configured");
    }

    const signedTx = await privy.signTransaction({
      wallet_id: agent.privyId,
      transaction: transactionData,
    });

    logger.info(
      `Transaction signed for agent ${agentUserId}`,
      undefined,
      "AgentWalletService",
    );

    return signedTx.signed_transaction;
  }

  /**
   * Get agent wallet address
   */
  async getWalletAddress(agentUserId: string): Promise<string | null> {
    const [agent] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    return agent?.walletAddress ?? null;
  }
}

export const agentWalletService = new AgentWalletService();
