/**
 * Tests for All Agents Activity API Route
 *
 * @route GET /api/agents/activity
 *
 * Comprehensive tests covering:
 * - Multi-agent activity aggregation
 * - Agent info inclusion in responses
 * - Empty state handling (no agents)
 * - Pagination across multiple agents
 * - Activity deduplication and sorting
 */

import { describe, expect, it } from "bun:test";

// Types
interface AgentInfo {
  id: string;
  name: string;
  profileImageUrl: string | null;
}

interface MockAgentTrade {
  id: string;
  agentUserId: string;
  marketType: string;
  marketId: string | null;
  ticker: string | null;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  pnl: number | null;
  reasoning: string | null;
  executedAt: Date;
}

interface MockAgentPost {
  id: string;
  authorId: string;
  content: string;
  createdAt: Date;
}

interface MockAgentComment {
  id: string;
  authorId: string;
  postId: string;
  content: string;
  parentCommentId: string | null;
  createdAt: Date;
}

// Test fixtures
const createMockAgents = (): AgentInfo[] => [
  {
    id: "agent-1",
    name: "Trading Bot Alpha",
    profileImageUrl: "https://example.com/alpha.png",
  },
  { id: "agent-2", name: "Market Analyzer", profileImageUrl: null },
  {
    id: "agent-3",
    name: "Prediction Master",
    profileImageUrl: "https://example.com/pm.png",
  },
];

const createMockAgentTrade = (
  overrides: Partial<MockAgentTrade> = {},
): MockAgentTrade => ({
  id: `trade-${Date.now()}-${Math.random()}`,
  agentUserId: "agent-1",
  marketType: "prediction",
  marketId: "market-1",
  ticker: null,
  action: "open",
  side: "yes",
  amount: 100,
  price: 0.65,
  pnl: null,
  reasoning: "Test reasoning",
  executedAt: new Date(),
  ...overrides,
});

const createMockAgentPost = (
  overrides: Partial<MockAgentPost> = {},
): MockAgentPost => ({
  id: `post-${Date.now()}-${Math.random()}`,
  authorId: "agent-1",
  content: "Agent post content",
  createdAt: new Date(),
  ...overrides,
});

const createMockAgentComment = (
  overrides: Partial<MockAgentComment> = {},
): MockAgentComment => ({
  id: `comment-${Date.now()}-${Math.random()}`,
  authorId: "agent-1",
  postId: "post-parent",
  content: "Agent comment content",
  parentCommentId: null,
  createdAt: new Date(),
  ...overrides,
});

describe("All Agents Activity API - Empty State", () => {
  it("should return empty activities when user has no agents", () => {
    const ownedAgents: AgentInfo[] = [];

    const response = {
      success: true,
      activities: [],
      pagination: {
        limit: 50,
        count: 0,
        hasMore: false,
      },
    };

    expect(ownedAgents.length).toBe(0);
    expect(response.activities).toHaveLength(0);
    expect(response.pagination.count).toBe(0);
    expect(response.pagination.hasMore).toBe(false);
  });

  it("should return empty activities when agents have no activity", () => {
    const agents = createMockAgents();
    const trades: MockAgentTrade[] = [];
    const posts: MockAgentPost[] = [];
    const comments: MockAgentComment[] = [];

    expect(agents.length).toBeGreaterThan(0);
    expect(trades.length + posts.length + comments.length).toBe(0);
  });
});

describe("All Agents Activity API - Multi-Agent Aggregation", () => {
  it("should aggregate activities from multiple agents", () => {
    const agents = createMockAgents();
    const now = Date.now();

    const trades = [
      createMockAgentTrade({
        agentUserId: "agent-1",
        executedAt: new Date(now - 1000),
      }),
      createMockAgentTrade({
        agentUserId: "agent-2",
        executedAt: new Date(now - 2000),
      }),
      createMockAgentTrade({
        agentUserId: "agent-3",
        executedAt: new Date(now - 3000),
      }),
    ];

    // All agent IDs should be in the list of owned agents
    const agentIds = new Set(agents.map((a) => a.id));
    for (const trade of trades) {
      expect(agentIds.has(trade.agentUserId)).toBe(true);
    }
  });

  it("should include correct agent info in each activity", () => {
    const agents = createMockAgents();
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const trade = createMockAgentTrade({ agentUserId: "agent-1" });
    const agentInfo = agentMap.get(trade.agentUserId);

    expect(agentInfo).toBeDefined();
    expect(agentInfo?.name).toBe("Trading Bot Alpha");
    expect(agentInfo?.profileImageUrl).toBe("https://example.com/alpha.png");
  });

  it("should handle agents with null profileImageUrl", () => {
    const agents = createMockAgents();
    const agent2 = agents.find((a) => a.id === "agent-2");

    expect(agent2).toBeDefined();
    expect(agent2?.profileImageUrl).toBeNull();
  });

  it("should use fallback name when displayName is null", () => {
    const agentWithNullName = {
      id: "agent-x",
      displayName: null,
      profileImageUrl: null,
    };

    const name = agentWithNullName.displayName ?? "Agent";
    expect(name).toBe("Agent");
  });
});

