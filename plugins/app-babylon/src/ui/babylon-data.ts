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

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function extractAgentStatus(
  value: unknown,
): BabylonAgentSummaryEnvelope["agent"] {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    id: stringField(record, "id") ?? "",
    name: stringField(record, "name") ?? "",
    displayName: stringField(record, "displayName"),
    avatar: stringField(record, "avatar"),
    balance: numberField(record, "balance"),
    lifetimePnL: numberField(record, "lifetimePnL"),
    winRate: numberField(record, "winRate"),
    reputationScore: numberField(record, "reputationScore"),
    totalTrades: numberField(record, "totalTrades"),
    autonomous: booleanField(record, "autonomous"),
    autonomousTrading: booleanField(record, "autonomousTrading"),
    autonomousPosting: booleanField(record, "autonomousPosting"),
    autonomousCommenting: booleanField(record, "autonomousCommenting"),
    autonomousDMs: booleanField(record, "autonomousDMs"),
    lastTickAt: stringField(record, "lastTickAt"),
    lastChatAt: stringField(record, "lastChatAt"),
    agentStatus: stringField(record, "agentStatus"),
    errorMessage: stringField(record, "errorMessage"),
    totalDeposited:
      typeof record.totalDeposited === "number" ? record.totalDeposited : null,
    totalWithdrawn:
      typeof record.totalWithdrawn === "number"
        ? record.totalWithdrawn
        : null,
  };
}

function extractAgentPortfolio(
  value: unknown,
): BabylonAgentSummaryEnvelope["portfolio"] {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    totalPnL: numberField(record, "totalPnL"),
    positions: numberField(record, "positions"),
    totalAssets: numberField(record, "totalAssets"),
    available: numberField(record, "available"),
    wallet: numberField(record, "wallet"),
    agents: numberField(record, "agents"),
    totalPoints: numberField(record, "totalPoints"),
  };
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
    agent: extractAgentStatus(data?.agent),
    portfolio: extractAgentPortfolio(data?.portfolio),
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
