import { GROUP_CHAT_SOURCE, USER_NAME } from '@/constants';
import { apiClient } from '@/lib/api';
import { WorldManager } from '@/lib/world-manager';
import type { Agent, Content, Memory, UUID, Room } from '@elizaos/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from './use-toast';

// Define the ContentWithUser type
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
  worldId?: string;
  id?: string; // Add optional ID field
};

// Constants for stale times
export const STALE_TIMES = {
  FREQUENT: 30 * 1000, // 30 seconds - for data that changes often
  STANDARD: 2 * 60 * 1000, // 2 minutes - default
  RARE: 10 * 60 * 1000, // 10 minutes - for rarely changing data
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
 * Custom hook to fetch a list of agents from the server.
 * @param {object} options - Optional configuration options.
 * @returns {object} - A query object with data containing an array of agents.
 */
export function useAgents(options = {}) {
  const network = useNetworkStatus();

  return useQuery<{ data: { agents: Agent[] } }>({
    queryKey: ['agents'],
    queryFn: () => apiClient.getAgents(),
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

  return useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => apiClient.getAgent(agentId || ''),
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

// Hook for starting an agent with optimistic updates
/**
 * Custom hook to start an agent by calling the API with the provided agent ID.
 *
 * @returns {MutationFunction<UUID, unknown>} The useMutation hook for starting an agent.
 */
export function useStartAgent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (agentId: UUID) => {
      try {
        return await apiClient.startAgent(agentId);
      } catch (error) {
        // Capture specific error types
        if (error instanceof Error) {
          if (error.message.includes('network')) {
            throw new Error('Network error: Please check your connection and try again.');
          }
          if (error.message.includes('already running')) {
            throw new Error('Agent is already running.');
          }
        }
        throw error; // Re-throw if not a specific case we handle
      }
    },
    onMutate: async (agentId) => {
      // Optimistically update UI to show agent is starting
      toast({
        title: 'Starting Agent',
        description: 'Initializing agent...',
      });

      // Return context for potential rollback
      return { agentId };
    },
    onSuccess: (data) => {
      // Immediately invalidate the queries for fresh data
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['active-agents'] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ['agent', data.id] });
      }

      toast({
        title: 'Agent Started',
        description: `${data?.name || 'Agent'} is now running`,
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

  return useMutation({
    mutationFn: (agentId: string) => apiClient.stopAgent(agentId),
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
    onSuccess: (_, agentId) => {
      // Immediately invalidate the queries for fresh data
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', agentId] });

      toast({
        title: 'Agent Stopped',
        description: 'The agent has been successfully stopped',
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

// Hook for fetching messages directly for a specific agent without requiring a room
/**
 * Custom hook to fetch and return messages for a specific agent.
 * * @param { UUID } agentId - The unique identifier of the agent to get messages for.
 * @returns { Object } An object containing the messages for the agent.
 */
export function useAgentMessages(agentId: UUID) {
  const queryClient = useQueryClient();
  const worldId = WorldManager.getWorldId();

  // Get messages from cache or set default empty array
  const messages =
    queryClient.getQueryData<ContentWithUser[]>(['messages', agentId, worldId]) || [];

  return {
    messages,
  };
}

// The original useMessages hook remains for backward compatibility
/**
 * Custom hook to manage fetching and loading messages for a specific agent and room.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room.
 * @returns {{
 *  data: Memory[] | undefined;
 *  isLoading: boolean;
 *  isError: boolean;
 *  error: unknown;
 *  loadOlderMessages: () => Promise<boolean>;
 *  hasOlderMessages: boolean;
 *  isLoadingMore: boolean;
 * }} An object containing messages data, loading states, error state, function to load older messages,
 * indication of whether there are older messages, and loading state for loading older messages.
 */
export function useMessages(
  agentId: UUID,
  roomId: UUID
): {
  data: ContentWithUser[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  loadOlderMessages: () => Promise<boolean>;
  hasOlderMessages: boolean;
  isLoadingMore: boolean;
} {
  const queryClient = useQueryClient();
  const worldId = WorldManager.getWorldId();
  const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<number | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);

  // Initial fetch of messages
  const messagesQuery = useQuery({
    queryKey: ['messages', agentId, roomId, worldId],
    queryFn: async () => {
      const result = await apiClient.getMemories(agentId, roomId);
      return result.data.memories
        .map((memory: Memory): ContentWithUser => {
          // Convert Memory to ContentWithUser
          const contentWithUser: ContentWithUser = {
            text: memory.content.text,
            roomId: memory.roomId,
            user: memory.entityId === agentId ? 'agent' : USER_NAME,
            name: memory.entityId === agentId ? 'agent' : USER_NAME,
            createdAt: memory.createdAt || 0,
            attachments: memory.content.attachments,
            source: memory.content.source,
            worldId,
            id: memory.id,
          };

          // Copy any additional properties from memory.content to preserve index signature
          if (memory.content) {
            Object.keys(memory.content).forEach((key) => {
              if (!contentWithUser[key] && memory.content[key] !== undefined) {
                contentWithUser[key] = memory.content[key];
              }
            });
          }

          return contentWithUser;
        })
        .sort((a: ContentWithUser, b: ContentWithUser) => {
          if (a.createdAt === undefined || b.createdAt === undefined) {
            return 0;
          }
          return a.createdAt - b.createdAt;
        });
    },
    enabled: Boolean(agentId && roomId),
    staleTime: STALE_TIMES.FREQUENT,
  });

  // Function to load older messages
  const loadOlderMessages = async (): Promise<boolean> => {
    if (!oldestMessageTimestamp || !hasMoreMessages || isLoadingMore) return false;

    try {
      setIsLoadingMore(true);

      // Fetch messages older than the oldest one we currently have
      const response = await apiClient.getMemories(agentId, roomId, {
        before: oldestMessageTimestamp,
        limit: 20, // Fetch up to 20 older messages
      });

      if (response?.memories && response.memories.length > 0) {
        // Update the oldest message timestamp
        const timestamps: number[] = response.memories.map(
          (msg: Memory): number => msg.createdAt ?? 0
        );
        const oldest: number = Math.min(...timestamps);
        setOldestMessageTimestamp(oldest);

        // Merge with existing messages
        const existingMessages: ContentWithUser[] =
          queryClient.getQueryData<ContentWithUser[]>(['messages', agentId, roomId, worldId]) || [];

        // Create a Map with message ID as key to filter out any potential duplicates
        const messageMap = new Map<string, ContentWithUser>();

        // Add existing messages to the map
        existingMessages.forEach((msg: ContentWithUser): void => {
          messageMap.set(msg.id as string, msg);
        });

        // Add new messages to the map, overwriting any with the same ID
        response.memories.forEach((memory: Memory): void => {
          // Convert Memory to ContentWithUser
          const contentWithUser: ContentWithUser = {
            text: memory.content.text,
            roomId: memory.roomId,
            user: memory.entityId === agentId ? 'agent' : USER_NAME,
            name: memory.entityId === agentId ? 'agent' : USER_NAME,
            createdAt: memory.createdAt || 0,
            attachments: memory.content.attachments,
            source: memory.content.source,
            worldId,
            id: memory.id,
          };

          // Copy any additional properties from memory.content to preserve index signature
          if (memory.content) {
            Object.keys(memory.content).forEach((key) => {
              if (!contentWithUser[key] && memory.content[key] !== undefined) {
                contentWithUser[key] = memory.content[key];
              }
            });
          }

          messageMap.set(memory.id as string, contentWithUser);
        });

        // Convert back to array and sort
        const mergedMessages: ContentWithUser[] = Array.from(messageMap.values());
        mergedMessages.sort(
          (a: ContentWithUser, b: ContentWithUser): number =>
            (a.createdAt ?? 0) - (b.createdAt ?? 0)
        );

        // Update the cache
        queryClient.setQueryData(['messages', agentId, roomId, worldId], mergedMessages);

        // Update hasMoreMessages based on the number of messages received
        // If we received fewer messages than requested, we've likely reached the end
        setHasMoreMessages(response.memories.length >= 20);

        return true;
      }

      // No more messages to load
      setHasMoreMessages(false);
      return false;
    } catch (error: unknown) {
      console.error('Error loading older messages:', error);
      return false;
    } finally {
      setIsLoadingMore(false);
    }
  };

  return {
    ...messagesQuery,
    loadOlderMessages,
    hasOlderMessages: hasMoreMessages,
    isLoadingMore,
  };
}

export function useGroupMessages(
  serverId: UUID,
  groupChatSource: string
): {
  data: ContentWithUser[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} {
  const worldId = WorldManager.getWorldId();

  // Initial fetch of messages
  const messagesQuery = useQuery({
    queryKey: ['groupmessages', serverId, worldId],
    queryFn: async () => {
      const result = await apiClient.getGroupMemories(serverId);
      const validSuffixes = [`:${USER_NAME}`, ':agent'];
      let memories = result.data
        .map((memory: Memory): ContentWithUser | null => {
          const source = memory.content?.source ?? '';
          if (
            !source.startsWith(groupChatSource) ||
            !validSuffixes.some((suffix) => source.endsWith(suffix))
          ) {
            return null;
          }
          const isUser = source.endsWith(validSuffixes[0]);

          return {
            text: memory.content.text,
            roomId: memory.roomId,
            actions: memory.content.actions,
            name: isUser ? USER_NAME : 'agent',
            agentId: memory.agentId,
            entityId: memory.entityId,
            createdAt: memory.createdAt || 0,
            attachments: memory.content.attachments,
            source: memory.content.source,
            worldId,
            id: memory.id,
            thought: memory.content.thought,
          };
        })
        .filter(Boolean); // Remove null values from the array

      // Sort messages by createdAt timestamp
      memories.sort((a: Memory, b: Memory) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

      return memories;
    },
    enabled: Boolean(serverId && groupChatSource),
    staleTime: STALE_TIMES.FREQUENT,
  });

  return {
    ...messagesQuery,
  };
}

// Hook for fetching agent actions
/**
 * Custom hook to fetch agent actions for a specific agent and room.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room.
 * @returns {QueryResult} The result of the query containing agent actions.
 */
export function useAgentActions(agentId: UUID, roomId?: UUID) {
  return useQuery({
    queryKey: ['agentActions', agentId, roomId],
    queryFn: async () => {
      const response = await apiClient.getAgentLogs(agentId, {
        roomId,
        count: 50,
      });
      return response.data || [];
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
    mutationFn: ({ agentId, logId }: { agentId: string; logId: string }) =>
      apiClient.deleteLog(agentId, logId),

    onMutate: async ({ agentId, logId }) => {
      // Optimistically update the UI by removing the log from the cache
      const previousLogs = queryClient.getQueryData(['agentActions', agentId]);

      // Update cache if we have the data
      if (previousLogs) {
        queryClient.setQueryData(['agentActions', agentId], (oldData: any) =>
          oldData.filter((log: any) => log.id !== logId)
        );
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
 * Fetches memories for a specific agent, optionally filtered by room
 */
export function useAgentMemories(agentId: UUID, tableName?: string, roomId?: UUID) {
  const queryKey = roomId
    ? ['agents', agentId, 'rooms', roomId, 'memories', tableName]
    : ['agents', agentId, 'memories', tableName];

  return useQuery({
    queryKey,
    queryFn: async () => {
      const result = await apiClient.getAgentMemories(agentId, roomId, tableName);
      return result.data || [];
    },
    staleTime: 1000,
    refetchInterval: 10 * 1000,
  });
}

/**
 * Deletes a specific memory entry for an agent
 */
export function useDeleteMemory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, memoryId }: { agentId: UUID; memoryId: string }) => {
      await apiClient.deleteAgentMemory(agentId, memoryId);
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

export function useDeleteAllMemories() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, roomId }: { agentId: UUID; roomId: UUID }) => {
      await apiClient.deleteAllAgentMemories(agentId, roomId);
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
 * Hook to update a specific memory entry for an agent
 * @returns {UseMutationResult} - Object containing the mutation function and its handlers.
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
      memoryId: string;
      memoryData: Partial<Memory>;
    }) => {
      const result = await apiClient.updateAgentMemory(agentId, memoryId, memoryData);
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

export function useRooms(options = {}) {
  const network = useNetworkStatus();

  return useQuery<Map<string, Room[]>>({
    queryKey: ['rooms'],
    queryFn: async () => {
      const rooms = await apiClient.getRooms();
      const worldRooms = rooms.data.filter(
        (room: Room) =>
          room.worldId === WorldManager.getWorldId() && room.source === GROUP_CHAT_SOURCE
      );

      const roomMap: Map<string, Room[]> = new Map();
      for (const room of worldRooms) {
        const { serverId, ...rest } = room;
        if (serverId) {
          roomMap.set(serverId, [...(roomMap.get(serverId) || []), { serverId, ...rest }]);
        }
      }

      return roomMap;
    },
    staleTime: STALE_TIMES.FREQUENT,
    refetchInterval: !network.isOffline ? STALE_TIMES.FREQUENT : false,
    refetchIntervalInBackground: false,
    ...options,
  });
}

// Hook for fetching agent panels (public GET routes)
/**
 * Custom hook to fetch public GET routes (panels) for a specific agent.
 * @param {UUID | undefined | null} agentId - The ID of the agent.
 * @param {object} options - Optional TanStack Query options.
 * @returns {QueryResult} The result of the query containing agent panels.
 */
export type AgentPanel = {
  name: string;
  path: string;
};

export function useAgentPanels(agentId: UUID | undefined | null, options = {}) {
  console.log('useAgentPanels', agentId);
  const network = useNetworkStatus();

  return useQuery<{
    success: boolean;
    data: AgentPanel[];
    error?: { code: string; message: string; details?: string };
  }>({
    queryKey: ['agentPanels', agentId],
    queryFn: () => apiClient.getAgentPanels(agentId || ''),
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
