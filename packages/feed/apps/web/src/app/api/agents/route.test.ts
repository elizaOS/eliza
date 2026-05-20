import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockAuthenticateUser = mock();
const mockListOwnedAgentSummaries = mock();

mock.module('@babylon/agents', () => ({
  agentService: {
    createAgent: mock(),
    updateAgent: mock(),
  },
  getAgentConfig: mock(),
  isAutonomousTradingEnabled: mock(() => false),
}));

mock.module('@babylon/api', () => ({
  authenticateUser: mockAuthenticateUser,
  checkProgress: mock(),
  withErrorHandling: (handler: (request: NextRequest) => Promise<unknown>) =>
    handler,
}));

mock.module('@babylon/shared', () => ({
  logger: {
    info: mock(),
  },
  toISO: (value: Date) => value.toISOString(),
}));

mock.module('@/lib/agents/owned-agent-summaries', () => ({
  listOwnedAgentSummaries: mockListOwnedAgentSummaries,
}));

const { GET } = await import('./route');

describe('GET /api/agents', () => {
  beforeEach(() => {
    mockAuthenticateUser.mockReset();
    mockListOwnedAgentSummaries.mockReset();
  });

  it('returns owned agents from the shared aggregation helper', async () => {
    mockAuthenticateUser.mockResolvedValue({ id: 'user-1' });
    mockListOwnedAgentSummaries.mockResolvedValue([
      {
        id: 'agent-1',
        username: 'agent-one',
        name: 'Agent One',
        description: 'bio',
        profileImageUrl: null,
        virtualBalance: 42,
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
        lifetimePnL: 5.5,
        totalTrades: 10,
        profitableTrades: 6,
        winRate: 0.6,
        lastTickAt: '2026-03-01T00:00:00.000Z',
        lastChatAt: '2026-03-01T00:00:00.000Z',
        walletAddress: null,
        agent0TokenId: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ]);

    const response = (await GET({
      url: 'https://example.com/api/agents',
    } as NextRequest)) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockListOwnedAgentSummaries).toHaveBeenCalledWith('user-1', {});
    expect(body.agents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        modelTier: 'pro',
        lifetimePnL: '5.5',
        totalTrades: 10,
        profitableTrades: 6,
        winRate: 0.6,
      }),
    ]);
  });

  it('forwards the autonomousTrading filter to the shared aggregation helper', async () => {
    mockAuthenticateUser.mockResolvedValue({ id: 'user-1' });
    mockListOwnedAgentSummaries.mockResolvedValue([]);

    const response = (await GET({
      url: 'https://example.com/api/agents?autonomousTrading=true',
    } as NextRequest)) as Response;

    expect(response.status).toBe(200);
    expect(mockListOwnedAgentSummaries).toHaveBeenCalledWith('user-1', {
      autonomousTrading: true,
    });
  });
});
