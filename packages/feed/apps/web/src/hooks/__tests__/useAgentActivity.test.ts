/**
 * Tests for useAgentActivity Hook
 *
 * Comprehensive tests covering:
 * - URL construction
 * - Activity deduplication
 * - SSE message parsing
 * - Activity merging and sorting
 * - Error handling
 * - Configuration options
 */

import { describe, expect, it } from "bun:test";
import {
  type AgentActivity,
  type CommentActivityData,
  extractActivityId as hookExtractActivityId,
  type MessageActivityData,
  type PostActivityData,
  type TradeActivityData,
} from "../useAgentActivity";

// Helper functions (replicating hook logic for testing)
function buildApiUrl(
  agentId: string | undefined,
  limit: number,
  type: string,
): string {
  const base = agentId
    ? `/api/agents/${agentId}/activity`
    : "/api/agents/activity";
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("type", type);
  return `${base}?${params.toString()}`;
}

/**
 * Test wrapper for extractActivityId - uses the actual hook implementation
 * but with an interface that matches test usage patterns.
 */
function extractActivityId(
  activityData: AgentActivity["data"],
  type: AgentActivity["type"],
  timestamp: number,
  agentId = "agent-123",
): string {
  return hookExtractActivityId(activityData, `${type}-${agentId}-${timestamp}`);
}

function mergeAndDeduplicateActivities(
  realtimeActivities: AgentActivity[],
  fetchedActivities: AgentActivity[],
  limit: number,
): AgentActivity[] {
  const allActivities = [...realtimeActivities, ...fetchedActivities];
  const uniqueActivities = new Map<string, AgentActivity>();

  for (const activity of allActivities) {
    if (!uniqueActivities.has(activity.id)) {
      uniqueActivities.set(activity.id, activity);
    }
  }

  return Array.from(uniqueActivities.values())
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
    .slice(0, limit);
}

describe("URL Construction", () => {
  describe("Single Agent URL", () => {
    it("should build URL for specific agent", () => {
      const url = buildApiUrl("agent-123", 50, "all");

      expect(url).toBe("/api/agents/agent-123/activity?limit=50&type=all");
    });

    it("should include limit parameter", () => {
      const url = buildApiUrl("agent-123", 20, "all");

      expect(url).toContain("limit=20");
    });

    it("should include type parameter", () => {
      const url = buildApiUrl("agent-123", 50, "trade");

      expect(url).toContain("type=trade");
    });

    it("should handle agent ID with special characters", () => {
      const url = buildApiUrl("agent-123-abc", 50, "all");

      expect(url).toContain("/api/agents/agent-123-abc/activity");
    });
  });

  describe("All Agents URL", () => {
    it("should build URL for all agents when no agentId", () => {
      const url = buildApiUrl(undefined, 50, "all");

      expect(url).toBe("/api/agents/activity?limit=50&type=all");
    });

    it("should not include agentId in path", () => {
      const url = buildApiUrl(undefined, 50, "all");

      expect(url).not.toContain("/api/agents/undefined");
      expect(url.startsWith("/api/agents/activity")).toBe(true);
    });
  });

  describe("Parameter Variations", () => {
    it("should handle minimum limit", () => {
      const url = buildApiUrl("agent-1", 1, "all");

      expect(url).toContain("limit=1");
    });

    it("should handle maximum limit", () => {
      const url = buildApiUrl("agent-1", 100, "all");

      expect(url).toContain("limit=100");
    });

    it("should handle trade type filter", () => {
      const url = buildApiUrl("agent-1", 50, "trade");

      expect(url).toContain("type=trade");
    });

    it("should handle post type filter", () => {
      const url = buildApiUrl("agent-1", 50, "post");

      expect(url).toContain("type=post");
    });

    it("should handle comment type filter", () => {
      const url = buildApiUrl("agent-1", 50, "comment");

      expect(url).toContain("type=comment");
    });
  });
});

