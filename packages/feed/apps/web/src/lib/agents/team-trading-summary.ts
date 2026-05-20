import { toNumber } from '@babylon/shared';
import {
  isOpenPredictionPosition,
  type UserPositionsSnapshot,
} from '@/lib/markets/user-positions-types';

export type TeamScope = 'owner_agents' | 'agents_only';

export interface TeamTotals {
  walletBalance: number;
  lifetimePnL: number;
  unrealizedPnL: number;
  currentPnL: number;
  openPositions: number;
}

export interface TeamMemberTradingSummary {
  entityType: 'owner' | 'agent';
  id: string;
  name: string;
  username: string | null;
  walletBalance: number;
  lifetimePnL: number;
  unrealizedPnL: number;
  currentPnL: number;
  openPositions: number;
}

export interface TeamTradingSummary {
  ownerId: string;
  ownerName: string;
  members: TeamMemberTradingSummary[];
  totals: TeamTotals;
  agentsOnlyTotals: TeamTotals;
  updatedAt: string | null;
}

interface AgentTradingSummaryInput {
  id: string;
  name?: string | null;
  username?: string | null;
  virtualBalance: number;
  lifetimePnL: number | string;
}

function sumMemberTotals(members: TeamMemberTradingSummary[]): TeamTotals {
  return members.reduce(
    (acc, member) => ({
      walletBalance: acc.walletBalance + member.walletBalance,
      lifetimePnL: acc.lifetimePnL + member.lifetimePnL,
      unrealizedPnL: acc.unrealizedPnL + member.unrealizedPnL,
      currentPnL: acc.currentPnL + member.currentPnL,
      openPositions: acc.openPositions + member.openPositions,
    }),
    {
      walletBalance: 0,
      lifetimePnL: 0,
      unrealizedPnL: 0,
      currentPnL: 0,
      openPositions: 0,
    }
  );
}

export function buildTeamTradingSummary({
  ownerId,
  ownerName,
  ownerBalance,
  positions,
  agents,
}: {
  ownerId: string;
  ownerName: string;
  ownerBalance: {
    balance: string | number;
    lifetimePnL: string | number;
  };
  positions: UserPositionsSnapshot;
  agents: AgentTradingSummaryInput[];
}): TeamTradingSummary {
  const byMember = new Map<
    string,
    { unrealizedPnL: number; openPositions: number }
  >();

  const addPosition = (memberId: string, unrealizedPnL: number) => {
    const current = byMember.get(memberId) ?? {
      unrealizedPnL: 0,
      openPositions: 0,
    };
    byMember.set(memberId, {
      unrealizedPnL: current.unrealizedPnL + unrealizedPnL,
      openPositions: current.openPositions + 1,
    });
  };

  for (const position of positions.perpetuals.positions) {
    const memberId = position.isAgentPosition
      ? (position.agentId ?? ownerId)
      : ownerId;
    addPosition(memberId, position.unrealizedPnL);
  }

  for (const position of positions.predictions.positions) {
    if (!isOpenPredictionPosition(position)) {
      continue;
    }
    const memberId = position.isAgentPosition
      ? (position.agentId ?? ownerId)
      : ownerId;
    addPosition(memberId, position.unrealizedPnL);
  }

  const ownerRow: TeamMemberTradingSummary = {
    entityType: 'owner',
    id: ownerId,
    name: ownerName,
    username: null,
    walletBalance: toNumber(ownerBalance.balance),
    lifetimePnL: toNumber(ownerBalance.lifetimePnL),
    unrealizedPnL: byMember.get(ownerId)?.unrealizedPnL ?? 0,
    currentPnL:
      toNumber(ownerBalance.lifetimePnL) +
      (byMember.get(ownerId)?.unrealizedPnL ?? 0),
    openPositions: byMember.get(ownerId)?.openPositions ?? 0,
  };

  const agentRows: TeamMemberTradingSummary[] = agents.map((agent) => {
    const unrealizedPnL = byMember.get(agent.id)?.unrealizedPnL ?? 0;
    const openPositions = byMember.get(agent.id)?.openPositions ?? 0;

    return {
      entityType: 'agent',
      id: agent.id,
      name: agent.name ?? 'Agent',
      username: agent.username ?? null,
      walletBalance: agent.virtualBalance,
      lifetimePnL: toNumber(agent.lifetimePnL),
      unrealizedPnL,
      currentPnL: toNumber(agent.lifetimePnL) + unrealizedPnL,
      openPositions,
    };
  });

  const members = [ownerRow, ...agentRows];

  return {
    ownerId,
    ownerName,
    members,
    totals: sumMemberTotals(members),
    agentsOnlyTotals: sumMemberTotals(agentRows),
    updatedAt: positions.timestamp ?? null,
  };
}
