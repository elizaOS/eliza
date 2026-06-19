// External-API contract tests for the Feed data parsers (feed-data.ts).
//
// These run the REAL parsers over real-shaped Feed backend payloads — fixtures
// built to match the canonical @elizaos/ui Feed response types
// (FeedAgentStatus, FeedActivityItem, FeedPredictionMarketsResponse,
// FeedChatMessagesResponse, FeedTeamAgent) AND the actual /agent/summary
// envelope the proxy returns ({ agent, portfolio, positions }). The shapes are
// verified against packages/ui/src/api/client-types-feed.ts and the proxy route
// mapping in ../routes.ts (each getFeed* loader -> /api/agents/:id/<sub>).
//
// A regression assertion documents the CONFIRMED contract mismatch between the
// canonical FeedAgentSummary type ({ id, name, summary, recentActivity }) and
// what extractAgentSummary actually consumes ({ agent, portfolio, positions }),
// so future divergence is caught here rather than silently dropping data in the
// operator surface.

import type {
  FeedActivityItem,
  FeedChatMessagesResponse,
  FeedTeamAgent,
} from "@elizaos/app-core";
import { describe, expect, it } from "vitest";
import {
  extractAgentSummary,
  extractChatMessages,
  extractTeamConversations,
  extractTeamDashboard,
  extractTradingBalance,
  summarizeFeedActivity,
} from "./feed-data";

