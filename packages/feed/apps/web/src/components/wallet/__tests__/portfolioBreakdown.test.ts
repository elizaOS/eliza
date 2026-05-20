import { describe, expect, it } from 'bun:test';
import { calculateWalletPortfolioSummary } from '../shared/portfolioBreakdown';

describe('calculateWalletPortfolioSummary', () => {
  it('keeps wallet totals aligned with the canonical snapshot and agent cash balances', () => {
    const result = calculateWalletPortfolioSummary({
      userId: 'owner-1',
      snapshot: {
        wallet: 100,
        agents: 200,
        positions: 150,
        available: 300,
        originalAmount: 0,
        totalAssets: 450,
        totalPnL: 0,
        agentCount: 1,
        members: [
          {
            id: 'owner-1',
            name: 'Owner',
            wallet: 100,
            isAgent: false,
          },
          {
            id: 'agent-1',
            name: 'Apex Force',
            wallet: 200,
            isAgent: true,
          },
        ],
      },
      perpPositions: [
        {
          id: 'perp-1',
          userId: 'owner-1',
          ticker: 'BTC',
          organizationId: 'BTC',
          side: 'long',
          entryPrice: 100,
          currentPrice: 110,
          size: 100,
          leverage: 5,
          liquidationPrice: 0,
          unrealizedPnL: 10,
          unrealizedPnLPercent: 10,
          fundingPaid: 0,
          openedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          closedAt: null,
          isAgentPosition: false,
        },
      ],
      predictionPositions: [
        {
          id: 'prediction-1',
          marketId: 'market-1',
          question: 'Will it rain?',
          side: 'YES',
          shares: 10,
          avgPrice: 5,
          currentPrice: 12,
          currentValue: 120,
          costBasis: 50,
          unrealizedPnL: 70,
          currentProbability: 0.6,
          resolved: false,
          resolution: null,
          status: 'active',
          createdAt: new Date().toISOString(),
          isAgentPosition: true,
          agentId: 'agent-1',
          agentName: 'Apex Force',
        },
      ],
    });

    expect(result.summary).toEqual({
      wallet: 100,
      agents: 200,
      positions: 150,
      totalBalance: 450,
      agentCount: 1,
    });

    expect(result.members).toEqual([
      {
        id: 'owner-1',
        name: 'You (Owner)',
        cash: 100,
        openPositions: 30,
        total: 130,
        isOwner: true,
      },
      {
        id: 'agent-1',
        name: 'Apex Force',
        cash: 200,
        openPositions: 120,
        total: 320,
        isOwner: false,
      },
    ]);
  });

  it('creates a zero-cash fallback row when positions arrive before member metadata', () => {
    const result = calculateWalletPortfolioSummary({
      userId: 'owner-1',
      snapshot: {
        wallet: 100,
        agents: 0,
        positions: 40,
        available: 100,
        originalAmount: 0,
        totalAssets: 140,
        totalPnL: 0,
        agentCount: 0,
        members: [
          {
            id: 'owner-1',
            name: 'Owner',
            wallet: 100,
            isAgent: false,
          },
        ],
      },
      perpPositions: [
        {
          id: 'perp-1',
          userId: 'agent-2',
          ticker: 'ETH',
          organizationId: 'ETH',
          side: 'long',
          entryPrice: 100,
          currentPrice: 120,
          size: 40,
          leverage: 1,
          liquidationPrice: 0,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          fundingPaid: 0,
          openedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          closedAt: null,
          isAgentPosition: true,
          agentId: 'agent-2',
          agentName: 'Fallback Agent',
        },
      ],
      predictionPositions: [],
    });

    expect(result.members).toContainEqual({
      id: 'agent-2',
      name: 'Fallback Agent',
      cash: 0,
      openPositions: 40,
      total: 40,
      isOwner: false,
    });
  });

  it('does not duplicate the owner row when the requested userId is an alias', () => {
    const result = calculateWalletPortfolioSummary({
      userId: 'privy:owner-1',
      snapshot: {
        wallet: 100,
        agents: 0,
        positions: 0,
        available: 100,
        originalAmount: 0,
        totalAssets: 100,
        totalPnL: 0,
        agentCount: 0,
        members: [
          {
            id: 'owner-1',
            name: 'Owner',
            wallet: 100,
            isAgent: false,
          },
        ],
      },
      perpPositions: [],
      predictionPositions: [],
    });

    expect(result.members).toEqual([
      {
        id: 'owner-1',
        name: 'You (Owner)',
        cash: 100,
        openPositions: 0,
        total: 100,
        isOwner: true,
      },
    ]);
  });
});
