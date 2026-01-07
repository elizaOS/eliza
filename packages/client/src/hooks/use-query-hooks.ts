import { GROUP_CHAT_SOURCE, USER_NAME } from '@/constants';
// Direct error handling without bridge layer
import type { Agent, Content, Memory, UUID, Memory as CoreMemory, Media } from '@elizaos/core';
import {
  useQuery,
  useMutation,
  useQueryClient,
  useQueries,
  UseQueryResult,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from './use-toast';
import { getEntityId } from '@/lib/utils';
import type {
  ServerMessage,
  MessageChannel as ClientMessageChannel,
  MessageServer as ClientMessageServer,
  UiMessage,
} from '@/types';
import clientLogger from '@/lib/logger';
import { useNavigate } from 'react-router-dom';
import {
  mapApiAgentToClient,
  mapApiChannelToClient,
  mapApiChannelsToClient,
  mapApiServersToClient,
  mapApiMessageToUi,
  mapApiLogToClient,
  mapApiMemoryToClient,
  type AgentLog,
} from '@/lib/api-type-mappers';
import type { ListRunsParams, RunDetail, RunSummary } from '@elizaos/api-client';
import { getElizaClient } from '@/lib/api-client-config';

// Helper to always get the current client instance (important after API key updates)
const getClient = () => getElizaClient();

/**
 * Represents content with additional user information.
 * @typedef {Object} ContentWithUser
 * @property {string} name - The name of the user.
 * @property {number} createdAt - The timestamp when the content was created.
 * @property {boolean} [isLoading] - Optional flag indicating if the content is currently loading.
 * @property {string} [worldId] - Optional ID of the world associated with the content.
 * @property {string} [id] - Optional ID field.
 */
type ContentWithUser = Content & {
  name: string;
  createdAt: number;
  isLoading?: boolean;
  worldId?: UUID;
  id?: UUID; // Add optional ID field
};

// AgentLog type is now imported from api-type-mappers

// Constants for stale times
export const STALE_TIMES = {
  FREQUENT: 30000, // 30 seconds - for data that changes often
  STANDARD: 120000, // 2 minutes - default
  RARE: 600000, // 10 minutes - for rarely changing data
  NEVER: Number.POSITIVE_INFINITY, // Only refetch on explicit invalidation
};

// Network Information API interface
/**
 * Interface for representing network information.
 *
 * @property {("slow-2g" | "2g" | "3g" | "4g" | "unknown")} effectiveType - The effective network type.
 * @property {boolean} saveData - Indicates if data saver mode is enabled.
 * @property {unknown} [key] - Additional properties with unknown value types.
 */

interface NetworkInformation {
  effectiveType: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
  saveData: boolean;
  [key: string]: unknown;
}

// Network status detection for smart polling
/**
 * A custom React hook that returns the network status information.
 * Utilizes the Network Information API if available.
 * @returns {{
 *  isOffline: boolean,
 *  effectiveType: string,
 *  saveData: boolean
 * }} The network status information including whether the user is offline, the effective connection type, and if data-saving mode is enabled.
 */
const useNetworkStatus = () => {
  // Get navigator.connection if available (Network Information API)
  const connection =
    typeof navigator !== 'undefined' && 'connection' in navigator
      ? (navigator as Navigator & { connection: NetworkInformation }).connection
      : null;

  // Return the effective connection type or a default value
  return {
    isOffline: typeof navigator !== 'undefined' && !navigator.onLine,
    effectiveType: connection?.effectiveType || 'unknown',
    saveData: connection?.saveData || false,
  };
};

// Hook for fetching agents with smart polling
/**
 * Fetches a list of agents from the server with polling and network-aware intervals.
 *
 * @param options - Optional configuration to override default query behavior.
 * @returns A React Query object containing the agents data and query state.
 *
 * @remark Polling frequency adapts to network conditions, using less frequent polling when offline or on slow connections.
 */
export function useAgents(options = {}) {
  const network = useNetworkStatus();

  return useQuery<{ data: { agents: Agent[] } }>({
    queryKey: ['agents'],
    queryFn: async () => {
      const result = await getClient().agents.listAgents();
      // Map the API agents to client format
      const mappedAgents = result.agents.map((agent) => mapApiAgentToClient(agent));
      return { data: { agents: mappedAgents } };
    },
    staleTime: STALE_TIMES.FREQUENT, // Use shorter stale time for real-time data
    // Use more frequent polling for real-time updates
    refetchInterval: !network.isOffline ? STALE_TIMES.FREQUENT : false,
    // Disable polling when the tab is not active
    refetchIntervalInBackground: false,
    // Configure based on network conditions
    ...(!network.isOffline &&
      network.effectiveType === 'slow-2g' && {
        refetchInterval: STALE_TIMES.STANDARD, // Poll less frequently on slow connections
      }),
    // Allow overriding any options
    ...options,
  });
}

// Hook for fetching a specific agent with smart polling
/**
 * Custom hook to fetch agent data based on the provided agentId.
 * @param {UUID | undefined | null} agentId - The ID of the agent to fetch data for.
 * @param {Object} options - Additional options to configure the query.
 * @returns {QueryResult} The result of the query containing agent data.
 */
export function useAgent(agentId: UUID | undefined | null, options = {}) {
  const network = useNetworkStatus();

  return useQuery<{ data: Agent }>({
    queryKey: ['agent', agentId],
    queryFn: async () => {
      if (!agentId) throw new Error('Agent ID is required');
      const result = await getClient().agents.getAgent(agentId);
      return { data: mapApiAgentToClient(result) };
    },
    staleTime: STALE_TIMES.FREQUENT, // Use shorter stale time for real-time data
    enabled: Boolean(agentId),
    // Use more frequent polling for real-time updates
    refetchInterval: !network.isOffline && Boolean(agentId) ? STALE_TIMES.FREQUENT : false,
    // Disable polling when the tab is not active
    refetchIntervalInBackground: false,
    // Configure based on network conditions
    ...(!network.isOffline &&
      network.effectiveType === 'slow-2g' && {
        refetchInterval: STALE_TIMES.STANDARD, // Poll less frequently on slow connections
      }),
    // Allow overriding any options
    ...options,
  });
}

type RunsListResponse = { runs: RunSummary[]; total: number; hasMore: boolean };

export function useAgentRuns(
  agentId: UUID | undefined | null,
  params?: ListRunsParams,
  options: Partial<UseQueryOptions<RunsListResponse, Error, RunsListResponse>> = {}
) {
  const network = useNetworkStatus();
  const sanitizedParams = params
    ? Object.fromEntries(Object.entries(params).filter(([_, value]) => value !== undefined))
    : undefined;
  const serializedParams = sanitizedParams ? JSON.stringify(sanitizedParams) : 'default';

  return useQuery<RunsListResponse>({
    queryKey: ['agent', agentId, 'runs', serializedParams],
    queryFn: async () => {
      if (!agentId) throw new Error('Agent ID is required');
      return getClient().runs.listRuns(agentId, sanitizedParams as ListRunsParams | undefined);
    },
    enabled: Boolean(agentId),
    staleTime: STALE_TIMES.FREQUENT,
    refetchInterval: !network.isOffline && Boolean(agentId) ? STALE_TIMES.FREQUENT : false,
    refetchIntervalInBackground: false,
    ...(!network.isOffline &&
      network.effectiveType === 'slow-2g' && {
        refetchInterval: STALE_TIMES.STANDARD,
      }),
    ...options,
  });
}

export function useAgentRunDetail(
  agentId: UUID | undefined | null,
  runId: UUID | undefined | null,
  roomId?: UUID | null,
  options: Partial<UseQueryOptions<RunDetail, Error, RunDetail>> = {}
) {
  const network = useNetworkStatus();

  return useQuery<RunDetail>({
    queryKey: ['agent', agentId, 'runs', 'detail', runId, roomId ?? null],
    queryFn: async () => {
      if (!agentId || !runId) throw new Error('Agent ID and Run ID are required');
      return getClient().runs.getRun(agentId, runId, roomId ?? undefined);
    },
    enabled: Boolean(agentId && runId),
    staleTime: STALE_TIMES.FREQUENT,
    refetchInterval: !network.isOffline && Boolean(agentId && runId) ? STALE_TIMES.FREQUENT : false,
    refetchIntervalInBackground: false,
    ...(!network.isOffline &&
      network.effectiveType === 'slow-2g' && {
        refetchInterval: STALE_TIMES.STANDARD,
      }),
    ...options,
  });
}

// Hook for starting an agent with optimistic updates
/**
 * Custom hook to start an agent by calling the API with the provided agent ID.
 *
 * @returns {MutationFunction<UUID, unknown>} The useMutation hook for starting an agent.
 */
export function useStartAgent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<{ data: { id: UUID; name: string; status: string } }, Error, UUID>({
    mutationFn: async (agentId: UUID) => {
      try {
        const result = await getClient().agents.startAgent(agentId);
        return { data: { id: agentId, name: 'Agent', status: result.status } };
      } catch (error) {
        // Use the centralized error handler, but preserve specific agent logic
        if (error instanceof Error) {
          if (error.message.includes('already running')) {
            throw new Error('Agent is already running.');
          }
        }
        throw error;
      }
    },
    onMutate: async (_agentId) => {
      // Optimistically update UI to show agent is starting
      toast({
        title: 'Starting Agent',
        description: 'Initializing agent...',
      });

      // Return context for potential rollback
      return {};
    },
    onSuccess: (response, agentId) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });

      toast({
        title: 'Agent Started',
        description: `${response?.data?.name || 'Agent'} is now running`,
      });
    },
    onError: (error) => {
      // Handle specific error cases
      const errorMessage = error instanceof Error ? error.message : 'Failed to start agent';

      toast({
        title: 'Error Starting Agent',
        description: `${errorMessage}. Please try again.`,
        variant: 'destructive',
      });
    },
  });
}

