/**
 * Hook for real-time agent activity updates.
 *
 * Combines SSE real-time updates with initial data fetching and polling fallback.
 * Provides a unified interface for displaying agent activity in the UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Channel, useSSEChannel } from "./useSSE";

// Activity types matching the API response
interface AgentInfo {
  id: string;
  name: string;
  profileImageUrl: string | null;
}

export interface TradeActivityData {
  tradeId: string;
  marketType: "prediction" | "perp";
  marketId: string | null;
  ticker: string | null;
  marketQuestion: string | null;
  action: string;
  side: string | null;
  amount: number;
  price: number;
  pnl: number | null;
  reasoning: string | null;
}

export interface PostActivityData {
  postId: string;
  contentPreview: string;
}

export interface CommentActivityData {
  commentId: string;
  postId: string;
  contentPreview: string;
  parentCommentId: string | null;
}

export interface MessageActivityData {
  messageId: string;
  chatId: string;
  recipientId: string | null;
  contentPreview: string;
}

export interface AgentActivity {
  type: "trade" | "post" | "comment" | "message";
  id: string;
  timestamp: string;
  agent?: AgentInfo;
  data:
    | TradeActivityData
    | PostActivityData
    | CommentActivityData
    | MessageActivityData;
}

interface AgentActivityResponse {
  success: boolean;
  agentId?: string;
  agentName?: string;
  activities: AgentActivity[];
  pagination: {
    limit: number;
    count: number;
    hasMore: boolean;
  };
}

interface UseAgentActivityOptions {
  agentId?: string;
  limit?: number;
  type?: "all" | "trade" | "post" | "comment";
  pollInterval?: number;
  enableSSE?: boolean;
}

/**
 * Extracts the canonical ID from activity data based on its type.
 * Order matters: commentId is checked before postId since comments have both.
 *
 * @param data - The activity data object
 * @param fallback - Fallback ID if no recognized field is found
 * @returns The activity's unique identifier
 */
export function extractActivityId(
  data: AgentActivity["data"],
  fallback: string,
): string {
  if ("tradeId" in data && data.tradeId) return data.tradeId;
  if ("commentId" in data && data.commentId) return data.commentId;
  if ("messageId" in data && data.messageId) return data.messageId;
  if ("postId" in data && data.postId) return data.postId;
  return fallback;
}

// Type guards for discriminated union
export function isTradeActivity(
  activity: AgentActivity,
): activity is AgentActivity & { data: TradeActivityData } {
  return activity.type === "trade";
}

export function isPostActivity(
  activity: AgentActivity,
): activity is AgentActivity & { data: PostActivityData } {
  return activity.type === "post";
}

export function isCommentActivity(
  activity: AgentActivity,
): activity is AgentActivity & { data: CommentActivityData } {
  return activity.type === "comment";
}

export function isMessageActivity(
  activity: AgentActivity,
): activity is AgentActivity & { data: MessageActivityData } {
  return activity.type === "message";
}

