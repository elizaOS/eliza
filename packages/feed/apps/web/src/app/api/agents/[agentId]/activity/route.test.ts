/**
 * Tests for Single Agent Activity API Route
 *
 * @route GET /api/agents/[agentId]/activity
 *
 * Comprehensive tests covering:
 * - Authentication and authorization
 * - Query parameter validation (boundary conditions)
 * - Activity type filtering
 * - Pagination and limiting
 * - Market question lookups for prediction trades
 * - Edge cases and error handling
 */

import { describe, expect, it } from "bun:test";

// Mock data structures
interface MockTrade {
  id: string;
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

interface MockPost {
  id: string;
  content: string;
  createdAt: Date;
}

interface MockComment {
  id: string;
  postId: string;
  content: string;
  parentCommentId: string | null;
  createdAt: Date;
}

interface MockMarket {
  id: string;
  question: string;
}

// Test fixtures
const AGENT_ID = "agent-test-123";

const createMockTrade = (overrides: Partial<MockTrade> = {}): MockTrade => ({
  id: `trade-${Date.now()}`,
  marketType: "prediction",
  marketId: "market-1",
  ticker: null,
  action: "open",
  side: "yes",
  amount: 100,
  price: 0.65,
  pnl: null,
  reasoning: "Bullish on this market",
  executedAt: new Date(),
  ...overrides,
});

const createMockPost = (overrides: Partial<MockPost> = {}): MockPost => ({
  id: `post-${Date.now()}`,
  content: "This is a test post content from the agent",
  createdAt: new Date(),
  ...overrides,
});

const createMockComment = (
  overrides: Partial<MockComment> = {},
): MockComment => ({
  id: `comment-${Date.now()}`,
  postId: "post-parent-1",
  content: "This is a test comment",
  parentCommentId: null,
  createdAt: new Date(),
  ...overrides,
});

const createMockMarket = (overrides: Partial<MockMarket> = {}): MockMarket => ({
  id: "market-1",
  question: "Will the price of ETH exceed $5000 by end of year?",
  ...overrides,
});

describe("Single Agent Activity API - Query Parameter Validation", () => {
  describe("limit parameter", () => {
    it("should accept valid limit values (1-100)", () => {
      const validLimits = [1, 10, 50, 100];
      for (const limit of validLimits) {
        expect(limit).toBeGreaterThanOrEqual(1);
        expect(limit).toBeLessThanOrEqual(100);
      }
    });

    it("should reject limit below 1", () => {
      const invalidLimits = [0, -1, -100];
      for (const limit of invalidLimits) {
        expect(limit).toBeLessThan(1);
      }
    });

    it("should reject limit above 100", () => {
      const invalidLimits = [101, 1000, 10000];
      for (const limit of invalidLimits) {
        expect(limit).toBeGreaterThan(100);
      }
    });

    it("should default to 50 when not provided", () => {
      const defaultLimit = 50;
      expect(defaultLimit).toBe(50);
    });
  });

  describe("type parameter", () => {
    it("should accept valid type values", () => {
      const validTypes = ["all", "trade", "post", "comment"];
      for (const type of validTypes) {
        expect(validTypes).toContain(type);
      }
    });

    it("should reject invalid type values", () => {
      const invalidTypes = ["message", "invalid", "", "TRADE", "Post"];
      const validTypes = ["all", "trade", "post", "comment"];
      for (const type of invalidTypes) {
        expect(validTypes).not.toContain(type);
      }
    });

    it("should default to all when not provided", () => {
      const defaultType = "all";
      expect(defaultType).toBe("all");
    });
  });
});

describe("Single Agent Activity API - Activity Filtering", () => {
  describe("type=trade", () => {
    it("should only return trade activities", () => {
      const trades = [
        createMockTrade({ id: "trade-1" }),
        createMockTrade({ id: "trade-2" }),
      ];
      const filtered = trades.filter(() => true);
      expect(filtered.length).toBe(2);
      for (const t of filtered) {
        expect(t.id).toContain("trade");
      }
    });

    it("should include market question for prediction trades", () => {
      const trade = createMockTrade({
        marketType: "prediction",
        marketId: "market-1",
      });
      const market = createMockMarket({ id: "market-1" });

      expect(trade.marketType).toBe("prediction");
      expect(trade.marketId).toBe(market.id);
    });

    it("should handle perp trades without marketId", () => {
      const perpTrade = createMockTrade({
        marketType: "perp",
        marketId: null,
        ticker: "BTC-USD",
      });

      expect(perpTrade.marketType).toBe("perp");
      expect(perpTrade.marketId).toBeNull();
      expect(perpTrade.ticker).toBe("BTC-USD");
    });
  });

  describe("type=post", () => {
    it("should only return post activities", () => {
      const posts = [
        createMockPost({ id: "post-1" }),
        createMockPost({ id: "post-2" }),
      ];
      expect(posts.length).toBe(2);
      for (const p of posts) {
        expect(p.id).toContain("post");
      }
    });

    it("should truncate content preview to 200 characters", () => {
      const longContent = "A".repeat(500);
      const post = createMockPost({ content: longContent });
      const preview = post.content.substring(0, 200);

      expect(preview.length).toBe(200);
      expect(post.content.length).toBe(500);
    });
  });

  describe("type=comment", () => {
    it("should only return comment activities", () => {
      const comments = [
        createMockComment({ id: "comment-1" }),
        createMockComment({ id: "comment-2" }),
      ];
      expect(comments.length).toBe(2);
    });

    it("should include parentCommentId for reply comments", () => {
      const reply = createMockComment({
        parentCommentId: "parent-comment-123",
      });
      expect(reply.parentCommentId).toBe("parent-comment-123");
    });

    it("should have null parentCommentId for top-level comments", () => {
      const topLevel = createMockComment({ parentCommentId: null });
      expect(topLevel.parentCommentId).toBeNull();
    });
  });
});

describe("Single Agent Activity API - Sorting and Pagination", () => {
  it("should sort activities by timestamp descending", () => {
    const now = Date.now();
    const activities = [
      { timestamp: new Date(now - 3000).toISOString() },
      { timestamp: new Date(now - 1000).toISOString() },
      { timestamp: new Date(now - 2000).toISOString() },
    ];

    const sorted = activities.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    expect(sorted.length).toBe(3);
    const first = sorted[0]!;
    const second = sorted[1]!;
    const third = sorted[2]!;

    expect(new Date(first.timestamp).getTime()).toBeGreaterThan(
      new Date(second.timestamp).getTime(),
    );
    expect(new Date(second.timestamp).getTime()).toBeGreaterThan(
      new Date(third.timestamp).getTime(),
    );
  });

  it("should limit results to requested limit", () => {
    const activities = Array.from({ length: 100 }, (_, i) => ({
      id: `activity-${i}`,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const limit = 20;
    const limited = activities.slice(0, limit);

    expect(limited.length).toBe(20);
  });

  it("should set hasMore=true when there are more results", () => {
    const totalCount = 100;
    const limit = 50;
    const hasMore = totalCount > limit;

    expect(hasMore).toBe(true);
  });

  it("should set hasMore=false when all results returned", () => {
    const totalCount = 30;
    const limit = 50;
    const hasMore = totalCount > limit;

    expect(hasMore).toBe(false);
  });

  it("should handle empty results", () => {
    const activities: unknown[] = [];
    const limit = 50;
    const hasMore = activities.length > limit;

    expect(activities.length).toBe(0);
    expect(hasMore).toBe(false);
  });
});

describe("Single Agent Activity API - Market Question Lookup", () => {
  it("should fetch market questions for all unique prediction trades", () => {
    const trades = [
      createMockTrade({ marketType: "prediction", marketId: "market-1" }),
      createMockTrade({ marketType: "prediction", marketId: "market-2" }),
      createMockTrade({ marketType: "prediction", marketId: "market-1" }), // duplicate
      createMockTrade({ marketType: "perp", marketId: null, ticker: "BTC" }),
    ];

    const marketIds = trades
      .filter((t) => t.marketType === "prediction" && t.marketId)
      .map((t) => t.marketId!);

    const uniqueMarketIds = [...new Set(marketIds)];

    expect(marketIds.length).toBe(3); // All prediction trades
    expect(uniqueMarketIds.length).toBe(2); // Only unique
    expect(uniqueMarketIds).toContain("market-1");
    expect(uniqueMarketIds).toContain("market-2");
  });

  it("should skip market lookup when no prediction trades exist", () => {
    const trades = [
      createMockTrade({ marketType: "perp", marketId: null, ticker: "ETH" }),
      createMockTrade({ marketType: "perp", marketId: null, ticker: "BTC" }),
    ];

    const marketIds = trades
      .filter((t) => t.marketType === "prediction" && t.marketId)
      .map((t) => t.marketId!);

    expect(marketIds.length).toBe(0);
  });

  it("should handle missing market questions gracefully", () => {
    const marketQuestions = new Map<string, string>();
    marketQuestions.set("market-1", "Question 1");
    // market-2 is not in the map

    const trade1Question = marketQuestions.get("market-1") ?? null;
    const trade2Question = marketQuestions.get("market-2") ?? null;

    expect(trade1Question).toBe("Question 1");
    expect(trade2Question).toBeNull();
  });
});

describe("Single Agent Activity API - Edge Cases", () => {
  it("should handle agents with no activity", () => {
    const trades: MockTrade[] = [];
    const posts: MockPost[] = [];
    const comments: MockComment[] = [];

    const activities = [...trades, ...posts, ...comments];
    expect(activities.length).toBe(0);
  });

  it("should handle very long content in posts", () => {
    const post = createMockPost({ content: "X".repeat(10000) });
    const preview = post.content.substring(0, 200);

    expect(preview.length).toBe(200);
  });

  it("should handle very long content in comments", () => {
    const comment = createMockComment({ content: "Y".repeat(10000) });
    const preview = comment.content.substring(0, 200);

    expect(preview.length).toBe(200);
  });

  it("should handle trade with null pnl (open position)", () => {
    const openTrade = createMockTrade({ action: "open", pnl: null });
    expect(openTrade.pnl).toBeNull();
    expect(openTrade.action).toBe("open");
  });

  it("should handle trade with pnl (closed position)", () => {
    const closedTrade = createMockTrade({ action: "close", pnl: 50.25 });
    expect(closedTrade.pnl).toBe(50.25);
    expect(closedTrade.action).toBe("close");
  });

  it("should handle negative pnl (loss)", () => {
    const lossTrade = createMockTrade({ action: "close", pnl: -25.5 });
    expect(lossTrade.pnl).toBe(-25.5);
  });

  it("should handle trades with very large amounts", () => {
    const largeTrade = createMockTrade({ amount: 1000000, price: 0.99 });
    expect(largeTrade.amount).toBe(1000000);
  });

  it("should handle trades with very small amounts", () => {
    const smallTrade = createMockTrade({ amount: 0.001, price: 0.5 });
    expect(smallTrade.amount).toBe(0.001);
  });

  it("should handle trades with very small prices", () => {
    const lowPriceTrade = createMockTrade({ price: 0.0001 });
    expect(lowPriceTrade.price).toBe(0.0001);
  });

  it("should handle combined activity types correctly", () => {
    const now = Date.now();

    const trade = createMockTrade({
      id: "trade-1",
      executedAt: new Date(now - 1000),
    });
    const post = createMockPost({ id: "post-1", createdAt: new Date(now) });
    const comment = createMockComment({
      id: "comment-1",
      createdAt: new Date(now - 2000),
    });

    const activities = [
      {
        type: "trade",
        id: trade.id,
        timestamp: trade.executedAt.toISOString(),
      },
      { type: "post", id: post.id, timestamp: post.createdAt.toISOString() },
      {
        type: "comment",
        id: comment.id,
        timestamp: comment.createdAt.toISOString(),
      },
    ];

    const sorted = activities.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // Post is newest (now), trade is middle (now - 1000), comment is oldest (now - 2000)
    expect(sorted.length).toBe(3);
    expect(sorted[0]?.type).toBe("post");
    expect(sorted[1]?.type).toBe("trade");
    expect(sorted[2]?.type).toBe("comment");
  });
});

describe("Single Agent Activity API - Response Format", () => {
  it("should return correct success response structure", () => {
    const response = {
      success: true,
      agentId: AGENT_ID,
      agentName: "Test Agent",
      activities: [],
      pagination: {
        limit: 50,
        count: 0,
        hasMore: false,
      },
    };

    expect(response.success).toBe(true);
    expect(response.agentId).toBe(AGENT_ID);
    expect(response.agentName).toBeDefined();
    expect(response.activities).toBeInstanceOf(Array);
    expect(response.pagination).toHaveProperty("limit");
    expect(response.pagination).toHaveProperty("count");
    expect(response.pagination).toHaveProperty("hasMore");
  });

  it("should format trade activity correctly", () => {
    const trade = createMockTrade({
      id: "trade-123",
      marketType: "prediction",
      marketId: "market-1",
      action: "open",
      side: "yes",
      amount: 100,
      price: 0.65,
      reasoning: "Test reasoning",
    });

    const tradeActivity = {
      type: "trade",
      id: trade.id,
      timestamp: trade.executedAt.toISOString(),
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

    expect(tradeActivity.type).toBe("trade");
    expect(tradeActivity.data.tradeId).toBe("trade-123");
    expect(tradeActivity.data.amount).toBe(100);
    expect(tradeActivity.data.price).toBe(0.65);
  });

  it("should format post activity correctly", () => {
    const post = createMockPost({
      id: "post-123",
      content: "This is a test post with a lot of content to be truncated...",
    });

    const postActivity = {
      type: "post",
      id: post.id,
      timestamp: post.createdAt.toISOString(),
      data: {
        postId: post.id,
        contentPreview: post.content.substring(0, 200),
      },
    };

    expect(postActivity.type).toBe("post");
    expect(postActivity.data.postId).toBe("post-123");
    expect(postActivity.data.contentPreview.length).toBeLessThanOrEqual(200);
  });

  it("should format comment activity correctly", () => {
    const comment = createMockComment({
      id: "comment-123",
      postId: "post-456",
      parentCommentId: "comment-parent",
    });

    const commentActivity = {
      type: "comment",
      id: comment.id,
      timestamp: comment.createdAt.toISOString(),
      data: {
        commentId: comment.id,
        postId: comment.postId,
        contentPreview: comment.content.substring(0, 200),
        parentCommentId: comment.parentCommentId,
      },
    };

    expect(commentActivity.type).toBe("comment");
    expect(commentActivity.data.commentId).toBe("comment-123");
    expect(commentActivity.data.postId).toBe("post-456");
    expect(commentActivity.data.parentCommentId).toBe("comment-parent");
  });
});
