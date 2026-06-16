import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";

const mockAuthenticateUser = mock();
const mockGetAgent = mock();
const mockGetPerformance = mock();
const mockGetAgentConfig = mock();
const mockIsAutonomousTradingEnabled = mock();
const mockGetAgent0TokenIdByAgentId = mock();

mock.module("@feed/agents", () => ({
  agentService: {
    getAgent: mockGetAgent,
    getPerformance: mockGetPerformance,
    updateAgent: mock(),
    deleteAgent: mock(),
  },
  getAgentConfig: mockGetAgentConfig,
  isAutonomousTradingEnabled: mockIsAutonomousTradingEnabled,
}));

mock.module("@feed/api", () => ({
  authenticateUser: mockAuthenticateUser,
  withErrorHandling: (
    handler: (
      request: NextRequest,
      context: { params: Promise<{ agentId: string }> },
    ) => Promise<unknown>,
  ) => handler,
}));

mock.module("@feed/shared", () => ({
  logger: {
    info: mock(),
  },
  toISO: (value: Date | null | undefined) => value?.toISOString() ?? null,
  toISOOrNull: (value: Date | null | undefined) =>
    value ? value.toISOString() : null,
}));

mock.module("@/lib/agents/agent0-token-ids", () => ({
  getAgent0TokenIdByAgentId: mockGetAgent0TokenIdByAgentId,
}));

const { GET } = await import("./route");

describe("GET /api/agents/[agentId]", () => {
  beforeEach(() => {
    mockAuthenticateUser.mockReset();
    mockGetAgent.mockReset();
    mockGetPerformance.mockReset();
    mockGetAgentConfig.mockReset();
    mockIsAutonomousTradingEnabled.mockReset();
    mockGetAgent0TokenIdByAgentId.mockReset();
    mockIsAutonomousTradingEnabled.mockReturnValue(true);
  });

  it("returns the AgentRegistry agent0 token id for the owned agent", async () => {
    mockAuthenticateUser.mockResolvedValue({ id: "user-1" });
    mockGetAgent.mockResolvedValue({
      id: "agent-1",
      username: "agent-one",
      displayName: "Agent One",
      bio: "bio",
      profileImageUrl: null,
      coverImageUrl: null,
      virtualBalance: "42",
      totalDeposited: null,
      totalWithdrawn: null,
      lifetimePnL: "5",
      walletAddress: null,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    mockGetPerformance.mockResolvedValue({
      totalTrades: 4,
      profitableTrades: 3,
      winRate: 0.75,
    });
    mockGetAgentConfig.mockResolvedValue({
      systemPrompt: "system",
      autonomousTrading: true,
      modelTier: "pro",
      status: "active",
      lastTickAt: null,
      lastChatAt: null,
    });
    mockGetAgent0TokenIdByAgentId.mockResolvedValue(101);

    const response = (await GET(
      {
        url: "https://example.com/api/agents/agent-1",
      } as NextRequest,
      { params: Promise.resolve({ agentId: "agent-1" }) },
    )) as Response;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetAgent0TokenIdByAgentId).toHaveBeenCalledWith("agent-1");
    expect(body.agent).toEqual(
      expect.objectContaining({
        id: "agent-1",
        agent0TokenId: 101,
      }),
    );
  });
});
