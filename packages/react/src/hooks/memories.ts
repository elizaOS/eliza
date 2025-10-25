import { useQuery, useMutation, useQueryClient, type UseQueryOptions, type UseMutationOptions } from '@tanstack/react-query';
import type { UUID } from '@elizaos/core';
import type { Memory } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';

/**
 * Hook for fetching memories for a specific agent, optionally filtered by channel/room.
 * 
 * @param agentId - The UUID of the agent
 * @param tableName - Optional table name to filter memories
 * @param channelId - Optional channel/room ID to filter memories
 * @param includeEmbedding - Whether to include embeddings in the response
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing list of memories
 */
export function useAgentMemories(
    agentId: UUID | null,
    tableName?: string,
    channelId?: UUID,
    includeEmbedding = false,
    options: Partial<UseQueryOptions<Memory[], Error>> = {}
) {
    const client = useElizaClient();

    const queryKey = channelId
        ? ['agents', agentId, 'channels', channelId, 'memories', tableName, includeEmbedding]
        : ['agents', agentId, 'memories', tableName, includeEmbedding];

    return useQuery<Memory[], Error>({
        queryKey,
        queryFn: async () => {
            if (!agentId) return [];
            const params: Record<string, unknown> = {
                tableName,
                includeEmbedding,
            };
            const result = channelId
                ? await client.memory.getRoomMemories(agentId, channelId, params)
                : await client.memory.getAgentMemories(agentId, params);

            return result.memories || [];
        },
        enabled: Boolean(agentId && tableName),
        staleTime: 1000,
        refetchInterval: 10 * 1000,
        ...options,
    });
}

/**
 * Hook to delete a specific memory entry for an agent.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteMemory(
    options: Partial<UseMutationOptions<void, Error, { agentId: UUID; memoryId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; memoryId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ agentId, memoryId }) => {
            await client.memory.deleteMemory(agentId, memoryId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({
                queryKey: ['agents', variables.agentId, 'memories'],
            });

            queryClient.invalidateQueries({
                queryKey: ['agents', variables.agentId, 'rooms'],
                predicate: (query) => query.queryKey.length > 3 && query.queryKey[4] === 'memories',
            });

            (onSuccess as any)?.(data, variables, context);
        },
        ...options,
    });
}

/**
 * Hook for deleting all memories associated with a specific agent in a given room.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteAllMemories(
    options: Partial<UseMutationOptions<void, Error, { agentId: UUID; roomId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; roomId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ agentId, roomId }) => {
            await client.memory.clearRoomMemories(agentId, roomId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({
                queryKey: ['agents', variables.agentId, 'memories'],
            });

            (onSuccess as any)?.(data, variables, context);
        },
        ...options,
    });
}

/**
 * Hook to update a specific memory entry for an agent.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useUpdateMemory(
    options: Partial<
        UseMutationOptions<
            Memory,
            Error,
            { agentId: UUID; memoryId: UUID; memoryData: Partial<Memory> },
            unknown
        >
    > = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<
        Memory,
        Error,
        { agentId: UUID; memoryId: UUID; memoryData: Partial<Memory> },
        unknown
    >({
        ...options,
        mutationFn: async ({ agentId, memoryId, memoryData }) => {
            return await client.memory.updateMemory(agentId, memoryId, memoryData);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({
                queryKey: ['agents', variables.agentId, 'memories'],
            });

            if (data.roomId) {
                queryClient.invalidateQueries({
                    queryKey: ['agents', variables.agentId, 'rooms', data.roomId, 'memories'],
                });
            } else {
                queryClient.invalidateQueries({
                    queryKey: ['agents', variables.agentId, 'rooms'],
                    predicate: (query) => query.queryKey.length > 3 && query.queryKey[4] === 'memories',
                });
            }

            if (data.roomId) {
                queryClient.invalidateQueries({
                    queryKey: ['messages', variables.agentId, data.roomId],
                });
            }

            (onSuccess as any)?.(data, variables, context);
        },
        ...options,
    });
}

/**
 * Hook to delete a group memory.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteGroupMemory(
    options: Partial<UseMutationOptions<void, Error, { serverId: UUID; memoryId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { serverId: UUID; memoryId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ serverId, memoryId }) => {
            await client.messaging.deleteMessage(serverId, memoryId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['groupmessages', variables.serverId] });
            (onSuccess as any)?.(data, variables, context);
        },
        ...options,
    });
}

/**
 * Hook to clear all messages in a group chat.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useClearGroupChat(
    options: Partial<UseMutationOptions<void, Error, UUID, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, UUID, unknown>({
        ...options,
        mutationFn: async (serverId: UUID) => {
            await client.messaging.clearChannelHistory(serverId);
        },
        onSuccess: (data, serverId, context) => {
            queryClient.invalidateQueries({ queryKey: ['groupmessages', serverId] });
            (onSuccess as any)?.(data, serverId, context);
        },
        ...options,
    });
}