interface UseAgentActivityReturn {
  activities: AgentActivity[];
  isLoading: boolean;
  error: Error | null;
  isConnected: boolean;
  hasMore: boolean;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching and subscribing to agent activity updates.
 *
 * @param options - Configuration options
 * @param options.agentId - Specific agent ID to fetch activity for (optional, fetches all if not provided)
 * @param options.limit - Maximum number of activities to fetch (default: 50)
 * @param options.type - Filter by activity type (default: 'all')
 * @param options.pollInterval - Polling interval in ms for fallback updates (default: 30000)
 * @param options.enableSSE - Whether to enable real-time SSE updates (default: true)
 *
 * @returns Activity data, loading state, error state, and connection status
 *
 * @example
 * ```tsx
 * // Get activity for a specific agent
 * const { activities, isLoading, isConnected } = useAgentActivity({
 *   agentId: 'agent-123',
 *   limit: 20,
 * });
 *
 * // Get activity for all user's agents
 * const { activities, isLoading } = useAgentActivity({ limit: 50 });
 * ```
 */
export function useAgentActivity(
  options: UseAgentActivityOptions = {},
): UseAgentActivityReturn {
  const {
    agentId,
    limit = 50,
    type = "all",
    pollInterval = 30000,
    enableSSE = true,
  } = options;

  // State for fetched data
  const [fetchedActivities, setFetchedActivities] = useState<AgentActivity[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Track real-time activities that haven't been merged into fetched data yet
  const [realtimeActivities, setRealtimeActivities] = useState<AgentActivity[]>(
    [],
  );

  // Ref to track activities we've already seen to prevent duplicates.
  // Capped at MAX_SEEN_IDS to prevent memory leaks in long sessions.
  // Note: Set preserves insertion order in ES2015+, so iterator.next()
  // returns the oldest entry first, enabling LRU-style eviction.
  const MAX_SEEN_IDS = 500;
  const seenActivityIds = useRef(new Set<string>());

  // Clear seen IDs when agentId changes to prevent stale data
  const prevAgentIdRef = useRef(agentId);
  useEffect(() => {
    if (prevAgentIdRef.current !== agentId) {
      seenActivityIds.current.clear();
      prevAgentIdRef.current = agentId;
    }
  }, [agentId]);

  // Build the API URL
  const apiUrl = useMemo(() => {
    const base = agentId
      ? `/api/agents/${agentId}/activity`
      : "/api/agents/activity";
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("type", type);
    return `${base}?${params.toString()}`;
  }, [agentId, limit, type]);

  // Fetch function
  const fetchActivities = useCallback(async () => {
    setError(null);
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch activity: ${response.statusText}`);
    }
    const data: AgentActivityResponse = await response.json();

    // Update seen IDs (cap size to prevent memory leak).
    // Pre-evict to make room for incoming activities, then add all at once.
    const newIds = data.activities.map((a) => a.id);
    const spaceNeeded =
      seenActivityIds.current.size + newIds.length - MAX_SEEN_IDS;
    if (spaceNeeded > 0) {
      const iterator = seenActivityIds.current.values();
      for (let i = 0; i < spaceNeeded; i++) {
        const oldest = iterator.next().value;
        if (oldest) seenActivityIds.current.delete(oldest);
      }
    }
    for (const id of newIds) {
      seenActivityIds.current.add(id);
    }

    setFetchedActivities(data.activities);
    setHasMore(data.pagination?.hasMore ?? false);
    setIsLoading(false);
  }, [apiUrl]);

  // Initial fetch and polling
  useEffect(() => {
    setIsLoading(true);
    fetchActivities().catch((err: Error) => {
      setError(err);
      setIsLoading(false);
    });

    // Set up polling
    const intervalId = setInterval(() => {
      fetchActivities().catch((err: Error) => {
        console.error("Failed to poll agent activity:", err);
      });
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [fetchActivities, pollInterval]);

  // Handle SSE messages for real-time updates
  const handleSSEMessage = useCallback(
    (message: Record<string, unknown>) => {
      const eventType = message.type as string;
      if (!eventType?.startsWith("agent_") || !message.activity) {
        return;
      }

      const activity = message.activity as {
        type: AgentActivity["type"];
        agentId: string;
        agentName: string;
        profileImageUrl?: string | null;
        timestamp: number;
        data: AgentActivity["data"];
      };

      // Validate required fields exist (including timestamp to prevent Invalid Date)
      if (
        !activity.type ||
        !activity.agentId ||
        !activity.data ||
        typeof activity.timestamp !== "number" ||
        !Number.isFinite(activity.timestamp)
      ) {
        console.warn("Malformed SSE activity payload:", message);
        return;
      }

      // Extract activity ID using type guard function
      const activityId = extractActivityId(
        activity.data,
        `${activity.type}-${activity.agentId}-${activity.timestamp}`,
      );

      // Skip duplicates
      if (seenActivityIds.current.has(activityId)) {
        return;
      }

      // Cap seen IDs to prevent memory leak
      if (seenActivityIds.current.size >= MAX_SEEN_IDS) {
        const iterator = seenActivityIds.current.values();
        const oldest = iterator.next().value;
        if (oldest) seenActivityIds.current.delete(oldest);
      }
      seenActivityIds.current.add(activityId);

      const newActivity: AgentActivity = {
        type: activity.type,
        id: activityId,
        timestamp: new Date(activity.timestamp).toISOString(),
        agent: {
          id: activity.agentId,
          name: activity.agentName,
          profileImageUrl: activity.profileImageUrl ?? null,
        },
        data: activity.data,
      };

      setRealtimeActivities((prev) => [newActivity, ...prev].slice(0, limit));
    },
    [limit],
  );

  // Subscribe to agent SSE channel
  // Note: SSE is only enabled for single-agent views. For aggregate "My Moves" feed
  // (no agentId), we rely on polling since subscribing to multiple agent channels
  // would require knowing all agent IDs upfront and managing multiple subscriptions.
  const sseChannel: Channel | null =
    enableSSE && agentId ? `agent:${agentId}` : null;
  const { isConnected } = useSSEChannel(sseChannel, handleSSEMessage);

  // Merge real-time activities with fetched data.
  // Note: Both fetchActivities and handleSSEMessage mutate seenActivityIds.
  // Although JavaScript is single-threaded, async operations can interleave,
  // potentially causing both paths to process the same activity. This final
  // deduplication step (using Map) ensures no duplicates reach the UI.
  const activities = useMemo(() => {
    const allActivities = [...realtimeActivities, ...fetchedActivities];
    const uniqueActivities = new Map<string, AgentActivity>();

    for (const activity of allActivities) {
      if (!uniqueActivities.has(activity.id)) {
        uniqueActivities.set(activity.id, activity);
      }
    }

    // Sort by timestamp descending and limit
    return Array.from(uniqueActivities.values())
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, limit);
  }, [fetchedActivities, realtimeActivities, limit]);

  // Refresh function - clears seen IDs to allow fresh deduplication
  const refresh = useCallback(async () => {
    seenActivityIds.current.clear();
    setRealtimeActivities([]);
    setIsLoading(true);
    setError(null);
    try {
      await fetchActivities();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    }
  }, [fetchActivities]);

  return {
    activities,
    isLoading,
    error,
    isConnected,
    hasMore,
    refresh,
  };
}
