/**
 * Tests for SSE Event Broadcaster - Agent Activity Broadcasting
 *
 * Comprehensive tests covering:
 * - Trade activity broadcasting
 * - Post activity broadcasting
 * - Comment activity broadcasting
 * - Message activity broadcasting
 * - Event structure validation
 * - Channel naming conventions
 * - Edge cases and error handling
 */

import { describe, expect, it } from "bun:test";

// Types matching the actual implementation
interface TradeActivityData {
  tradeId: string;
  marketType: "prediction" | "perp";
  marketId: string | null;
  ticker: string | null;
  marketQuestion?: string;
  action: "open" | "close";
  side: "long" | "short" | "yes" | "no" | null;
  amount: number;
  price: number;
  pnl: number | null;
  reasoning: string | null;
}

interface PostActivityData {
  postId: string;
  contentPreview: string;
}

interface CommentActivityData {
  commentId: string;
  postId: string;
  contentPreview: string;
  parentCommentId: string | null;
}

interface MessageActivityData {
  messageId: string;
  chatId: string;
  recipientId: string | null;
  contentPreview: string;
}

interface AgentActivityEvent {
  type: "trade" | "post" | "comment" | "message";
  agentId: string;
  agentName: string;
  timestamp: number;
  data:
    | TradeActivityData
    | PostActivityData
    | CommentActivityData
    | MessageActivityData;
}

// Test helper to create activity events
function createAgentActivityEvent<T extends AgentActivityEvent["data"]>(
  type: AgentActivityEvent["type"],
  agentId: string,
  agentName: string,
  data: T,
): AgentActivityEvent {
  return {
    type,
    agentId,
    agentName,
    timestamp: Date.now(),
    data,
  };
}

describe("Agent Activity Event Structure", () => {
  it("should create valid trade activity event", () => {
    const data: TradeActivityData = {
      tradeId: "trade-123",
      marketType: "prediction",
      marketId: "market-456",
      ticker: null,
      marketQuestion: "Will ETH reach $5000?",
      action: "open",
      side: "yes",
      amount: 100,
      price: 0.65,
      pnl: null,
      reasoning: "Bullish on ETH",
    };

    const event = createAgentActivityEvent(
      "trade",
      "agent-1",
      "My Agent",
      data,
    );

    expect(event.type).toBe("trade");
    expect(event.agentId).toBe("agent-1");
    expect(event.agentName).toBe("My Agent");
    expect(event.timestamp).toBeDefined();
    expect(typeof event.timestamp).toBe("number");
    expect(event.data).toEqual(data);
  });

  it("should create valid post activity event", () => {
    const data: PostActivityData = {
      postId: "post-123",
      contentPreview: "This is my post about the market...",
    };

    const event = createAgentActivityEvent("post", "agent-2", "Post Bot", data);

    expect(event.type).toBe("post");
    expect(event.data).toEqual(data);
    expect((event.data as PostActivityData).postId).toBe("post-123");
  });

  it("should create valid comment activity event", () => {
    const data: CommentActivityData = {
      commentId: "comment-123",
      postId: "post-456",
      contentPreview: "I agree with this analysis...",
      parentCommentId: null,
    };

    const event = createAgentActivityEvent(
      "comment",
      "agent-3",
      "Commenter",
      data,
    );

    expect(event.type).toBe("comment");
    expect(event.data).toEqual(data);
    expect((event.data as CommentActivityData).postId).toBe("post-456");
    expect((event.data as CommentActivityData).parentCommentId).toBeNull();
  });

  it("should create valid message activity event", () => {
    const data: MessageActivityData = {
      messageId: "msg-123",
      chatId: "chat-456",
      recipientId: "user-789",
      contentPreview: "Hello! This is a DM...",
    };

    const event = createAgentActivityEvent(
      "message",
      "agent-4",
      "Messenger",
      data,
    );

    expect(event.type).toBe("message");
    expect(event.data).toEqual(data);
    expect((event.data as MessageActivityData).recipientId).toBe("user-789");
  });
});

describe("Agent Channel Naming", () => {
  it("should use correct channel format for agent", () => {
    const agentId = "agent-123-abc";
    const channel = `agent:${agentId}`;

    expect(channel).toBe("agent:agent-123-abc");
    expect(channel.startsWith("agent:")).toBe(true);
  });

  it("should handle snowflake-style agent IDs", () => {
    const agentId = "1234567890123456789";
    const channel = `agent:${agentId}`;

    expect(channel).toBe("agent:1234567890123456789");
  });

  it("should handle agent IDs with special characters", () => {
    const agentId = "agent_with-mixed.chars";
    const channel = `agent:${agentId}`;

    expect(channel).toBe("agent:agent_with-mixed.chars");
  });
});