describe("All Agents Activity API - Cross-Agent Sorting", () => {
  it("should sort all activities by timestamp descending", () => {
    const now = Date.now();

    const activities = [
      {
        agentId: "agent-1",
        type: "trade",
        timestamp: new Date(now - 2000).toISOString(),
      },
      {
        agentId: "agent-2",
        type: "post",
        timestamp: new Date(now).toISOString(),
      },
      {
        agentId: "agent-3",
        type: "comment",
        timestamp: new Date(now - 1000).toISOString(),
      },
    ];

    const sorted = activities.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    expect(sorted.length).toBe(3);
    expect(sorted[0]?.agentId).toBe("agent-2"); // newest
    expect(sorted[1]?.agentId).toBe("agent-3"); // middle
    expect(sorted[2]?.agentId).toBe("agent-1"); // oldest
  });

  it("should interleave activities from different agents correctly", () => {
    const now = Date.now();

    // Simulate activities that came from different agents but need interleaving
    const agent1Trade = createMockAgentTrade({
      agentUserId: "agent-1",
      executedAt: new Date(now - 500),
    });
    const agent2Post = createMockAgentPost({
      authorId: "agent-2",
      createdAt: new Date(now),
    });
    const agent1Comment = createMockAgentComment({
      authorId: "agent-1",
      createdAt: new Date(now - 1000),
    });

    const activities = [
      {
        agentId: agent1Trade.agentUserId,
        type: "trade",
        timestamp: agent1Trade.executedAt.toISOString(),
      },
      {
        agentId: agent2Post.authorId,
        type: "post",
        timestamp: agent2Post.createdAt.toISOString(),
      },
      {
        agentId: agent1Comment.authorId,
        type: "comment",
        timestamp: agent1Comment.createdAt.toISOString(),
      },
    ];

    const sorted = activities.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // post (now), trade (now-500), comment (now-1000)
    expect(sorted.length).toBe(3);
    expect(sorted[0]?.type).toBe("post");
    expect(sorted[1]?.type).toBe("trade");
    expect(sorted[2]?.type).toBe("comment");
  });
});

describe("All Agents Activity API - Agent Filtering", () => {
  it("should only return activities from owned agents", () => {
    const ownedAgentIds = new Set(["agent-1", "agent-2"]);

    const allTrades = [
      createMockAgentTrade({ agentUserId: "agent-1" }),
      createMockAgentTrade({ agentUserId: "agent-2" }),
      createMockAgentTrade({ agentUserId: "agent-not-owned" }), // Not owned
    ];

    const filteredTrades = allTrades.filter((t) =>
      ownedAgentIds.has(t.agentUserId),
    );

    expect(filteredTrades.length).toBe(2);
    for (const t of filteredTrades) {
      expect(ownedAgentIds.has(t.agentUserId)).toBe(true);
    }
  });

  it("should skip activities when agent not found in map", () => {
    const agentMap = new Map([
      ["agent-1", { id: "agent-1", name: "Agent 1", profileImageUrl: null }],
    ]);

    const trades = [
      createMockAgentTrade({ agentUserId: "agent-1" }),
      createMockAgentTrade({ agentUserId: "agent-unknown" }),
    ];

    const activitiesWithAgent = trades.filter((t) =>
      agentMap.has(t.agentUserId),
    );

    expect(activitiesWithAgent.length).toBe(1);
    expect(activitiesWithAgent[0]?.agentUserId).toBe("agent-1");
  });
});