// Hook for stopping an agent with optimistic updates
/**
 * Custom hook to stop an agent by calling the API and updating the UI optimistically.
 *
 * @returns {UseMutationResult} - Object containing the mutation function and its handlers.
 */
export function useStopAgent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<{ data: { message: string } }, Error, UUID>({
    mutationFn: async (agentId: UUID) => {
      const result = await getClient().agents.stopAgent(agentId);
      return { data: { message: `Agent ${result.status}` } };
    },
    onMutate: async (agentId) => {
      // Optimistically update the UI
      // Get the agent data from the cache
      const agent = queryClient.getQueryData<Agent>(['agent', agentId]);

      if (agent) {
        toast({
          title: 'Stopping Agent',
          description: `Stopping ${agent.name}...`,
        });
      }
    },
    onSuccess: (response, agentId) => {
      // Immediately invalidate the queries for fresh data
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });

      toast({
        title: 'Agent Stopped',
        description: response?.data?.message || 'The agent has been successfully stopped',
      });
    },
    onError: (error, agentId) => {
      // Force invalidate on error
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });

      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to stop agent',
        variant: 'destructive',
      });
    },
  });
}

// Re-export UiMessage from types for backwards compatibility
export type { UiMessage } from '@/types';

/**
 * Custom hook to manage fetching and loading messages for a specific channel.
 * @param {UUID | undefined} channelId - The GLOBAL ID of the channel.
 * @returns {{...
}} An object containing messages data, loading states, etc.
 */
