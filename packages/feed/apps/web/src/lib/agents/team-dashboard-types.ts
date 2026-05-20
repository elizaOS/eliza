import type { TeamTradingSummary } from './team-trading-summary';

export type AgentModelTier = 'free' | 'pro';

export interface TeamDashboardAgent {
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
  displayName: string | null;
  openPositions: number;
}

export interface TeamDashboardData {
  agents: TeamDashboardAgent[];
  summary: TeamTradingSummary;
}