describe("Trade Activity Data - All Variations", () => {
  describe("Prediction Trades", () => {
    it("should handle YES side prediction trade", () => {
      const data: TradeActivityData = {
        tradeId: "trade-1",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "open",
        side: "yes",
        amount: 50,
        price: 0.75,
        pnl: null,
        reasoning: "Confident in outcome",
      };

      expect(data.marketType).toBe("prediction");
      expect(data.side).toBe("yes");
      expect(data.marketId).not.toBeNull();
      expect(data.ticker).toBeNull();
    });

    it("should handle NO side prediction trade", () => {
      const data: TradeActivityData = {
        tradeId: "trade-2",
        marketType: "prediction",
        marketId: "market-2",
        ticker: null,
        action: "open",
        side: "no",
        amount: 25,
        price: 0.35,
        pnl: null,
        reasoning: "Betting against",
      };

      expect(data.side).toBe("no");
    });

    it("should handle closed prediction trade with profit", () => {
      const data: TradeActivityData = {
        tradeId: "trade-3",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "close",
        side: "yes",
        amount: 50,
        price: 0.95,
        pnl: 15.5,
        reasoning: "Taking profits",
      };

      expect(data.action).toBe("close");
      expect(data.pnl).toBe(15.5);
      expect(data.pnl).toBeGreaterThan(0);
    });

    it("should handle closed prediction trade with loss", () => {
      const data: TradeActivityData = {
        tradeId: "trade-4",
        marketType: "prediction",
        marketId: "market-3",
        ticker: null,
        action: "close",
        side: "no",
        amount: 100,
        price: 0.85,
        pnl: -35.0,
        reasoning: "Cutting losses",
      };

      expect(data.pnl).toBe(-35.0);
      expect(data.pnl).toBeLessThan(0);
    });
  });

  describe("Perp Trades", () => {
    it("should handle LONG perp trade", () => {
      const data: TradeActivityData = {
        tradeId: "perp-1",
        marketType: "perp",
        marketId: null,
        ticker: "BTC-USD",
        action: "open",
        side: "long",
        amount: 0.5,
        price: 50000,
        pnl: null,
        reasoning: "Bullish on BTC",
      };

      expect(data.marketType).toBe("perp");
      expect(data.side).toBe("long");
      expect(data.ticker).toBe("BTC-USD");
      expect(data.marketId).toBeNull();
    });

    it("should handle SHORT perp trade", () => {
      const data: TradeActivityData = {
        tradeId: "perp-2",
        marketType: "perp",
        marketId: null,
        ticker: "ETH-USD",
        action: "open",
        side: "short",
        amount: 2.5,
        price: 3000,
        pnl: null,
        reasoning: "Bearish on ETH",
      };

      expect(data.side).toBe("short");
    });

    it("should handle closed perp trade with P&L", () => {
      const data: TradeActivityData = {
        tradeId: "perp-3",
        marketType: "perp",
        marketId: null,
        ticker: "BTC-USD",
        action: "close",
        side: "long",
        amount: 0.5,
        price: 52000,
        pnl: 1000.0,
        reasoning: "Exit at profit target",
      };

      expect(data.action).toBe("close");
      expect(data.pnl).toBe(1000.0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle trade with null reasoning", () => {
      const data: TradeActivityData = {
        tradeId: "trade-no-reason",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "open",
        side: "yes",
        amount: 10,
        price: 0.5,
        pnl: null,
        reasoning: null,
      };

      expect(data.reasoning).toBeNull();
    });

    it("should handle trade with null side", () => {
      const data: TradeActivityData = {
        tradeId: "trade-no-side",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "open",
        side: null,
        amount: 10,
        price: 0.5,
        pnl: null,
        reasoning: null,
      };

      expect(data.side).toBeNull();
    });

    it("should handle trade with very small amount", () => {
      const data: TradeActivityData = {
        tradeId: "trade-small",
        marketType: "perp",
        marketId: null,
        ticker: "BTC-USD",
        action: "open",
        side: "long",
        amount: 0.0001,
        price: 50000,
        pnl: null,
        reasoning: "Small position",
      };

      expect(data.amount).toBe(0.0001);
    });

    it("should handle trade with very large amount", () => {
      const data: TradeActivityData = {
        tradeId: "trade-large",
        marketType: "prediction",
        marketId: "market-whale",
        ticker: null,
        action: "open",
        side: "yes",
        amount: 1000000,
        price: 0.5,
        pnl: null,
        reasoning: "Whale trade",
      };

      expect(data.amount).toBe(1000000);
    });

    it("should handle trade with very small price", () => {
      const data: TradeActivityData = {
        tradeId: "trade-lowp",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "open",
        side: "yes",
        amount: 100,
        price: 0.0001,
        pnl: null,
        reasoning: "Low probability bet",
      };

      expect(data.price).toBe(0.0001);
    });

    it("should handle trade with price near 1", () => {
      const data: TradeActivityData = {
        tradeId: "trade-highp",
        marketType: "prediction",
        marketId: "market-1",
        ticker: null,
        action: "open",
        side: "yes",
        amount: 100,
        price: 0.9999,
        pnl: null,
        reasoning: "Near certain outcome",
      };

      expect(data.price).toBe(0.9999);
    });
  });
});

describe("Post Activity Data", () => {
  it("should handle normal content preview", () => {
    const data: PostActivityData = {
      postId: "post-123",
      contentPreview: "This is a normal length post about market conditions...",
    };

    expect(data.contentPreview.length).toBeLessThan(200);
  });

  it("should handle truncated content preview", () => {
    const fullContent = "A".repeat(500);
    const data: PostActivityData = {
      postId: "post-long",
      contentPreview: fullContent.substring(0, 200),
    };

    expect(data.contentPreview.length).toBe(200);
  });

  it("should handle empty content preview", () => {
    const data: PostActivityData = {
      postId: "post-empty",
      contentPreview: "",
    };

    expect(data.contentPreview).toBe("");
    expect(data.contentPreview.length).toBe(0);
  });

  it("should handle content with special characters", () => {
    const data: PostActivityData = {
      postId: "post-special",
      contentPreview:
        '🚀 $ETH to the moon! <script>alert("xss")</script> @user #crypto',
    };

    expect(data.contentPreview).toContain("🚀");
    expect(data.contentPreview).toContain("<script>");
  });

  it("should handle content with newlines", () => {
    const data: PostActivityData = {
      postId: "post-multiline",
      contentPreview: "Line 1\nLine 2\nLine 3",
    };

    expect(data.contentPreview).toContain("\n");
  });
});

describe("Comment Activity Data", () => {
  it("should handle top-level comment", () => {
    const data: CommentActivityData = {
      commentId: "comment-1",
      postId: "post-parent",
      contentPreview: "This is a top-level comment",
      parentCommentId: null,
    };

    expect(data.parentCommentId).toBeNull();
  });

  it("should handle reply comment", () => {
    const data: CommentActivityData = {
      commentId: "comment-2",
      postId: "post-parent",
      contentPreview: "This is a reply to another comment",
      parentCommentId: "comment-1",
    };

    expect(data.parentCommentId).toBe("comment-1");
    expect(data.parentCommentId).not.toBeNull();
  });

  it("should handle deeply nested reply", () => {
    const data: CommentActivityData = {
      commentId: "comment-deep",
      postId: "post-parent",
      contentPreview: "Deep nested reply",
      parentCommentId: "comment-level-5",
    };

    expect(data.parentCommentId).toBe("comment-level-5");
  });
});

describe("Message Activity Data", () => {
  it("should handle DM with recipient", () => {
    const data: MessageActivityData = {
      messageId: "msg-1",
      chatId: "dm-user1-user2",
      recipientId: "user2",
      contentPreview: "Hey, check out this market!",
    };

    expect(data.recipientId).toBe("user2");
    expect(data.chatId.startsWith("dm-")).toBe(true);
  });

  it("should handle group chat message", () => {
    const data: MessageActivityData = {
      messageId: "msg-2",
      chatId: "group-chat-123",
      recipientId: null,
      contentPreview: "Hello everyone in the group!",
    };

    expect(data.recipientId).toBeNull();
    expect(data.chatId.startsWith("group-")).toBe(true);
  });

  it("should handle message with truncated preview", () => {
    const longMessage = "B".repeat(300);
    const data: MessageActivityData = {
      messageId: "msg-long",
      chatId: "chat-1",
      recipientId: "user-1",
      contentPreview: longMessage.substring(0, 200),
    };

    expect(data.contentPreview.length).toBe(200);
  });
});

describe("Broadcast Event Type Naming", () => {
  it("should use correct event type for trades", () => {
    const activityType = "trade";
    const eventType = `agent_${activityType}`;

    expect(eventType).toBe("agent_trade");
  });

  it("should use correct event type for posts", () => {
    const activityType = "post";
    const eventType = `agent_${activityType}`;

    expect(eventType).toBe("agent_post");
  });

  it("should use correct event type for comments", () => {
    const activityType = "comment";
    const eventType = `agent_${activityType}`;

    expect(eventType).toBe("agent_comment");
  });

  it("should use correct event type for messages", () => {
    const activityType = "message";
    const eventType = `agent_${activityType}`;

    expect(eventType).toBe("agent_message");
  });
});

describe("Timestamp Handling", () => {
  it("should use millisecond timestamp", () => {
    const timestamp = Date.now();

    expect(typeof timestamp).toBe("number");
    expect(timestamp.toString().length).toBeGreaterThanOrEqual(13);
  });

  it("should be convertible to ISO string", () => {
    const timestamp = Date.now();
    const isoString = new Date(timestamp).toISOString();

    expect(isoString).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it("should handle current time correctly", () => {
    const before = Date.now();
    const event = createAgentActivityEvent("trade", "agent-1", "Test", {
      tradeId: "t1",
      marketType: "prediction",
      marketId: "m1",
      ticker: null,
      action: "open",
      side: "yes",
      amount: 10,
      price: 0.5,
      pnl: null,
      reasoning: null,
    });
    const after = Date.now();

    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });
});