export function useChannelMessages(
  channelId: UUID | undefined, // Changed from UUID | null
  initialMessageServerId?: UUID | undefined // Changed from UUID (optional was already undefined)
): {
  data: UiMessage[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  fetchNextPage: () => Promise<void>; // Simplified pagination trigger
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  addMessage: (newMessage: UiMessage) => void;
  updateMessage: (messageId: UUID, updates: Partial<UiMessage>) => void;
  removeMessage: (messageId: UUID) => void;
  clearMessages: () => void;
} {
  const currentClientCentralId = getEntityId(); // Central ID of the currently logged-in user

  // Using a more manual approach for pagination with getChannelMessages
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<number | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(true);
  const [internalIsLoading, setInternalIsLoading] = useState<boolean>(true); // Start true
  const [internalIsError, setInternalIsError] = useState<boolean>(false);
  const [internalError, setInternalError] = useState<unknown>(null);
  const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false);

  const transformServerMessageToUiMessage = useCallback(
    (sm: ServerMessage, serverIdToUse?: UUID): UiMessage => {
      const isAgent = sm.authorId !== currentClientCentralId;
      let timestamp = Date.now(); // Default to now

      if (typeof sm.createdAt === 'number') {
        timestamp = sm.createdAt;
      } else if (typeof sm.createdAt === 'string') {
        const parsedTs = Date.parse(sm.createdAt); // Try direct parse
        if (!isNaN(parsedTs)) {
          timestamp = parsedTs;
        } else {
          // If direct parse fails, try moment (if available and robust)
          // For now, log a warning if it's an unparsable string not handled by Date.parse
          clientLogger.warn(
            '[transformServerMessageToUiMessage] createdAt string was not directly parsable by Date.parse():',
            sm.createdAt,
            'for message id:',
            sm.id
          );
          // As a fallback, could try new Date(sm.createdAt).getTime(), but Date.parse is usually sufficient
          // Defaulting to Date.now() if unparsable to avoid NaN
        }
      } else if (sm.createdAt) {
        // If it's not a number or string, but exists (e.g. could be a Date object from some contexts)
        // Attempt to convert. This is less likely if types are strict from server.
        try {
          const dateObjTimestamp = new Date(sm.createdAt as string | number | Date).getTime();
          if (!isNaN(dateObjTimestamp)) {
            timestamp = dateObjTimestamp;
          }
        } catch (e) {
          clientLogger.warn(
            '[transformServerMessageToUiMessage] Could not process createdAt (unknown type):',
            sm.createdAt,
            'for message:',
            sm.id
          );
        }
      }

      return {
        id: sm.id,
        text: sm.content,
        name: isAgent
          ? sm.metadata?.agentName ||
            sm.metadata?.authorDisplayName ||
            sm.authorDisplayName ||
            'Agent'
          : USER_NAME,
        senderId: sm.authorId,
        isAgent: isAgent,
        createdAt: timestamp,
        attachments: (sm.metadata?.attachments as Media[]) || [],
        thought: isAgent ? sm.metadata?.thought : undefined,
        actions: isAgent ? sm.metadata?.actions : undefined,
        channelId: sm.channelId,
        messageServerId: serverIdToUse || sm.metadata?.messageServerId || initialMessageServerId,
        source: sm.sourceType,
        isLoading: false,
        prompt: isAgent ? sm.metadata?.prompt : undefined,
      };
    },
    [currentClientCentralId, initialMessageServerId]
  );

  const fetchMessages = useCallback(
    async (beforeTimestamp?: number) => {
      if (!channelId) {
        setMessages([]);
        setInternalIsLoading(false);
        return;
      }
      if (!beforeTimestamp) {
        setInternalIsLoading(true); // Full load
      } else {
        setIsFetchingMore(true);
      }
      setInternalIsError(false);
      setInternalError(null);

      try {
        const response = await getClient().messaging.getChannelMessages(channelId, {
          limit: 30,
          before: beforeTimestamp ? new Date(beforeTimestamp).toISOString() : undefined,
        });

        const newUiMessages = response.messages.map((msg) =>
          mapApiMessageToUi(msg, initialMessageServerId || (msg.metadata?.messageServerId as UUID))
        );

        setMessages((prev) => {
          const combined = beforeTimestamp ? [...newUiMessages, ...prev] : newUiMessages;
          const uniqueMessages = Array.from(
            new Map(combined.map((item) => [item.id, item])).values()
          );
          return uniqueMessages.sort((a, b) => a.createdAt - b.createdAt);
        });

        if (newUiMessages.length > 0) {
          const oldestFetched = Math.min(...newUiMessages.map((m) => m.createdAt));
          if (!beforeTimestamp || oldestFetched < (oldestMessageTimestamp || Infinity)) {
            setOldestMessageTimestamp(oldestFetched);
          }
        }
        setHasMoreMessages(newUiMessages.length >= 30);
      } catch (err) {
        setInternalIsError(true);
        setInternalError(err);
        clientLogger.error(`Failed to fetch messages for channel ${channelId}:`, err);
      } finally {
        setInternalIsLoading(false);
        setIsFetchingMore(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [channelId, transformServerMessageToUiMessage, initialMessageServerId]
  ); // Add initialMessageServerId to deps

  useEffect(() => {
    // Initial fetch when channelId changes or becomes available
    if (channelId) {
      clientLogger.info(
        `[useChannelMessages] ChannelId changed or became available: ${channelId}. Clearing messages and fetching initial set.`
      );
      setMessages([]); // Clear previous messages
      setOldestMessageTimestamp(null);
      setHasMoreMessages(true);
      fetchMessages(); // This will set internalIsLoading to true
    } else {
      clientLogger.info('[useChannelMessages] ChannelId is undefined. Clearing messages.');
      setMessages([]);
      setOldestMessageTimestamp(null);
      setHasMoreMessages(true);
      setInternalIsLoading(false); // No channel, so not loading anything
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, fetchMessages]); // fetchMessages is memoized with useCallback

  const fetchNextPage = async () => {
    if (hasMoreMessages && !isFetchingMore && oldestMessageTimestamp) {
      await fetchMessages(oldestMessageTimestamp - 1); // -1 to avoid fetching the same last message
    }
  };

  // Add method to manually add/update messages from external sources (e.g., WebSocket)
  const addMessage = useCallback((newMessage: UiMessage) => {
    setMessages((prev) => {
      // Check if message already exists
      const existingIndex = prev.findIndex((m) => m.id === newMessage.id);

      if (existingIndex >= 0) {
        // Update existing message
        const updated = [...prev];
        updated[existingIndex] = newMessage;
        return updated.sort((a, b) => a.createdAt - b.createdAt);
      } else {
        // Add new message
        return [...prev, newMessage].sort((a, b) => a.createdAt - b.createdAt);
      }
    });
  }, []);

  // Add method to update a message by ID
  const updateMessage = useCallback((messageId: UUID, updates: Partial<UiMessage>) => {
    setMessages((prev) => {
      return prev.map((m) => {
        if (m.id === messageId) {
          return { ...m, ...updates };
        }
        return m;
      });
    });
  }, []);

  // Add method to remove a message by ID
  const removeMessage = useCallback((messageId: UUID) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  // Add method to clear all messages
  const clearMessages = useCallback(() => {
    setMessages([]);
    setOldestMessageTimestamp(null);
    setHasMoreMessages(true);
  }, []);

  // This hook now manages its own state for messages
  // To integrate with React Query for caching of initial load or background updates:
  // One could use useInfiniteQuery, but given the manual state management already here for append/prepend,
  // this simpler useState + manual fetch approach is retained from the original structure of useMessages.
  // For full React Query benefits, `useInfiniteQuery` would be the way to go.

  return {
    data: messages,
    isLoading: internalIsLoading && messages.length === 0, // True only on initial load
    isError: internalIsError,
    error: internalError,
    fetchNextPage,
    hasNextPage: hasMoreMessages,
    isFetchingNextPage: isFetchingMore,
    addMessage,
    updateMessage,
    removeMessage,
    clearMessages,
  };
}

export function useGroupChannelMessages(channelId: UUID | null, initialMessageServerId?: UUID) {
  // This hook now becomes an alias or a slightly specialized version of useChannelMessages
  // if group-specific logic (like different source filtering) isn't handled here.
  // For now, it can directly use useChannelMessages.
  return useChannelMessages(channelId ?? undefined, initialMessageServerId);
}

// Hook for fetching agent actions
/**
 * Custom hook to fetch agent actions for a specific agent and room.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room.
 * @param {string[]} excludeTypes - Optional array of types to exclude from results.
 * @returns {QueryResult} The result of the query containing agent actions.
 */
export function useAgentActions(agentId: UUID, roomId?: UUID, excludeTypes?: string[]) {
  return useQuery({
    queryKey: ['agentActions', agentId, roomId, excludeTypes],
    queryFn: async () => {
      const response = await getClient().agents.getAgentLogs(agentId, {
        limit: 50,
      });
      if (!response) return [];

      // Filter to only include model calls (useModel:*) and actions
      const relevantLogs = response.filter((log) => {
        const logType = log.type || '';
        return logType.startsWith('useModel:') || logType === 'action';
      });

      return relevantLogs.map(mapApiLogToClient);
    },
    refetchInterval: 1000,
    staleTime: 1000,
  });
}

/**
 * Hook to delete an agent log/action.
 * @returns {UseMutationResult} - Object containing the mutation function and its handlers.
 */
export function useDeleteLog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ agentId, logId }: { agentId: UUID; logId: UUID }) => {
      await getClient().agents.deleteAgentLog(agentId, logId);
      return { agentId, logId };
    },

    onMutate: async ({ agentId, logId }) => {
      // Optimistically update the UI by removing the log from the cache
      const previousLogs = queryClient.getQueryData(['agentActions', agentId]);

      // Update cache if we have the data
      if (previousLogs) {
        queryClient.setQueryData(['agentActions', agentId], (oldData: unknown) => {
          if (Array.isArray(oldData)) {
            return oldData.filter((log: { id?: string }) => log.id !== logId);
          }
          return oldData;
        });
      }

      return { previousLogs, agentId, logId };
    },

    onSuccess: (_, { agentId }) => {
      // Invalidate relevant queries to refetch the latest data
      queryClient.invalidateQueries({ queryKey: ['agentActions', agentId] });

      toast({
        title: 'Log Deleted',
        description: 'The log entry has been successfully removed',
      });
    },

    onError: (error, { agentId }, context) => {
      // Revert the optimistic update on error
      if (context?.previousLogs) {
        queryClient.setQueryData(['agentActions', agentId], context.previousLogs);
      }

      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete log',
        variant: 'destructive',
      });

      // Force invalidate on error to ensure data is fresh
      queryClient.invalidateQueries({ queryKey: ['agentActions', agentId] });
    },
  });
}