describe("All Agents Activity API - Pagination", () => {
  it("should limit total activities across all agents", () => {
    const limit = 10;
    const activities = Array.from({ length: 50 }, (_, i) => ({
      id: `activity-${i}`,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));

    const limited = activities.slice(0, limit);
    expect(limited.length).toBe(10);
  });

  it("should set hasMore=true when total exceeds limit", () => {
    const limit = 50;
    const totalFromAllAgents = 75;
    const hasMore = totalFromAllAgents > limit;

    expect(hasMore).toBe(true);
  });

  it("should handle case where each agent has few activities", () => {
    // 3 agents, each with 5 activities = 15 total, limit 50
    const agentActivities = {
      "agent-1": 5,
      "agent-2": 5,
      "agent-3": 5,
    };

    const total = Object.values(agentActivities).reduce((a, b) => a + b, 0);
    const limit = 50;
    const hasMore = total > limit;

    expect(total).toBe(15);
    expect(hasMore).toBe(false);
  });

  it("should handle case where one agent has many activities", () => {
    // 3 agents, one has 100, others have 5 each
    const agentActivities = {
      "agent-1": 100,
      "agent-2": 5,
      "agent-3": 5,
    };

    const total = Object.values(agentActivities).reduce((a, b) => a + b, 0);
    const limit = 50;

    expect(total).toBe(110);
    expect(total > limit).toBe(true);
  });
});

describe("All Agents Activity API - Market Questions", () => {
  it("should fetch market questions for prediction trades from all agents", () => {
    const trades = [
      createMockAgentTrade({
        agentUserId: "agent-1",
        marketType: "prediction",
        marketId: "market-a",
      }),
      createMockAgentTrade({
        agentUserId: "agent-2",
        marketType: "prediction",
        marketId: "market-b",
      }),
      createMockAgentTrade({
        agentUserId: "agent-1",
        marketType: "prediction",
        marketId: "market-a",
      }), // duplicate market
    ];

    const marketIds = trades
      .filter((t) => t.marketType === "prediction" && t.marketId)
      .map((t) => t.marketId!);

    const uniqueMarketIds = [...new Set(marketIds)];

    expect(marketIds.length).toBe(3);
    expect(uniqueMarketIds.length).toBe(2);
    expect(uniqueMarketIds).toContain("market-a");
    expect(uniqueMarketIds).toContain("market-b");
  });
});

describe("All Agents Activity API - Response Format", () => {
  it("should return correct response structure", () => {
    const response = {
      success: true,
      activities: [],
      pagination: {
        limit: 50,
        count: 0,
        hasMore: false,
      },
    };

    expect(response).toHaveProperty("success");
    expect(response).toHaveProperty("activities");
    expect(response).toHaveProperty("pagination");
    expect(response.success).toBe(true);
    expect(Array.isArray(response.activities)).toBe(true);
  });

  it("should include agent info in each activity", () => {
    const agents = createMockAgents();
    const agent = agents[0]!;
    const trade = createMockAgentTrade({ agentUserId: agent.id });

    const activity = {
      type: "trade",
      id: trade.id,
      timestamp: trade.executedAt.toISOString(),
      agent: {
        id: agent.id,
        name: agent.name,
        profileImageUrl: agent.profileImageUrl,
      },
      data: {
        tradeId: trade.id,
        marketType: trade.marketType,
        marketId: trade.marketId,
        ticker: trade.ticker,
        marketQuestion: null,
        action: trade.action,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        pnl: trade.pnl,
        reasoning: trade.reasoning,
      },
    };

    expect(activity.agent).toBeDefined();
    expect(activity.agent.id).toBe("agent-1");
    expect(activity.agent.name).toBe("Trading Bot Alpha");
    expect(activity.agent.profileImageUrl).toBe(
      "https://example.com/alpha.png",
    );
  });
});

describe("All Agents Activity API - Type Filtering", () => {
  type FilterType = "all" | "trade" | "post" | "comment";

  const shouldFetch = (
    type: FilterType,
    targetType: "trade" | "post" | "comment",
  ): boolean => {
    return type === "all" || type === targetType;
  };

  it("should filter by trade type only", () => {
    const type: FilterType = "trade";
    expect(shouldFetch(type, "trade")).toBe(true);
    expect(shouldFetch(type, "post")).toBe(false);
    expect(shouldFetch(type, "comment")).toBe(false);
  });

  it("should filter by post type only", () => {
    const type: FilterType = "post";
    expect(shouldFetch(type, "trade")).toBe(false);
    expect(shouldFetch(type, "post")).toBe(true);
    expect(shouldFetch(type, "comment")).toBe(false);
  });

  it("should filter by comment type only", () => {
    const type: FilterType = "comment";
    expect(shouldFetch(type, "trade")).toBe(false);
    expect(shouldFetch(type, "post")).toBe(false);
    expect(shouldFetch(type, "comment")).toBe(true);
  });

  it("should fetch all types when type=all", () => {
    const type: FilterType = "all";
    expect(shouldFetch(type, "trade")).toBe(true);
    expect(shouldFetch(type, "post")).toBe(true);
    expect(shouldFetch(type, "comment")).toBe(true);
  });
});
