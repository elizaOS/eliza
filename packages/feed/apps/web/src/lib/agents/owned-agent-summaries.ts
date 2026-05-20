import {
  agentService,
  getAgentConfig,
  isAutonomousTradingEnabled,
} from "@feed/agents";
import { logger, toISO, toISOOrNull } from "@feed/shared";

export type AgentModelTier = "free" | "pro";

export interface OwnedAgentSummary {
  id: string;
  username: string | null;
  name: string | null;
  description: string | null;
  profileImageUrl: string | null;
  virtualBalance: number;
  autonomousEnabled: boolean;
  autonomousTrading: boolean;
  autonomousPosting: boolean;
  autonomousCommenting: boolean;
  autonomousDMs: boolean;
  autonomousGroupChats: boolean;
  a2aEnabled: boolean;
  modelTier: AgentModelTier;
  status: string;
  isActive: boolean;
  lifetimePnL: number;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
  lastTickAt: string | null;
  lastChatAt: string | null;
  walletAddress: string | null;
  agent0TokenId: number | null;
  createdAt: string;
  updatedAt: string;
}

function normalizeModelTier(value: string | null | undefined): AgentModelTier {
  return value === "pro" ? "pro" : "free";
}

export async function listOwnedAgentSummaries(
  managerUserId: string,
  filters?: { autonomousTrading?: boolean },
): Promise<OwnedAgentSummary[]> {
  const agents = await agentService.listUserAgents(managerUserId, filters);

  return Promise.all(
    agents.map(async (agent) => {
      const [performanceResult, configResult] = await Promise.allSettled([
        agentService.getPerformance(agent.id),
        getAgentConfig(agent.id),
      ]);

      const performance =
        performanceResult.status === "fulfilled"
          ? performanceResult.value
          : {
              totalTrades: 0,
              profitableTrades: 0,
              winRate: 0,
            };
      const config =
        configResult.status === "fulfilled" ? configResult.value : null;

      if (performanceResult.status === "rejected") {
        logger.warn(
          "Failed to load agent performance for owned agent summary",
          {
            agentId: agent.id,
            managerUserId,
            error:
              performanceResult.reason instanceof Error
                ? performanceResult.reason.message
                : String(performanceResult.reason),
          },
          "listOwnedAgentSummaries",
        );
      }

      if (configResult.status === "rejected") {
        logger.warn(
          "Failed to load agent config for owned agent summary",
          {
            agentId: agent.id,
            managerUserId,
            error:
              configResult.reason instanceof Error
                ? configResult.reason.message
                : String(configResult.reason),
          },
          "listOwnedAgentSummaries",
        );
      }

      const tradingEnabled = isAutonomousTradingEnabled(config);

      return {
        id: agent.id,
        username: agent.username,
        name: agent.displayName,
        description: agent.bio,
        profileImageUrl: agent.profileImageUrl,
        virtualBalance: Number(agent.virtualBalance ?? 0),
        autonomousEnabled: tradingEnabled,
        autonomousTrading: tradingEnabled,
        autonomousPosting: config?.autonomousPosting ?? false,
        autonomousCommenting: config?.autonomousCommenting ?? false,
        autonomousDMs: config?.autonomousDMs ?? false,
        autonomousGroupChats: config?.autonomousGroupChats ?? false,
        a2aEnabled: config?.a2aEnabled ?? false,
        modelTier: normalizeModelTier(config?.modelTier),
        status: config?.status ?? "idle",
        isActive: config?.status === "active",
        lifetimePnL: Number(agent.lifetimePnL ?? 0),
        totalTrades: performance.totalTrades ?? 0,
        profitableTrades: performance.profitableTrades ?? 0,
        winRate: performance.winRate ?? 0,
        lastTickAt: toISOOrNull(config?.lastTickAt),
        lastChatAt: toISOOrNull(config?.lastChatAt),
        walletAddress: agent.walletAddress,
        agent0TokenId: null, // TODO: source from AgentRegistry table
        createdAt: toISO(agent.createdAt),
        updatedAt: toISO(agent.updatedAt),
      };
    }),
  );
}
