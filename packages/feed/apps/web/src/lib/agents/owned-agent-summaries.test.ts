import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockListUserAgents = mock();
const mockGetPerformance = mock();
const mockGetAgentConfig = mock();
const mockIsAutonomousTradingEnabled = mock();
const mockLoggerWarn = mock();

mock.module("@feed/agents", () => ({
  agentService: {
    listUserAgents: mockListUserAgents,
    getPerformance: mockGetPerformance,
  },
  getAgentConfig: mockGetAgentConfig,
  isAutonomousTradingEnabled: mockIsAutonomousTradingEnabled,
}));

mock.module("@feed/shared", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
  toISO: (value: Date) => value.toISOString(),
  toISOOrNull: (value: Date | null | undefined) =>
    value ? value.toISOString() : null,
}));

const { listOwnedAgentSummaries } = await import("./owned-agent-summaries");

describe("listOwnedAgentSummaries", () => {
  beforeEach(() => {
    mockListUserAgents.mockReset();
    mockGetPerformance.mockReset();
    mockGetAgentConfig.mockReset();
    mockIsAutonomousTradingEnabled.mockReset();
    mockLoggerWarn.mockReset();
    mockIsAutonomousTradingEnabled.mockImplementation(
      (config: { autonomousTrading?: boolean } | null) =>
        config?.autonomousTrading ?? false,
    );
  });

  it("degrades gracefully when an agent enrichment query fails", async () => {
    mockListUserAgents.mockResolvedValue([
      {
        id: "agent-1",
        username: "agent-one",
        displayName: "Agent One",
        bio: "bio",
        profileImageUrl: null,
        virtualBalance: "42",
        lifetimePnL: "5.5",
        walletAddress: null,
        agent0TokenId: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        id: "agent-2",
        username: "agent-two",
        displayName: "Agent Two",
        bio: "bio",
        profileImageUrl: null,
        virtualBalance: "24",
        lifetimePnL: "1.5",
        walletAddress: null,
        agent0TokenId: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    mockGetPerformance
      .mockRejectedValueOnce(new Error("broken trade row"))
      .mockResolvedValueOnce({
        totalTrades: 4,
        profitableTrades: 3,
        winRate: 0.75,
      });
    mockGetAgentConfig.mockResolvedValueOnce(null).mockResolvedValueOnce({
      autonomousTrading: true,
      autonomousPosting: true,
      autonomousCommenting: false,
      autonomousDMs: false,
      autonomousGroupChats: false,
      a2aEnabled: false,
      modelTier: "pro",
      status: "active",
      lastTickAt: new Date("2026-03-03T00:00:00.000Z"),
      lastChatAt: null,
    });

    const summaries = await listOwnedAgentSummaries("user-1");

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        id: "agent-1",
        totalTrades: 0,
        profitableTrades: 0,
        winRate: 0,
        autonomousTrading: false,
      }),
    );
    expect(summaries[1]).toEqual(
      expect.objectContaining({
        id: "agent-2",
        totalTrades: 4,
        profitableTrades: 3,
        winRate: 0.75,
        autonomousTrading: true,
        modelTier: "pro",
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });
});