/**
 * Fetches memories for a specific agent, optionally filtered by channel
 */
export function useAgentMemories(
  agentId: UUID,
  tableName?: string,
  channelId?: UUID, // Changed from roomId to channelId
  includeEmbedding = false
) {
  const queryKey = channelId
    ? ['agents', agentId, 'channels', channelId, 'memories', tableName, includeEmbedding] // Updated query key
    : ['agents', agentId, 'memories', tableName, includeEmbedding];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const params: Record<string, unknown> = {
        tableName,
        includeEmbedding,
      };
      const result = channelId
        ? await getClient().memory.getRoomMemories(agentId, channelId, params)
        : await getClient().memory.getAgentMemories(agentId, params);
      // Map the API memories to client format
      const memories = result.memories || [];
      return memories.map(mapApiMemoryToClient);
    },
    enabled: Boolean(agentId && tableName),
    staleTime: 1000,
    refetchInterval: 10 * 1000,
  });
}

/**
 * Provides a mutation hook to delete a specific memory entry for an agent.
 *
 * On success, invalidates related agent and room memory queries to ensure data consistency.
 */
export function useDeleteMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, memoryId }: { agentId: UUID; memoryId: UUID }) => {
      await getClient().memory.deleteMemory(agentId, memoryId);
      return { agentId, memoryId };
    },
    onSuccess: (data) => {
      // Invalidate relevant queries to trigger refetch
      queryClient.invalidateQueries({
        queryKey: ['agents', data.agentId, 'memories'],
      });

      // Also invalidate room-specific memories
      queryClient.invalidateQueries({
        queryKey: ['agents', data.agentId, 'rooms'],
        predicate: (query) => query.queryKey.length > 3 && query.queryKey[4] === 'memories',
      });
    },
  });
}

