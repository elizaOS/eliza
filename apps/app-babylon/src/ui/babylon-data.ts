import type {
  BabylonActivityItem,
  BabylonAgentStatus,
  BabylonChatMessage,
  BabylonTeamAgent,
} from "@elizaos/app-core";
import { asRecord } from "@elizaos/shared";

export interface BabylonTeamSummaryTotals {
  walletBalance: number;
  lifetimePnL: number;
  unrealizedPnL: number;
  currentPnL: number;
  openPositions: number;
}

export interface BabylonTeamSummary {
  ownerName?: string;
  totals?: BabylonTeamSummaryTotals;
  agentsOnlyTotals?: BabylonTeamSummaryTotals;
  updatedAt?: string;
}

export interface BabylonTeamDashboard {
  agents: BabylonTeamAgent[];
  summary: BabylonTeamSummary | null;
}

export interface BabylonTeamConversation {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

export interface BabylonTeamConversationsResponse {
  conversations: BabylonTeamConversation[];
  activeChatId?: string | null;
}

export interface BabylonAgentPortfolio {
  totalPnL: number;
  positions: number;
  totalAssets: number;
  available: number;
  wallet: number;
  agents: number;
  totalPoints: number;
}

export interface BabylonAgentSummaryEnvelope {
  agent?: BabylonAgentStatus & {
    totalDeposited?: number | null;
    totalWithdrawn?: number | null;
  };
  portfolio?: BabylonAgentPortfolio;
  positions?: {
    predictions?: { positions?: unknown[] };
    perpetuals?: { positions?: unknown[] };
  };
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function summarizeBabylonActivity(item: BabylonActivityItem): string {
  if (item.summary) return item.summary;

  switch (item.type) {
    case "trade":
      return [
        item.action ?? item.side ?? "trade",
        item.ticker ?? item.marketId ?? "market",
        item.amount != null ? formatCurrency(item.amount) : "",
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    case "post":
      return item.contentPreview ?? "Published an update";
    case "comment":
      return item.contentPreview ?? "Left a comment";
    case "message":
      return item.contentPreview ?? "Sent a message";
    default:
      return item.contentPreview ?? item.reasoning ?? "Activity";
  }
}

export function extractTeamDashboard(value: unknown): BabylonTeamDashboard {
  const data = asRecord(value);
  return {
    agents: Array.isArray(data?.agents)
      ? (data.agents as BabylonTeamAgent[])
      : [],
    summary: asRecord(data?.summary) as BabylonTeamSummary | null,
  };
}

export function extractTeamConversations(
  value: unknown,
): BabylonTeamConversationsResponse {
  const data = asRecord(value);
  return {
    conversations: Array.isArray(data?.conversations)
      ? (data.conversations as BabylonTeamConversation[])
      : [],
    activeChatId:
      typeof data?.activeChatId === "string" ? data.activeChatId : null,
  };
}

export function extractAgentSummary(
  value: unknown,
): BabylonAgentSummaryEnvelope {
  const data = asRecord(value);
  return {
    agent: asRecord(
      data?.agent,
    ) as unknown as BabylonAgentSummaryEnvelope["agent"],
    portfolio: asRecord(
      data?.portfolio,
    ) as unknown as BabylonAgentSummaryEnvelope["portfolio"],
    positions: asRecord(
      data?.positions,
    ) as BabylonAgentSummaryEnvelope["positions"],
  };
}

export function extractChatMessages(value: unknown): BabylonChatMessage[] {
  const data = asRecord(value);
  return Array.isArray(data?.messages)
    ? (data.messages as BabylonChatMessage[])
    : [];
}

export function extractTradingBalance(value: unknown): number {
  const data = asRecord(value);
  const balance = data?.balance;
  return typeof balance === "number" ? balance : 0;
}