describe("feed-data parsers — real Feed response shapes", () => {
  it("extractAgentSummary maps the /agent/summary envelope (agent + portfolio + positions)", () => {
    // Shape of GET /api/agents/:id/summary as the operator surface consumes it.
    const envelope = {
      agent: {
        id: "feed-agent-alice",
        name: "alice",
        displayName: "Alice Trader",
        balance: 1240.5,
        lifetimePnL: 312.75,
        winRate: 0.62,
        reputationScore: 88,
        totalTrades: 145,
        autonomous: true,
        autonomousTrading: true,
        agentStatus: "running",
        totalDeposited: 2000,
        totalWithdrawn: 500,
      },
      portfolio: {
        totalPnL: 312.75,
        positions: 4,
        totalAssets: 1553.25,
        available: 200,
        wallet: 1240.5,
        agents: 1,
        totalPoints: 980,
      },
      positions: {
        predictions: { positions: [{ marketId: "mkt-1", shares: 10 }] },
        perpetuals: { positions: [] },
      },
    };

    const result = extractAgentSummary(envelope);

    expect(result.agent?.id).toBe("feed-agent-alice");
    expect(result.agent?.displayName).toBe("Alice Trader");
    expect(result.agent?.autonomous).toBe(true);
    expect(result.agent?.totalDeposited).toBe(2000);
    expect(result.portfolio).toEqual({
      totalPnL: 312.75,
      positions: 4,
      totalAssets: 1553.25,
      available: 200,
      wallet: 1240.5,
      agents: 1,
      totalPoints: 980,
    });
    expect(result.positions?.predictions?.positions).toHaveLength(1);
  });

  it("extractAgentSummary coerces missing/invalid numeric fields to 0 (not undefined)", () => {
    const result = extractAgentSummary({
      agent: { id: "x", name: "x" },
      portfolio: { totalAssets: "not-a-number" },
    });
    expect(result.agent?.balance).toBe(0);
    expect(result.agent?.lifetimePnL).toBe(0);
    expect(result.portfolio?.totalAssets).toBe(0);
    expect(result.agent?.totalDeposited).toBeNull();
  });

  it("extractAgentSummary returns empty fields for a non-object payload", () => {
    const result = extractAgentSummary(null);
    expect(result.agent).toBeUndefined();
    expect(result.portfolio).toBeUndefined();
    expect(result.positions).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CONTRACT: the type lie is resolved.
  // ---------------------------------------------------------------------------
  // `getFeedAgentSummary()` used to be typed `Promise<FeedAgentSummary>`
  // ({ id, name, summary, recentActivity }), but it only proxies the upstream
  // body — it never builds that shape. It is now typed `Promise<unknown>` and the
  // authoritative parser is `extractAgentSummary` (this file), which consumes the
  // real `{ agent, portfolio, positions }` envelope. `FeedAgentSummary` is
  // deprecated. These assertions lock that resolution: the parser is the contract,
  // and the legacy canonical shape is NOT what the endpoint returns.
  it("the legacy FeedAgentSummary shape is not the /agent/summary contract", () => {
    const legacyCanonical = {
      id: "feed-agent-alice",
      name: "alice",
      summary: "Up 25% this week across prediction markets.",
      recentActivity: [
        {
          id: "act-1",
          type: "trade" as const,
          timestamp: "2026-06-10T12:00:00.000Z",
          summary: "Bought 10 YES on BTC-100K",
        },
      ],
    };

    // The legacy shape carries none of the real envelope keys, so the parser
    // (the contract) yields no agent/portfolio — confirming it is the wrong shape
    // and that the client must NOT be typed with it.
    const result = extractAgentSummary(legacyCanonical);
    expect(result.agent).toBeUndefined();
    expect(result.portfolio).toBeUndefined();
    expect(result as Record<string, unknown>).not.toHaveProperty("summary");
    expect(result as Record<string, unknown>).not.toHaveProperty(
      "recentActivity",
    );

    // The REAL envelope the endpoint returns parses into populated data.
    const real = extractAgentSummary({
      agent: { id: "feed-agent-alice", name: "Alice", balance: 1000 },
      portfolio: { totalAssets: 1500 },
      positions: { predictions: { positions: [] } },
    });
    expect(real.agent?.id).toBe("feed-agent-alice");
    expect(real.portfolio?.totalAssets).toBe(1500);
  });

  it("extractTeamDashboard maps the team-dashboard response (agents + summary)", () => {
    const agents: FeedTeamAgent[] = [
      {
        id: "feed-agent-alice",
        name: "Alice",
        balance: 1240.5,
        lifetimePnL: 312.75,
        winRate: 0.62,
        reputationScore: 88,
        totalTrades: 145,
        autonomous: true,
        agentStatus: "running",
      },
    ];
    const payload = {
      agents,
      summary: {
        ownerName: "Studio Ops",
        totals: {
          walletBalance: 5000,
          lifetimePnL: 800,
          unrealizedPnL: 50,
          currentPnL: 120,
          openPositions: 7,
        },
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    };

    const result = extractTeamDashboard(payload);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("Alice");
    expect(result.summary?.ownerName).toBe("Studio Ops");
    expect(result.summary?.totals?.walletBalance).toBe(5000);
    expect(result.summary?.totals?.openPositions).toBe(7);
  });

  it("extractTeamDashboard returns empty agents + null summary for empty/garbage input", () => {
    expect(extractTeamDashboard(null)).toEqual({ agents: [], summary: null });
    expect(extractTeamDashboard({ agents: "nope" })).toEqual({
      agents: [],
      summary: null,
    });
  });

  it("extractTeamConversations maps the conversations response", () => {
    const payload = {
      conversations: [
        {
          id: "c-1",
          name: "Strategy Room",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
          isActive: true,
        },
        {
          id: "c-2",
          name: "Risk Desk",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          isActive: false,
        },
      ],
      activeChatId: "c-1",
    };

    const result = extractTeamConversations(payload);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0].name).toBe("Strategy Room");
    expect(result.conversations.filter((c) => c.isActive)).toHaveLength(1);
    expect(result.activeChatId).toBe("c-1");
  });

  it("extractChatMessages maps a FeedChatMessagesResponse", () => {
    const payload: FeedChatMessagesResponse = {
      messages: [
        {
          id: "m-1",
          senderId: "u-1",
          senderName: "Operator",
          content: "Trim BTC exposure.",
          createdAt: "2026-06-10T11:00:00.000Z",
        },
      ],
    };

    const result = extractChatMessages(payload);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Trim BTC exposure.");
    expect(result[0].senderName).toBe("Operator");
    // Non-object / missing messages -> empty array.
    expect(extractChatMessages({})).toEqual([]);
    expect(extractChatMessages(null)).toEqual([]);
  });

  it("extractTradingBalance reads the { balance } envelope", () => {
    expect(extractTradingBalance({ balance: 200 })).toBe(200);
    expect(extractTradingBalance({ balance: "200" })).toBe(0);
    expect(extractTradingBalance({})).toBe(0);
    expect(extractTradingBalance(null)).toBe(0);
  });
});

describe("summarizeFeedActivity — every FeedActivityType + fallback", () => {
  it("prefers an explicit summary when present", () => {
    const item: FeedActivityItem = {
      id: "1",
      type: "trade",
      timestamp: "2026-06-10T00:00:00.000Z",
      summary: "Closed a winning position",
    };
    expect(summarizeFeedActivity(item)).toBe("Closed a winning position");
  });

  it("formats a trade from action/ticker/amount", () => {
    const item: FeedActivityItem = {
      id: "1",
      type: "trade",
      timestamp: "2026-06-10T00:00:00.000Z",
      action: "buy",
      ticker: "BTC-100K",
      amount: 50,
    };
    expect(summarizeFeedActivity(item)).toBe("buy BTC-100K $50.00");
  });

  it("falls back to marketId/side when ticker/action are absent on a trade", () => {
    const item: FeedActivityItem = {
      id: "1",
      type: "trade",
      timestamp: "2026-06-10T00:00:00.000Z",
      side: "sell",
      marketId: "mkt-9",
    };
    expect(summarizeFeedActivity(item)).toBe("sell mkt-9");
  });

  it("formats post / comment / message from contentPreview", () => {
    expect(
      summarizeFeedActivity({
        id: "1",
        type: "post",
        timestamp: "t",
        contentPreview: "Posted an update",
      }),
    ).toBe("Posted an update");
    expect(
      summarizeFeedActivity({
        id: "2",
        type: "comment",
        timestamp: "t",
        contentPreview: "Replied to a thread",
      }),
    ).toBe("Replied to a thread");
    expect(
      summarizeFeedActivity({
        id: "3",
        type: "message",
        timestamp: "t",
        contentPreview: "DM'd the team",
      }),
    ).toBe("DM'd the team");
  });

  it("uses the default copy for post/comment/message with no contentPreview", () => {
    expect(
      summarizeFeedActivity({ id: "1", type: "post", timestamp: "t" }),
    ).toBe("Published an update");
    expect(
      summarizeFeedActivity({ id: "2", type: "comment", timestamp: "t" }),
    ).toBe("Left a comment");
    expect(
      summarizeFeedActivity({ id: "3", type: "message", timestamp: "t" }),
    ).toBe("Sent a message");
  });

  it("falls back through contentPreview -> reasoning -> 'Activity' for the default branch", () => {
    // FeedActivityType "social" hits the default switch arm.
    expect(
      summarizeFeedActivity({
        id: "1",
        type: "social",
        timestamp: "t",
        reasoning: "Engaged with a trending post",
      }),
    ).toBe("Engaged with a trending post");
    expect(
      summarizeFeedActivity({ id: "2", type: "social", timestamp: "t" }),
    ).toBe("Activity");
  });
});

// extractWallet lives in FeedOperatorSurface.tsx (a private helper), so its
// behavior is covered by FeedOperatorSurface.render.test.tsx (Wallet card +
// chip values), not here.