/**
 * Hook for deleting all memories associated with a specific agent in a given room.
 *
 * @returns A mutation object for triggering the deletion and tracking its state.
 */
export function useDeleteAllMemories() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, roomId }: { agentId: UUID; roomId: UUID }) => {
      await getClient().memory.clearRoomMemories(agentId, roomId);
      return { agentId };
    },
    onSuccess: (data) => {
      // Invalidate relevant queries to trigger refetch
      queryClient.invalidateQueries({
        queryKey: ['agents', data.agentId, 'memories'],
      });
    },
  });
}

/**
 * Updates a specific memory entry for an agent.
 *
 * Triggers cache invalidation for related agent and room memories, as well as messages, to ensure data consistency. Displays a toast notification on success or error.
 *
 * @returns A mutation object for updating an agent's memory entry.
 */
export function useUpdateMemory() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({
      agentId,
      memoryId,
      memoryData,
    }: {
      agentId: UUID;
      memoryId: UUID;
      memoryData: Partial<Memory>;
    }) => {
      const result = await getClient().memory.updateMemory(
        agentId,
        memoryId,
        memoryData as Record<string, unknown>
      );
      return { agentId, memoryId, result };
    },

    onSuccess: (data) => {
      // Invalidate relevant queries to trigger refetch
      queryClient.invalidateQueries({
        queryKey: ['agents', data.agentId, 'memories'],
      });

      // Also invalidate room-specific memories if we have roomId in the memory data
      if (data.result?.roomId) {
        queryClient.invalidateQueries({
          queryKey: ['agents', data.agentId, 'rooms', data.result.roomId, 'memories'],
        });
      } else {
        // Otherwise invalidate all room memories for this agent
        queryClient.invalidateQueries({
          queryKey: ['agents', data.agentId, 'rooms'],
          predicate: (query) => query.queryKey.length > 3 && query.queryKey[4] === 'memories',
        });
      }

      // Also invalidate regular messages queries
      if (data.result?.roomId) {
        queryClient.invalidateQueries({
          queryKey: ['messages', data.agentId, data.result.roomId],
        });
      }

      toast({
        title: 'Memory Updated',
        description: 'The memory has been successfully updated',
      });
    },

    onError: (error) => {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update memory',
        variant: 'destructive',
      });
    },
  });
}