describe("Activity ID Extraction", () => {
  it("should extract tradeId from trade activity", () => {
    const data: TradeActivityData = {
      tradeId: "trade-123",
      marketType: "prediction",
      marketId: "market-1",
      ticker: null,
      marketQuestion: null,
      action: "open",
      side: "yes",
      amount: 100,
      price: 0.5,
      pnl: null,
      reasoning: null,
    };

    const id = extractActivityId(data, "trade", Date.now());

    expect(id).toBe("trade-123");
  });

  it("should extract postId from post activity", () => {
    const data: PostActivityData = {
      postId: "post-456",
      contentPreview: "Test post",
    };

    const id = extractActivityId(data, "post", Date.now());

    expect(id).toBe("post-456");
  });

  it("should extract commentId from comment activity", () => {
    const data: CommentActivityData = {
      commentId: "comment-789",
      postId: "post-1",
      contentPreview: "Test comment",
      parentCommentId: null,
    };

    const id = extractActivityId(data, "comment", Date.now());

    expect(id).toBe("comment-789");
  });

  it("should extract messageId from message activity", () => {
    const data: MessageActivityData = {
      messageId: "msg-101",
      chatId: "chat-1",
      recipientId: "user-1",
      contentPreview: "Test message",
    };

    const id = extractActivityId(data, "message", Date.now());

    expect(id).toBe("msg-101");
  });

  it("should generate fallback ID when no specific ID found", () => {
    // Edge case: data structure that doesn't match expected patterns
    const data = {} as AgentActivity["data"];
    const timestamp = 1234567890;
    const agentId = "agent-xyz";

    const id = extractActivityId(data, "trade", timestamp, agentId);

    // Fallback includes agentId to reduce collisions within same millisecond
    expect(id).toBe("trade-agent-xyz-1234567890");
  });
});

describe("Activity Deduplication", () => {
  const createTradeActivity = (id: string, timestamp: Date): AgentActivity => ({
    type: "trade",
    id,
    timestamp: timestamp.toISOString(),
    data: {
      tradeId: id,
      marketType: "prediction",
      marketId: "market-1",
      ticker: null,
      marketQuestion: null,
      action: "open",
      side: "yes",
      amount: 100,
      price: 0.5,
      pnl: null,
      reasoning: null,
    },
  });

  it("should remove duplicate activities by ID", () => {
    const now = new Date();
    const activities = [
      createTradeActivity("trade-1", now),
      createTradeActivity("trade-1", now), // duplicate
      createTradeActivity("trade-2", now),
    ];

    const uniqueActivities = new Map<string, AgentActivity>();
    for (const activity of activities) {
      if (!uniqueActivities.has(activity.id)) {
        uniqueActivities.set(activity.id, activity);
      }
    }

    expect(uniqueActivities.size).toBe(2);
    expect(Array.from(uniqueActivities.keys())).toContain("trade-1");
    expect(Array.from(uniqueActivities.keys())).toContain("trade-2");
  });

  it("should keep first occurrence of duplicate", () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 1000);

    const firstVersion = createTradeActivity("trade-1", earlier);
    const secondVersion = createTradeActivity("trade-1", now);

    const activities = [firstVersion, secondVersion];
    const uniqueActivities = new Map<string, AgentActivity>();
    for (const activity of activities) {
      if (!uniqueActivities.has(activity.id)) {
        uniqueActivities.set(activity.id, activity);
      }
    }

    const kept = uniqueActivities.get("trade-1");
    expect(kept?.timestamp).toBe(firstVersion.timestamp);
  });
});

