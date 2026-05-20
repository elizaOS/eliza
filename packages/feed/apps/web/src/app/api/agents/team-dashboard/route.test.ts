import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticateUser = mock();
const mockGetTeamDashboardData = mock();

mock.module('@babylon/api', () => ({
  authenticateUser: mockAuthenticateUser,
  withErrorHandling: (handler: (request: NextRequest) => Promise<unknown>) =>
    handler,
}));

mock.module('@/lib/agents/team-dashboard', () => ({
  getTeamDashboardData: mockGetTeamDashboardData,
}));

const { GET } = await import('./route');

describe('GET /api/agents/team-dashboard', () => {
  beforeEach(() => {
    mockAuthenticateUser.mockReset();
    mockGetTeamDashboardData.mockReset();
  });

  it('returns agent cards and team summary from the dashboard service', async () => {
    mockAuthenticateUser.mockResolvedValue({
      id: 'user-1',
      username: 'owner',
      displayName: 'Owner',
    });
    mockGetTeamDashboardData.mockResolvedValue({
      agents: [
        {
          id: 'agent-1',
          username: 'agent-one',
          name: 'Agent One',
          displayName: 'Agent One',
          profileImageUrl: null,
          description: null,
          virtualBalance: 120,
          autonomousEnabled: true,
          autonomousTrading: true,
          autonomousPosting: false,
          autonomousCommenting: false,
          autonomousDMs: false,
          autonomousGroupChats: false,
          a2aEnabled: false,
          modelTier: 'pro',
          status: 'active',
          isActive: true,
          lifetimePnL: 15,
          totalTrades: 22,
          profitableTrades: 13,
          winRate: 0.59,
          lastTickAt: null,
          lastChatAt: null,
          walletAddress: null,
          agent0TokenId: null,
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-02T00:00:00.000Z',
          openPositions: 3,
        },
      ],
      summary: {
        ownerId: 'user-1',
        ownerName: 'Owner',
        members: [],
        totals: {
          walletBalance: 120,
          lifetimePnL: 15,
          unrealizedPnL: 5,
          currentPnL: 20,
          openPositions: 3,
        },
        agentsOnlyTotals: {
          walletBalance: 120,
          lifetimePnL: 15,
          unrealizedPnL: 5,
          currentPnL: 20,
          openPositions: 3,
        },
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    });

    const response = (await GET({
      url: 'https://example.com/api/agents/team-dashboard',
    } as NextRequest)) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      agents: [expect.objectContaining({ id: 'agent-1', openPositions: 3 })],
      summary: expect.objectContaining({
        ownerId: 'user-1',
        totals: expect.objectContaining({ currentPnL: 20 }),
      }),
    });
  });
});