export function useDeleteGroupMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ serverId, memoryId }: { serverId: UUID; memoryId: UUID }) => {
      await getClient().messaging.deleteMessage(serverId, memoryId);
      return { serverId };
    },
    onSuccess: ({ serverId }) => {
      queryClient.invalidateQueries({ queryKey: ['groupmessages', serverId] });
    },
  });
}

export function useClearGroupChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (serverId: UUID) => {
      await getClient().messaging.clearChannelHistory(serverId);
      return { serverId };
    },
    onSuccess: ({ serverId }) => {
      queryClient.invalidateQueries({ queryKey: ['groupmessages', serverId] });
    },
  });
}

// REMOVED: useRooms - Client should use channels, not rooms
// Rooms are an agent-only abstraction

// Hook for fetching agent panels (public GET routes)
/**
 * Custom hook to fetch public GET routes (panels) for a specific agent.
 * @param {UUID | undefined | null} agentId - The ID of the agent.
 * @param {object} options - Optional TanStack Query options.
 * @returns {QueryResult} The result of the query containing agent panels.
 */
export type AgentPanel = {
  id: string;
  name: string;
  url: string;
  type: string;
};

export function useAgentPanels(agentId: UUID | undefined | null, options = {}) {
  const network = useNetworkStatus();

  return useQuery<{
    success: boolean;
    data: AgentPanel[];
    error?: { code: string; message: string; details?: string };
  }>({
    queryKey: ['agentPanels', agentId],
    queryFn: async () => {
      if (!agentId) throw new Error('Agent ID required');
      const result = await getClient().agents.getAgentPanels(agentId);
      return { success: true, data: result.panels };
    },
    enabled: Boolean(agentId),
    staleTime: STALE_TIMES.STANDARD, // Panels are unlikely to change very frequently
    refetchInterval: !network.isOffline && Boolean(agentId) ? STALE_TIMES.RARE : false,
    refetchIntervalInBackground: false,
    ...(!network.isOffline &&
      network.effectiveType === 'slow-2g' && {
        refetchInterval: STALE_TIMES.NEVER, // Or even disable for slow connections
      }),
    ...options,
  });
}

/**
 * Custom hook that combines useAgents with individual useAgent calls for detailed data
 * @returns {AgentsWithDetailsResult} Combined query results with both list and detailed data
 */
interface AgentsWithDetailsResult {
  data: {
    agents: Agent[];
  };
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/**
 * Fetches a list of agents with detailed information for each agent in parallel.
 *
 * Combines the agent list from {@link useAgents} with individual agent detail queries using `useQueries`, aggregating loading and error states. Polling intervals adapt to network conditions.
 *
 * @returns An object containing detailed agent data, loading and error states, and any encountered error.
 */
export function useAgentsWithDetails(): AgentsWithDetailsResult {
  const network = useNetworkStatus();
  const { data: agentsData, isLoading: isAgentsLoading } = useAgents();
  const agentIds = agentsData?.data?.agents?.map((agent) => agent.id as UUID) || [];

  // Use useQueries for parallel fetching
  const agentQueries = useQueries<UseQueryResult<{ data: Agent }, Error>[]>({
    queries: agentIds.map((id) => ({
      queryKey: ['agent', id] as const,
      queryFn: async () => {
        const result = await getClient().agents.getAgent(id);
        return { data: result };
      },
      staleTime: STALE_TIMES.FREQUENT,
      enabled: Boolean(id),
      refetchInterval: !network.isOffline && Boolean(id) ? STALE_TIMES.FREQUENT : false,
      refetchIntervalInBackground: false,
      ...(!network.isOffline &&
        network.effectiveType === 'slow-2g' && {
          refetchInterval: STALE_TIMES.STANDARD,
        }),
    })),
  });

  // Safely check loading and error states
  const isLoading = isAgentsLoading || agentQueries.some((query) => query.isLoading);
  const isError = agentQueries.some((query) => query.isError);
  const error = agentQueries.find((query) => query.error)?.error;

  // Safely collect agent details
  const detailedAgents = agentQueries
    .filter((query): query is UseQueryResult<{ data: Agent }, Error> & { data: { data: Agent } } =>
      Boolean(query.data?.data)
    )
    .map((query) => query.data.data);

  return {
    data: {
      agents: detailedAgents,
    },
    isLoading,
    isError,
    error,
  };
}

// --- Hooks for Admin/Debug (Agent-Perspective Data) ---
export function useAgentInternalActions(
  agentId: UUID | null,
  agentPerspectiveRoomId?: UUID | null
) {
  return useQuery<AgentLog[], Error>({
    queryKey: ['agentInternalActions', agentId, agentPerspectiveRoomId],
    queryFn: async () => {
      if (!agentId) return []; // Or throw error, depending on desired behavior for null agentId
      const response = await getClient().agents.getAgentLogs(agentId, {
        limit: 50,
      });
      // Map the API logs to client format
      return response ? response.map(mapApiLogToClient) : [];
    },
    enabled: !!agentId, // Only enable if agentId is present
    staleTime: STALE_TIMES.FREQUENT,
    refetchInterval: 5000,
  });
}

export function useDeleteAgentInternalLog() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<void, Error, { agentId: UUID; logId: UUID }>({
    mutationFn: async ({ agentId, logId }: { agentId: UUID; logId: UUID }) => {
      await getClient().agents.deleteAgentLog(agentId, logId);
    },
    onSuccess: (_, { agentId }) => {
      queryClient.invalidateQueries({ queryKey: ['agentInternalActions', agentId] });
      queryClient.invalidateQueries({
        queryKey: ['agentInternalActions', agentId, undefined],
        exact: false,
      });
      toast({ title: 'Log Deleted', description: 'The agent log entry has been removed' });
    },
    onError: (error) => {
      toast({
        title: 'Error Deleting Log',
        description: error instanceof Error ? error.message : 'Failed to delete agent log',
        variant: 'destructive',
      });
    },
  });
}

