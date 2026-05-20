import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticateUser = mock();
const mockGetAgentSidebarSummary = mock();

mock.module('@babylon/api', () => ({
  authenticateUser: mockAuthenticateUser,
  withErrorHandling: (
    handler: (
      request: NextRequest,
      context: { params: Promise<{ agentId: string }> }
    ) => Promise<unknown>
  ) => handler,
}));

mock.module('@/lib/agents/agent-sidebar-summary', () => ({
  getAgentSidebarSummary: mockGetAgentSidebarSummary,
}));

const { GET } = await import('./route');

describe('GET /api/agents/[agentId]/summary', () => {
  beforeEach(() => {
    mockAuthenticateUser.mockReset();
    mockGetAgentSidebarSummary.mockReset();
  });

  it('returns the sidebar summary for an owned agent', async () => {
    mockAuthenticateUser.mockResolvedValue({ id: 'user-1' });
    mockGetAgentSidebarSummary.mockResolvedValue({
      agent: {
        id: 'agent-1',
        totalTrades: 7,
        profitableTrades: 4,
        winRate: 0.57,
      },
      portfolio: {
        totalPnL: 15,
        positions: 2,
        totalAssets: 120,
        available: 40,
        wallet: 30,
        agents: 0,
      },
      positions: {
        perpetuals: {
          positions: [],
          stats: { totalPositions: 0, totalPnL: 0, totalFunding: 0 },
          total: 0,
          hasMore: false,
        },
        predictions: {
          positions: [],
          stats: { totalPositions: 0 },
          total: 0,
          hasMore: false,
        },
        timestamp: '2026-03-27T00:00:00.000Z',
      },
    });

    const response = (await GET(
      {
        url: 'https://example.com/api/agents/agent-1/summary',
      } as NextRequest,
      { params: Promise.resolve({ agentId: 'agent-1' }) }
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetAgentSidebarSummary).toHaveBeenCalledWith({
      ownerId: 'user-1',
      agentId: 'agent-1',
    });
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        agent: expect.objectContaining({ id: 'agent-1', totalTrades: 7 }),
        portfolio: expect.objectContaining({ totalPnL: 15 }),
      })
    );
  });
});