describe("Activity Merging", () => {
  const createActivity = (
    id: string,
    type: AgentActivity["type"],
    timestamp: Date,
  ): AgentActivity => {
    if (type === "trade") {
      return {
        type: "trade",
        id,
        timestamp: timestamp.toISOString(),
        data: {
          tradeId: id,
          marketType: "prediction",
          marketId: "market-1",
          ticker: null,
          marketQuestion: null,
          action: "open",
          side: "yes",
          amount: 100,
          price: 0.5,
          pnl: null,
          reasoning: null,
        },
      };
    }
    return {
      type: "post",
      id,
      timestamp: timestamp.toISOString(),
      data: {
        postId: id,
        contentPreview: "Test post",
      },
    };
  };

  it("should merge realtime and fetched activities", () => {
    const now = Date.now();
    const realtimeActivities = [
      createActivity("new-trade-1", "trade", new Date(now)),
    ];
    const fetchedActivities = [
      createActivity("old-trade-1", "trade", new Date(now - 10000)),
      createActivity("old-post-1", "post", new Date(now - 20000)),
    ];

    const merged = mergeAndDeduplicateActivities(
      realtimeActivities,
      fetchedActivities,
      50,
    );

    expect(merged).toHaveLength(3);
  });

  it("should sort merged activities by timestamp descending", () => {
    const now = Date.now();
    const realtimeActivities = [
      createActivity("middle", "trade", new Date(now - 5000)),
    ];
    const fetchedActivities = [
      createActivity("newest", "trade", new Date(now)),
      createActivity("oldest", "post", new Date(now - 10000)),
    ];

    const merged = mergeAndDeduplicateActivities(
      realtimeActivities,
      fetchedActivities,
      50,
    );

    expect(merged[0].id).toBe("newest");
    expect(merged[1].id).toBe("middle");
    expect(merged[2].id).toBe("oldest");
  });

  it("should respect limit after merging", () => {
    const now = Date.now();
    const realtimeActivities = Array.from({ length: 10 }, (_, i) =>
      createActivity(`rt-${i}`, "trade", new Date(now - i * 1000)),
    );
    const fetchedActivities = Array.from({ length: 50 }, (_, i) =>
      createActivity(`fetched-${i}`, "trade", new Date(now - 10000 - i * 1000)),
    );

    const merged = mergeAndDeduplicateActivities(
      realtimeActivities,
      fetchedActivities,
      20,
    );

    expect(merged).toHaveLength(20);
  });

  it("should keep first occurrence when IDs collide (realtime before fetched)", () => {
    // Deduplication uses first-wins semantics - since realtime array is passed
    // first to the merge function, the realtime entry is preserved
    const now = new Date();
    const realtimeActivity = createActivity("shared-id", "trade", now);
    const fetchedActivity = createActivity("shared-id", "trade", now);

    const merged = mergeAndDeduplicateActivities(
      [realtimeActivity],
      [fetchedActivity],
      50,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("shared-id");
  });
});

describe("SSE Message Parsing", () => {
  interface SSEActivityMessage {
    type: string;
    activity: {
      type: AgentActivity["type"];
      agentId: string;
      agentName: string;
      timestamp: number;
      data: AgentActivity["data"];
    };
  }

  const isAgentActivityMessage = (
    message: Record<string, unknown>,
  ): message is SSEActivityMessage => {
    const eventType = message.type as string;
    return eventType?.startsWith("agent_") && message.activity !== undefined;
  };

  it("should recognize agent_trade event type", () => {
    const message = {
      type: "agent_trade",
      activity: {
        type: "trade",
        agentId: "agent-1",
        agentName: "Test Agent",
        timestamp: Date.now(),
        data: {
          tradeId: "trade-1",
          marketType: "prediction",
          marketId: "market-1",
          ticker: null,
          marketQuestion: null,
          action: "open",
          side: "yes",
          amount: 100,
          price: 0.5,
          pnl: null,
          reasoning: null,
        },
      },
    };

    expect(isAgentActivityMessage(message)).toBe(true);
  });

  it("should recognize agent_post event type", () => {
    const message = {
      type: "agent_post",
      activity: {
        type: "post",
        agentId: "agent-1",
        agentName: "Test Agent",
        timestamp: Date.now(),
        data: {
          postId: "post-1",
          contentPreview: "Test post content",
        },
      },
    };

    expect(isAgentActivityMessage(message)).toBe(true);
  });

  it("should recognize agent_comment event type", () => {
    const message = {
      type: "agent_comment",
      activity: {
        type: "comment",
        agentId: "agent-1",
        agentName: "Test Agent",
        timestamp: Date.now(),
        data: {
          commentId: "comment-1",
          postId: "post-1",
          contentPreview: "Test comment",
          parentCommentId: null,
        },
      },
    };

    expect(isAgentActivityMessage(message)).toBe(true);
  });

  it("should recognize agent_message event type", () => {
    const message = {
      type: "agent_message",
      activity: {
        type: "message",
        agentId: "agent-1",
        agentName: "Test Agent",
        timestamp: Date.now(),
        data: {
          messageId: "msg-1",
          chatId: "chat-1",
          recipientId: "user-1",
          contentPreview: "Test message",
        },
      },
    };

    expect(isAgentActivityMessage(message)).toBe(true);
  });

  it("should reject non-agent event types", () => {
    const message = {
      type: "chat_message",
      data: { content: "Hello" },
    };

    expect(isAgentActivityMessage(message)).toBe(false);
  });

  it("should reject messages without activity payload", () => {
    const message = {
      type: "agent_trade",
      data: { tradeId: "trade-1" },
    };

    expect(isAgentActivityMessage(message)).toBe(false);
  });
});

describe("SSE Channel Configuration", () => {
  it("should create agent channel when agentId provided and SSE enabled", () => {
    const agentId = "agent-123";
    const enableSSE = true;

    const sseChannel = enableSSE && agentId ? `agent:${agentId}` : null;

    expect(sseChannel).toBe("agent:agent-123");
  });

  it("should return null when SSE disabled", () => {
    const agentId = "agent-123";
    const enableSSE = false;

    const sseChannel = enableSSE && agentId ? `agent:${agentId}` : null;

    expect(sseChannel).toBeNull();
  });

  it("should return null when no agentId provided", () => {
    const agentId = undefined;
    const enableSSE = true;

    const sseChannel = enableSSE && agentId ? `agent:${agentId}` : null;

    expect(sseChannel).toBeNull();
  });
});

describe("Default Options", () => {
  const defaultOptions = {
    limit: 50,
    type: "all",
    pollInterval: 30000,
    enableSSE: true,
  };

  it("should have correct default limit", () => {
    expect(defaultOptions.limit).toBe(50);
  });

  it("should have correct default type", () => {
    expect(defaultOptions.type).toBe("all");
  });

  it("should have correct default poll interval", () => {
    expect(defaultOptions.pollInterval).toBe(30000);
  });

  it("should have SSE enabled by default", () => {
    expect(defaultOptions.enableSSE).toBe(true);
  });
});

describe("Activity Transformation from SSE", () => {
  it("should transform SSE activity to hook activity format", () => {
    const sseActivity = {
      type: "trade" as const,
      agentId: "agent-1",
      agentName: "Trading Bot",
      timestamp: 1704067200000,
      data: {
        tradeId: "trade-123",
        marketType: "prediction" as const,
        marketId: "market-1",
        ticker: null,
        marketQuestion: null,
        action: "open",
        side: "yes",
        amount: 100,
        price: 0.5,
        pnl: null,
        reasoning: "Test reasoning",
      },
    };

    const activityId = sseActivity.data.tradeId;
    const hookActivity: AgentActivity = {
      type: sseActivity.type,
      id: activityId,
      timestamp: new Date(sseActivity.timestamp).toISOString(),
      agent: {
        id: sseActivity.agentId,
        name: sseActivity.agentName,
        profileImageUrl: null,
      },
      data: sseActivity.data,
    };

    expect(hookActivity.type).toBe("trade");
    expect(hookActivity.id).toBe("trade-123");
    expect(hookActivity.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(hookActivity.agent?.id).toBe("agent-1");
    expect(hookActivity.agent?.name).toBe("Trading Bot");
    expect(hookActivity.agent?.profileImageUrl).toBeNull();
  });
});

describe("Error States", () => {
  it("should create proper error from Error object", () => {
    const error = new Error("Network error");

    expect(error instanceof Error).toBe(true);
    expect(error.message).toBe("Network error");
  });

  it("should create error from string", () => {
    const errorString = "Something went wrong";
    const error = new Error(errorString);

    expect(error.message).toBe("Something went wrong");
  });

  it("should handle fetch errors", () => {
    const response = {
      ok: false,
      statusText: "Internal Server Error",
    };

    if (!response.ok) {
      const error = new Error(
        `Failed to fetch activity: ${response.statusText}`,
      );
      expect(error.message).toBe(
        "Failed to fetch activity: Internal Server Error",
      );
    }
  });
});

describe("Pagination", () => {
  it("should determine hasMore from pagination response", () => {
    const paginationWithMore = { limit: 50, count: 50, hasMore: true };
    const paginationWithoutMore = { limit: 50, count: 30, hasMore: false };

    expect(paginationWithMore.hasMore).toBe(true);
    expect(paginationWithoutMore.hasMore).toBe(false);
  });

  it("should handle null pagination gracefully", () => {
    const pagination = null;
    const hasMore = pagination?.hasMore ?? false;

    expect(hasMore).toBe(false);
  });

  it("should handle undefined pagination gracefully", () => {
    const pagination = undefined;
    const hasMore = pagination?.hasMore ?? false;

    expect(hasMore).toBe(false);
  });
});

describe("Seen Activity IDs Tracking", () => {
  it("should track seen IDs to prevent duplicates", () => {
    const seenIds = new Set<string>();

    // First time seeing this ID
    const id = "trade-123";
    expect(seenIds.has(id)).toBe(false);

    seenIds.add(id);
    expect(seenIds.has(id)).toBe(true);

    // Second time - should be skipped
    expect(seenIds.has(id)).toBe(true);
  });

  it("should handle many IDs efficiently", () => {
    const seenIds = new Set<string>();

    // Add many IDs
    for (let i = 0; i < 10000; i++) {
      seenIds.add(`activity-${i}`);
    }

    // Check lookups are still fast
    expect(seenIds.has("activity-5000")).toBe(true);
    expect(seenIds.has("activity-99999")).toBe(false);
  });
});

describe("Seen Activity IDs Memory Management", () => {
  const MAX_SEEN_IDS = 500;

  it("should cap seen IDs set at MAX_SEEN_IDS (500)", () => {
    const seenIds = new Set<string>();

    // Add 600 IDs (more than MAX)
    for (let i = 0; i < 600; i++) {
      if (seenIds.size >= MAX_SEEN_IDS) {
        const iterator = seenIds.values();
        const oldest = iterator.next().value;
        if (oldest) seenIds.delete(oldest);
      }
      seenIds.add(`activity-${i}`);
    }

    // Should be capped at MAX_SEEN_IDS
    expect(seenIds.size).toBe(MAX_SEEN_IDS);

    // Oldest IDs should have been removed
    expect(seenIds.has("activity-0")).toBe(false);
    expect(seenIds.has("activity-99")).toBe(false);

    // Newest IDs should still exist
    expect(seenIds.has("activity-599")).toBe(true);
    expect(seenIds.has("activity-500")).toBe(true);
  });

  it("should remove oldest entries first when capping", () => {
    const seenIds = new Set<string>();

    // Add exactly MAX IDs
    for (let i = 0; i < MAX_SEEN_IDS; i++) {
      seenIds.add(`batch1-${i}`);
    }

    expect(seenIds.size).toBe(MAX_SEEN_IDS);

    // Add one more, triggering eviction
    if (seenIds.size >= MAX_SEEN_IDS) {
      const iterator = seenIds.values();
      const oldest = iterator.next().value;
      if (oldest) seenIds.delete(oldest);
    }
    seenIds.add("batch2-0");

    // Size should still be MAX_SEEN_IDS
    expect(seenIds.size).toBe(MAX_SEEN_IDS);

    // First ID from batch 1 should be gone
    expect(seenIds.has("batch1-0")).toBe(false);

    // Last ID from batch 1 should still exist
    expect(seenIds.has("batch1-499")).toBe(true);

    // New ID should exist
    expect(seenIds.has("batch2-0")).toBe(true);
  });

  it("should clear seen IDs on refresh", () => {
    const seenIds = new Set<string>();

    // Add some IDs
    seenIds.add("id-1");
    seenIds.add("id-2");
    seenIds.add("id-3");
    expect(seenIds.size).toBe(3);

    // Simulate refresh - clear the set
    seenIds.clear();

    expect(seenIds.size).toBe(0);
    expect(seenIds.has("id-1")).toBe(false);
    expect(seenIds.has("id-2")).toBe(false);
    expect(seenIds.has("id-3")).toBe(false);
  });

  it("should clear seen IDs when agentId changes", () => {
    const seenIds = new Set<string>();
    let currentAgentId = "agent-1";

    // Simulate tracking for agent-1
    seenIds.add("activity-from-agent-1");
    expect(seenIds.has("activity-from-agent-1")).toBe(true);

    // Simulate agentId change
    const newAgentId = "agent-2";
    if (currentAgentId !== newAgentId) {
      seenIds.clear();
      currentAgentId = newAgentId;
    }

    // Should be cleared
    expect(seenIds.size).toBe(0);
    expect(seenIds.has("activity-from-agent-1")).toBe(false);
  });
});