export function useAgentInternalMemories(
  agentId: UUID | null,
  agentPerspectiveRoomId: UUID | null,
  tableName: string = 'messages',
  includeEmbedding = false
) {
  return useQuery<CoreMemory[], Error>({
    queryKey: [
      'agentInternalMemories',
      agentId,
      agentPerspectiveRoomId,
      tableName,
      includeEmbedding,
    ],
    queryFn: async () => {
      if (!agentId || !agentPerspectiveRoomId) return Promise.resolve([]);
      const response = await getClient().memory.getAgentInternalMemories(
        agentId,
        agentPerspectiveRoomId,
        includeEmbedding
      );
      return (response.data || []).map(mapApiMemoryToClient);
    },
    enabled: !!agentId && !!agentPerspectiveRoomId,
    staleTime: STALE_TIMES.STANDARD,
  });
}

export function useDeleteAgentInternalMemory() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ agentId: UUID; memoryId: UUID }, Error, { agentId: UUID; memoryId: UUID }>({
    mutationFn: async ({ agentId, memoryId }: { agentId: UUID; memoryId: UUID }) => {
      await getClient().memory.deleteAgentInternalMemory(agentId, memoryId);
      return { agentId, memoryId };
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Memory Deleted',
        description: `Agent memory ${variables.memoryId} removed.`,
      });
      queryClient.invalidateQueries({ queryKey: ['agentInternalMemories', variables.agentId] });
      // More specific invalidation if needed:
      // queryClient.invalidateQueries({ queryKey: ['agentInternalMemories', variables.agentId, variables.memoryData?.roomId] });
    },
    onError: (error) => {
      toast({
        title: 'Error Deleting Memory',
        description: error instanceof Error ? error.message : 'Failed to delete agent memory',
        variant: 'destructive',
      });
    },
  });
}

export function useDeleteAllAgentInternalMemories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<
    { agentId: UUID; agentPerspectiveRoomId: UUID },
    Error,
    { agentId: UUID; agentPerspectiveRoomId: UUID }
  >({
    mutationFn: async ({ agentId, agentPerspectiveRoomId }) => {
      await getClient().memory.deleteAllAgentInternalMemories(agentId, agentPerspectiveRoomId);
      return { agentId, agentPerspectiveRoomId };
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'All Memories Deleted',
        description: `All memories for agent in room perspective ${variables.agentPerspectiveRoomId} cleared.`,
      });
      queryClient.invalidateQueries({
        queryKey: ['agentInternalMemories', variables.agentId, variables.agentPerspectiveRoomId],
      });
    },
    onError: (error) => {
      toast({
        title: 'Error Clearing Memories',
        description: error instanceof Error ? error.message : 'Failed to clear agent memories',
        variant: 'destructive',
      });
    },
  });
}

export function useUpdateAgentInternalMemory() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<
    {
      agentId: UUID;
      memoryId: string;
      response: unknown;
    },
    Error,
    { agentId: UUID; memoryId: UUID; memoryData: Partial<CoreMemory> }
  >({
    mutationFn: async ({ agentId, memoryId, memoryData }) => {
      const response = await getClient().memory.updateAgentInternalMemory(
        agentId,
        memoryId,
        memoryData as Record<string, unknown>
      );
      return { agentId, memoryId, response };
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Memory Updated',
        description: `Agent memory ${variables.memoryId} updated.`,
      });
      queryClient.invalidateQueries({ queryKey: ['agentInternalMemories', variables.agentId] });
    },
    onError: (error) => {
      toast({
        title: 'Error Updating Memory',
        description: error instanceof Error ? error.message : 'Failed to update agent memory',
        variant: 'destructive',
      });
    },
  });
}

