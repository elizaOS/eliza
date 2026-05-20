/**
 * Agent Trade Notification Service
 *
 * Sends DM notifications to agent owners when their agents execute trades.
 * This enables users to see what their agents are doing in real-time.
 */

import { db, eq, users } from "@feed/db";
import { logger } from "@feed/shared";
import { getOrCreateDMChat, sendMessageToChat } from "./dm-service";

export interface AgentTradeDetails {
  /** The agent's user ID */
  agentUserId: string;
  /** Type of market: 'prediction' or 'perp' */
  marketType: "prediction" | "perp";
  /** Market ID or ticker symbol */
  marketId?: string;
  ticker?: string;
  /** Trade action: 'open', 'close' */
  action: "open" | "close";
  /** Trade side: 'yes', 'no', 'long', 'short' */
  side: "yes" | "no" | "long" | "short";
  /** Amount in dollars */
  amount: number;
  /** Entry/exit price */
  price: number;
  /** P&L for close trades */
  pnl?: number;
  /** Optional reasoning from the agent */
  reasoning?: string;
}

/**
 * Format a trade notification message for the owner
 */
function formatTradeMessage(
  agentName: string,
  details: AgentTradeDetails,
): string {
  const {
    marketType,
    marketId,
    ticker,
    action,
    side,
    amount,
    price,
    pnl,
    reasoning,
  } = details;

  const marketDisplay =
    (marketType === "perp" ? ticker : marketId) ?? "unknown market";
  const sideDisplay = side.toUpperCase();
  const actionEmoji = action === "open" ? "📈" : "📉";
  const actionText = action === "open" ? "opened" : "closed";

  let message = `${actionEmoji} ${agentName} just ${actionText} a ${sideDisplay} position`;

  if (marketType === "perp") {
    message += ` in ${marketDisplay}`;
  } else {
    message += ` on market ${marketDisplay}`;
  }

  message += `: $${amount.toFixed(2)} at $${price.toFixed(4)}`;

  if (action === "close" && pnl !== undefined) {
    const pnlSign = pnl >= 0 ? "+" : "";
    message += ` (P&L: ${pnlSign}$${pnl.toFixed(2)})`;
  }

  if (reasoning) {
    message += `\n\n💭 "${reasoning}"`;
  }

  return message;
}

/**
 * Send a trade notification DM to the agent's owner.
 *
 * This is called after agent trades are executed to keep owners informed.
 * Fails silently if the owner can't be found or DM fails.
 */
export async function notifyOwnerOfAgentTrade(
  details: AgentTradeDetails,
): Promise<void> {
  const { agentUserId } = details;

  try {
    // Get the agent and their owner
    const [agent] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        managedBy: users.managedBy,
        isAgent: users.isAgent,
      })
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent) {
      logger.warn(
        "Agent not found for trade notification",
        { agentUserId },
        "AgentTradeNotification",
      );
      return;
    }

    if (!agent.isAgent) {
      // Not an agent, skip notification
      return;
    }

    if (!agent.managedBy) {
      logger.warn(
        "Agent has no owner for trade notification",
        { agentUserId },
        "AgentTradeNotification",
      );
      return;
    }

    const ownerId = agent.managedBy;
    const agentName = agent.displayName ?? "Your agent";

    // Format the message
    const message = formatTradeMessage(agentName, details);

    // Get or create a DM chat between agent and owner
    const chatId = await getOrCreateDMChat(agentUserId, ownerId);

    // Send the notification message
    await sendMessageToChat(chatId, agentUserId, message);

    logger.info(
      "Sent trade notification to owner",
      {
        agentUserId,
        ownerId,
        marketType: details.marketType,
        action: details.action,
      },
      "AgentTradeNotification",
    );
  } catch (error) {
    // Log but don't throw - notifications shouldn't break trading
    logger.error(
      "Failed to send trade notification",
      {
        agentUserId,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      },
      "AgentTradeNotification",
    );
  }
}
