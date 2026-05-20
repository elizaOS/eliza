import { describe, expect, it } from 'bun:test';
import {
  buildWalletPnLEntityRows,
  WALLET_PNL_TEAM_ENTITY_KEY,
} from '../shared/pnlBreakdown';

describe('buildWalletPnLEntityRows', () => {
  it('maps team, owner, and agents from canonical team summary metrics', () => {
    const rows = buildWalletPnLEntityRows({
      ownerId: 'owner-1',
      ownerName: 'Owner',
      updatedAt: '2026-03-20T00:00:00.000Z',
      totals: {
        walletBalance: 1_700,
        lifetimePnL: -50,
        unrealizedPnL: 150,
        currentPnL: 100,
        openPositions: 3,
      },
      agentsOnlyTotals: {
        walletBalance: 700,
        lifetimePnL: -150,
        unrealizedPnL: 250,
        currentPnL: 100,
        openPositions: 2,
      },
      members: [
        {
          entityType: 'owner',
          id: 'owner-1',
          name: 'Owner',
          username: null,
          walletBalance: 1_000,
          lifetimePnL: 100,
          unrealizedPnL: -100,
          currentPnL: 0,
          openPositions: 1,
        },
        {
          entityType: 'agent',
          id: 'agent-1',
          name: 'Alpha',
          username: 'alpha',
          walletBalance: 300,
          lifetimePnL: -200,
          unrealizedPnL: 125,
          currentPnL: -75,
          openPositions: 1,
        },
        {
          entityType: 'agent',
          id: 'agent-2',
          name: 'Beta',
          username: 'beta',
          walletBalance: 400,
          lifetimePnL: 50,
          unrealizedPnL: 125,
          currentPnL: 175,
          openPositions: 1,
        },
      ],
    });

    expect(rows).toEqual([
      {
        entityKey: WALLET_PNL_TEAM_ENTITY_KEY,
        label: 'Team',
        currentPnl: 100,
        lifetimePnl: -50,
        unrealizedPnl: 150,
      },
      {
        entityKey: 'owner:owner-1',
        label: 'You',
        currentPnl: 0,
        lifetimePnl: 100,
        unrealizedPnl: -100,
      },
      {
        entityKey: 'agent:agent-1',
        label: 'Alpha',
        currentPnl: -75,
        lifetimePnl: -200,
        unrealizedPnl: 125,
      },
      {
        entityKey: 'agent:agent-2',
        label: 'Beta',
        currentPnl: 175,
        lifetimePnl: 50,
        unrealizedPnl: 125,
      },
    ]);
  });

  it('uses stable entity keys so duplicate agent labels do not collapse rows', () => {
    const rows = buildWalletPnLEntityRows({
      ownerId: 'owner-1',
      ownerName: 'Owner',
      updatedAt: null,
      totals: {
        walletBalance: 0,
        lifetimePnL: 0,
        unrealizedPnL: 0,
        currentPnL: 0,
        openPositions: 0,
      },
      agentsOnlyTotals: {
        walletBalance: 0,
        lifetimePnL: 0,
        unrealizedPnL: 0,
        currentPnL: 0,
        openPositions: 0,
      },
      members: [
        {
          entityType: 'owner',
          id: 'owner-1',
          name: 'Owner',
          username: null,
          walletBalance: 0,
          lifetimePnL: 0,
          unrealizedPnL: 0,
          currentPnL: 0,
          openPositions: 0,
        },
        {
          entityType: 'agent',
          id: 'agent-1',
          name: 'Agent',
          username: 'agent-1',
          walletBalance: 0,
          lifetimePnL: 10,
          unrealizedPnL: 5,
          currentPnL: 15,
          openPositions: 1,
        },
        {
          entityType: 'agent',
          id: 'agent-2',
          name: 'Agent',
          username: 'agent-2',
          walletBalance: 0,
          lifetimePnL: -10,
          unrealizedPnL: -5,
          currentPnL: -15,
          openPositions: 1,
        },
      ],
    });

    expect(rows.map((row) => row.entityKey)).toEqual([
      'team',
      'owner:owner-1',
      'agent:agent-1',
      'agent:agent-2',
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      'Team',
      'You',
      'Agent',
      'Agent',
    ]);
  });
});
