/**
 * Dashboard Provider
 * Provides comprehensive agent context and state via A2A protocol
 *
 * A2A IS REQUIRED - This provider will not work without an active A2A connection
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "../../../shared/logger";
import type {
  A2ABalanceResponse,
  A2APositionsResponse,
} from "../../../types/a2a-responses";
import type { FeedRuntime } from "../types";

// Type guards for A2A responses
function isA2ABalanceResponse(data: object): data is A2ABalanceResponse {
  return (
    "balance" in data &&
    typeof (data as A2ABalanceResponse).balance === "number"
  );
}

function isA2APositionsResponse(data: object): data is A2APositionsResponse {
  return (
    "marketPositions" in data &&
    Array.isArray((data as A2APositionsResponse).marketPositions)
  );
}

/**
 * Provider: Comprehensive Dashboard
 * Provides complete agent context including portfolio, markets, social, and pending items
 * ALL DATA FETCHED VIA A2A PROTOCOL
 */
export const dashboardProvider: Provider = {
  name: "FEED_DASHBOARD",
  description:
    "Get comprehensive agent dashboard with portfolio, markets, social feed, and pending interactions via A2A protocol",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const feedRuntime = runtime as FeedRuntime;
    const agentUserId = runtime.agentId;

    // A2A is REQUIRED
    if (!feedRuntime.a2aClient?.isConnected()) {
      logger.error(
        "A2A client not connected - dashboard provider requires A2A protocol",
        undefined,
        runtime.agentId,
      );
      return {
        text: "ERROR: A2A client not connected. Cannot load dashboard. Please ensure A2A server is running.",
      };
    }

    // Fetch ALL dashboard data via A2A protocol
    const [balance, positions, predictions, feed, chats, notifications] =
      await Promise.all([
        feedRuntime.a2aClient.sendRequest("a2a.getBalance", {
          userId: agentUserId,
        }),
        feedRuntime.a2aClient.sendRequest("a2a.getPositions", {
          userId: agentUserId,
        }),
        feedRuntime.a2aClient
          .getPredictions({ status: "active" })
          .catch(() => ({ predictions: [] })),
        feedRuntime.a2aClient
          .getFeed({ limit: 5 })
          .catch(() => ({ posts: [] })),
        feedRuntime.a2aClient.getChats("all").catch(() => ({ chats: [] })),
        feedRuntime.a2aClient
          .getNotifications(5)
          .catch(() => ({ notifications: [] })),
      ]);

    // Validate response structures using type guards
    if (
      !balance ||
      typeof balance !== "object" ||
      !isA2ABalanceResponse(balance)
    ) {
      throw new Error("Invalid balance data format from A2A client");
    }
    if (
      !positions ||
      typeof positions !== "object" ||
      !isA2APositionsResponse(positions)
    ) {
      throw new Error("Invalid positions data format from A2A client");
    }
    const balanceData = balance;
    const positionsData = positions;
    const predictionsData = predictions as {
      predictions?: Array<{ id: string; question: string }>;
    };
    const feedData = feed as { posts?: Array<{ id: string; content: string }> };
    const chatsData = chats as { chats?: Array<{ id: string; name?: string }> };
    const notificationsData = notifications as {
      notifications?: Array<{ id: string; message: string }>;
    };

    const totalPositions =
      (positionsData.marketPositions?.length || 0) +
      (positionsData.perpPositions?.length || 0);
    const activeMarkets = predictionsData.predictions?.length || 0;
    const recentPosts = feedData.posts?.length || 0;
    const activeChats = chatsData.chats?.length || 0;
    const unreadNotifications = notificationsData.notifications?.length || 0;

    const result = `📊 AGENT DASHBOARD

💰 PORTFOLIO
Balance: $${balanceData.balance || 0}
Points: ${balanceData.reputationPoints || 0} pts
Open Positions: ${totalPositions}

📈 MARKETS
Active Markets: ${activeMarkets}
${
  predictionsData.predictions && predictionsData.predictions.length > 0
    ? `Recent: ${predictionsData.predictions
        .slice(0, 3)
        .map((p) => (p.question || "Unknown").substring(0, 50))
        .join(", ")}`
    : "No active markets"
}

📱 SOCIAL FEED
Recent Posts: ${recentPosts}
${
  feedData.posts && feedData.posts.length > 0 && feedData.posts[0]?.content
    ? `Latest: ${feedData.posts[0].content.substring(0, 100)}...`
    : "No recent posts"
}

💬 MESSAGING
Active Chats: ${activeChats}
${
  chatsData.chats && chatsData.chats.length > 0
    ? `Chats: ${chatsData.chats
        .slice(0, 3)
        .map((c) => c.name || c.id)
        .join(", ")}`
    : "No active chats"
}

🔔 NOTIFICATIONS
Unread: ${unreadNotifications}
${
  notificationsData.notifications &&
  notificationsData.notifications.length > 0 &&
  notificationsData.notifications[0]?.message
    ? `Latest: ${notificationsData.notifications[0].message.substring(0, 80)}...`
    : "No notifications"
}

💡 OPPORTUNITIES
- ${totalPositions > 0 ? "Monitor open positions" : "Consider opening positions"}
- ${activeMarkets > 0 ? "Review active markets" : "Check for new markets"}
- ${recentPosts > 0 ? "Engage with recent posts" : "Create new posts"}
- ${unreadNotifications > 0 ? "Review notifications" : "All caught up"}`;

    return { text: result };
  },
};
