import {
  agentService,
  getAgentConfig,
  isAutonomousTradingEnabled,
} from "@feed/agents";
import { calculatePortfolioBreakdown } from "@feed/engine";
import { toISO, toISOOrNull } from "@feed/shared";
import { getAgent0TokenIdByAgentId } from "./agent0-token-ids";
import { getUserPositionsSnapshot } from "@/lib/markets/user-positions";

function normalizeModelTier(value: string | null | undefined): "free" | "pro" {
  return value === "pro" ? "pro" : "free";
}

export async function getAgentSidebarSummary({
  ownerId,
  agentId,
}: {
  ownerId: string;
  agentId: string;
}) {
  // `getAgent(agentId, ownerId)` is the ownership gate for the entire summary.
  const [agent, performance, config, portfolio, positions, agent0TokenId] =
    await Promise.all([
      agentService.getAgent(agentId, ownerId),
      agentService.getPerformance(agentId),
      getAgentConfig(agentId),
      calculatePortfolioBreakdown(agentId),
      getUserPositionsSnapshot({
        userId: agentId,
        type: "all",
        status: "all",
      }),
      getAgent0TokenIdByAgentId(agentId),
    ]);

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (!portfolio) {
    throw new Error(`Portfolio breakdown not found for agent ${agentId}`);
  }

  const tradingEnabled = isAutonomousTradingEnabled(config);

  return {
    agent: {
      id: agent.id,
      username: agent.username,
      name: agent.displayName,
      description: agent.bio,
      profileImageUrl: agent.profileImageUrl,
      coverImageUrl: agent.coverImageUrl,
      virtualBalance: Number(agent.virtualBalance ?? 0),
      totalDeposited:
        agent.totalDeposited == null ? null : Number(agent.totalDeposited),
      totalWithdrawn:
        agent.totalWithdrawn == null ? null : Number(agent.totalWithdrawn),
      isActive: config?.status === "active",
      autonomousEnabled: tradingEnabled,
      autonomousTrading: tradingEnabled,
      autonomousPosting: config?.autonomousPosting ?? false,
      autonomousCommenting: config?.autonomousCommenting ?? false,
      autonomousDMs: config?.autonomousDMs ?? false,
      autonomousGroupChats: config?.autonomousGroupChats ?? false,
      a2aEnabled: config?.a2aEnabled ?? false,
      modelTier: normalizeModelTier(config?.modelTier),
      status: config?.status ?? "idle",
      errorMessage: config?.errorMessage ?? null,
      lifetimePnL: Number(agent.lifetimePnL ?? 0),
      totalTrades: performance.totalTrades,
      profitableTrades: performance.profitableTrades,
      winRate: performance.winRate,
      lastTickAt: toISOOrNull(config?.lastTickAt),
      lastChatAt: toISOOrNull(config?.lastChatAt),
      walletAddress: agent.walletAddress,
      agent0TokenId,
      createdAt: toISO(agent.createdAt),
      updatedAt: toISO(agent.updatedAt),
    },
    portfolio: {
      totalPnL: Number(portfolio.totalPnL ?? 0),
      positions: Number(portfolio.positions ?? 0),
      totalAssets: Number(portfolio.totalAssets ?? 0),
      available: Number(portfolio.available ?? 0),
      wallet: Number(portfolio.wallet ?? 0),
      agents: Number(portfolio.agents ?? 0),
    },
    positions,
  };
}
