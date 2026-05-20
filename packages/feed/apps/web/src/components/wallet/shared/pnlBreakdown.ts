import type { TeamTradingSummary } from "@/lib/agents/team-trading-summary";

export interface WalletPnLEntityRow {
  entityKey: string;
  label: string;
  currentPnl: number;
  lifetimePnl: number;
  unrealizedPnl: number;
}

export const WALLET_PNL_TEAM_ENTITY_KEY = "team";

export function buildWalletPnLEntityRows(
  summary: TeamTradingSummary,
): WalletPnLEntityRow[] {
  return [
    {
      entityKey: WALLET_PNL_TEAM_ENTITY_KEY,
      label: "Team",
      currentPnl: summary.totals.currentPnL,
      lifetimePnl: summary.totals.lifetimePnL,
      unrealizedPnl: summary.totals.unrealizedPnL,
    },
    ...summary.members.map((member) => ({
      entityKey: `${member.entityType}:${member.id}`,
      label: member.entityType === "owner" ? "You" : member.name,
      currentPnl: member.currentPnL,
      lifetimePnl: member.lifetimePnL,
      unrealizedPnl: member.unrealizedPnL,
    })),
  ];
}
