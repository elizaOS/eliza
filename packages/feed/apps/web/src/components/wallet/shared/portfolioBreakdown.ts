import { calculatePerpPositionMarketValue } from '@feed/engine/client';
import type { PortfolioBreakdownSnapshot } from '@/hooks/usePortfolioPnL';
import type {
  PerpPosition,
  UserPredictionPosition,
} from '@/stores/userPositionsStore';

export interface WalletPortfolioMember {
  id: string;
  name: string;
  cash: number;
  openPositions: number;
  total: number;
  isOwner: boolean;
}

export interface WalletPortfolioSummary {
  agents: number;
  agentCount: number;
  positions: number;
  totalBalance: number;
  wallet: number;
}

export function calculateWalletPortfolioSummary(params: {
  userId: string;
  snapshot: PortfolioBreakdownSnapshot;
  perpPositions: PerpPosition[];
  predictionPositions: UserPredictionPosition[];
}): {
  members: WalletPortfolioMember[];
  summary: WalletPortfolioSummary;
} {
  const { userId, snapshot, perpPositions, predictionPositions } = params;
  const membersById = new Map<string, WalletPortfolioMember>();
  const ownerMember = (snapshot.members ?? []).find(
    (member) => !member.isAgent
  );
  const ownerMemberId = ownerMember?.id ?? userId;

  const addMember = ({
    id,
    name,
    wallet,
    isAgent,
  }: {
    id: string;
    isAgent: boolean;
    name: string;
    wallet: number;
  }) => {
    if (!id) return;

    const existing = membersById.get(id);
    if (existing) {
      existing.cash = wallet;
      existing.total = existing.cash + existing.openPositions;
      return;
    }

    membersById.set(id, {
      id,
      name: isAgent ? name : 'You (Owner)',
      cash: wallet,
      openPositions: 0,
      total: wallet,
      isOwner: !isAgent,
    });
  };

  for (const member of snapshot.members ?? []) {
    addMember(member);
  }

  if (!membersById.has(ownerMemberId)) {
    addMember({
      id: ownerMemberId,
      name: 'You (Owner)',
      wallet: snapshot.wallet,
      isAgent: false,
    });
  }

  const addPositionValue = (
    memberId: string,
    fallbackName: string,
    value: number,
    isAgent: boolean
  ) => {
    if (!memberId) return;

    const existing = membersById.get(memberId);
    if (existing) {
      existing.openPositions += value;
      existing.total = existing.cash + existing.openPositions;
      return;
    }

    membersById.set(memberId, {
      id: memberId,
      name: isAgent ? fallbackName : 'You (Owner)',
      cash: 0,
      openPositions: value,
      total: value,
      isOwner: !isAgent,
    });
  };

  for (const position of perpPositions) {
    const memberId = position.isAgentPosition
      ? (position.agentId ?? '')
      : ownerMemberId;
    addPositionValue(
      memberId,
      position.agentName ?? 'Agent',
      calculatePerpPositionMarketValue(position),
      Boolean(position.isAgentPosition)
    );
  }

  for (const position of predictionPositions) {
    const memberId = position.isAgentPosition
      ? (position.agentId ?? '')
      : ownerMemberId;
    addPositionValue(
      memberId,
      position.agentName ?? 'Agent',
      position.currentValue ?? position.shares * position.currentPrice,
      Boolean(position.isAgentPosition)
    );
  }

  const orderedIds = [
    ...new Set([
      ownerMemberId,
      ...(snapshot.members ?? []).map((member) => member.id),
      ...membersById.keys(),
    ]),
  ];

  const members = orderedIds
    .map((memberId) => membersById.get(memberId))
    .filter((member): member is WalletPortfolioMember => member !== undefined);

  return {
    members,
    summary: {
      wallet: snapshot.wallet,
      agents: snapshot.agents,
      positions: snapshot.positions,
      totalBalance: snapshot.totalAssets,
      agentCount: snapshot.agentCount,
    },
  };
}