// --- Hooks for Servers and Channels (GUI Navigation) ---
export function useServers(options = {}) {
  const network = useNetworkStatus();
  return useQuery<{ data: { servers: ClientMessageServer[] } }>({
    queryKey: ['servers'],
    queryFn: async () => {
      const result = await getClient().messaging.listMessageServers();
      return { data: { servers: mapApiServersToClient(result.messageServers) } };
    },
    staleTime: STALE_TIMES.RARE,
    refetchInterval: !network.isOffline ? STALE_TIMES.RARE : false,
    ...options,
  });
}

export function useChannels(serverId: UUID | undefined, options = {}) {
  const network = useNetworkStatus();
  return useQuery<{ data: { channels: ClientMessageChannel[] } }>({
    queryKey: ['channels', serverId],
    queryFn: async () => {
      if (!serverId) return Promise.resolve({ data: { channels: [] } });
      const result = await getClient().messaging.getMessageServerChannels(serverId);
      return { data: { channels: mapApiChannelsToClient(result.channels) } };
    },
    enabled: !!serverId,
    staleTime: STALE_TIMES.STANDARD,
    refetchInterval: !network.isOffline && !!serverId ? STALE_TIMES.STANDARD : false,
    ...options,
  });
}

export function useChannelDetails(channelId: UUID | undefined, options = {}) {
  // Allow undefined
  const network = useNetworkStatus();
  return useQuery<{ success: boolean; data: ClientMessageChannel | null }>({
    queryKey: ['channelDetails', channelId],
    queryFn: async () => {
      if (!channelId) return Promise.resolve({ success: true, data: null });
      const result = await getClient().messaging.getChannelDetails(channelId);
      return { success: true, data: mapApiChannelToClient(result) };
    },
    enabled: !!channelId,
    staleTime: STALE_TIMES.STANDARD,
    refetchInterval: !network.isOffline && !!channelId ? STALE_TIMES.RARE : false,
    ...options,
  });
}

export function useChannelParticipants(channelId: UUID | undefined, options = {}) {
  // Allow undefined
  const network = useNetworkStatus();
  return useQuery<{ success: boolean; data: UUID[] }>({
    queryKey: ['channelParticipants', channelId],
    queryFn: async () => {
      if (!channelId) return Promise.resolve({ success: true, data: [] });
      try {
        const result = await getClient().messaging.getChannelParticipants(channelId);

        // Handle different possible response formats
        let participants = [];
        if (result && Array.isArray(result.participants)) {
          participants = result.participants.map((participant) => participant.userId);
        } else if (result && Array.isArray(result)) {
          // If result is directly an array
          participants = result.map(
            (participant) => participant.userId || participant.id || participant
          );
        }
        return { success: true, data: participants };
      } catch (error) {
        clientLogger.error('[useChannelParticipants] Error:', error);
        return { success: false, data: [] };
      }
    },
    enabled: !!channelId,
    staleTime: STALE_TIMES.STANDARD,
    refetchInterval: !network.isOffline && !!channelId ? STALE_TIMES.FREQUENT : false,
    ...options,
  });
}

export function useDeleteChannelMessage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<
    { channelId: UUID; messageId: UUID },
    Error,
    { channelId: UUID; messageId: UUID }
  >({
    mutationFn: async ({ channelId, messageId }) => {
      await getClient().messaging.deleteMessage(channelId, messageId);
      return { channelId, messageId };
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Message Deleted',
        description: 'Message removed successfully.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Error Deleting Message',
        description: error instanceof Error ? error.message : 'Failed to delete message',
        variant: 'destructive',
      });
    },
  });
}

export function useClearChannelMessages() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation<{ channelId: UUID }, Error, UUID>({
    mutationFn: async (channelId: UUID) => {
      await getClient().messaging.clearChannelHistory(channelId);
      return { channelId };
    },
    onSuccess: (_data, variables_channelId) => {
      toast({
        title: 'Channel Cleared',
        description: `All messages in channel ${variables_channelId} cleared.`,
      });
      queryClient.invalidateQueries({ queryKey: ['messages', variables_channelId] });
      queryClient.setQueryData(['messages', variables_channelId], () => []);
    },
    onError: (error) => {
      toast({
        title: 'Error Clearing Channel',
        description: error instanceof Error ? error.message : 'Failed to clear messages',
        variant: 'destructive',
      });
    },
  });
}

export function useDeleteChannel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();

  return useMutation<void, Error, { channelId: UUID; serverId: UUID }>({
    mutationFn: async ({ channelId }) => {
      await getClient().messaging.deleteChannel(channelId);
    },
    onSuccess: (_data, variables) => {
      toast({
        title: 'Group Deleted',
        description: 'The group has been successfully deleted.',
      });
      // Invalidate channel queries
      queryClient.invalidateQueries({ queryKey: ['channels', variables.serverId] });
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      // Navigate back to home
      navigate('/');
    },
    onError: (error) => {
      toast({
        title: 'Error Deleting Group',
        description: error instanceof Error ? error.message : 'Failed to delete group',
        variant: 'destructive',
      });
    },
  });
}
