import { useQuery, useMutation, useQueryClient, type UseQueryOptions, type UseMutationOptions } from '@tanstack/react-query';
import type { UUID, Memory as CoreMemory } from '@elizaos/core';
import type { AgentLog } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';
import { STALE_TIMES } from '../internal/constants';

/**
 * Hook for fetching agent internal actions/logs (agent-perspective data).
 * 
 * @param agentId - The UUID of the agent
 * @param agentPerspectiveRoomId - Optional agent-perspective room ID
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing agent internal logs
 */
export function useAgentInternalActions(
    agentId: UUID | null,
    agentPerspectiveRoomId?: UUID | null,
    options: Partial<UseQueryOptions<AgentLog[], Error>> = {}
) {
    const client = useElizaClient();

    return useQuery<AgentLog[], Error>({
        queryKey: ['agentInternalActions', agentId, agentPerspectiveRoomId],
        queryFn: async () => {
            if (!agentId) return [];
            const response = await client.agents.getAgentLogs(agentId, {
                limit: 50,
            });
            return response || [];
        },
        enabled: Boolean(agentId),
        staleTime: STALE_TIMES.FREQUENT,
        refetchInterval: 5000,
        ...options,
    });
}

/**
 * Hook to delete an agent internal log entry.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteAgentInternalLog(
    options: Partial<UseMutationOptions<void, Error, { agentId: UUID; logId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; logId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ agentId, logId }) => {
            await client.agents.deleteAgentLog(agentId, logId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['agentInternalActions', variables.agentId] });
            queryClient.invalidateQueries({
                queryKey: ['agentInternalActions', variables.agentId, undefined],
                exact: false,
            });
            (onSuccess as any)?.(data, variables, context);
        },
    });
}

/**
 * Hook for fetching agent internal memories (agent-perspective data).
 * 
 * @param agentId - The UUID of the agent
 * @param agentPerspectiveRoomId - Agent-perspective room ID
 * @param tableName - Table name for filtering (default: 'messages')
 * @param includeEmbedding - Whether to include embeddings
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing agent internal memories
 */
export function useAgentInternalMemories(
    agentId: UUID | null,
    agentPerspectiveRoomId: UUID | null,
    tableName: string = 'messages',
    includeEmbedding = false,
    options: Partial<UseQueryOptions<CoreMemory[], Error>> = {}
) {
    const client = useElizaClient();

    return useQuery<CoreMemory[], Error>({
        queryKey: [
            'agentInternalMemories',
            agentId,
            agentPerspectiveRoomId,
            tableName,
            includeEmbedding,
        ],
        queryFn: async () => {
            if (!agentId || !agentPerspectiveRoomId) return [];
            const response = await client.memory.getAgentInternalMemories(
                agentId,
                agentPerspectiveRoomId,
                includeEmbedding
            );
            return response.data || [];
        },
        enabled: Boolean(agentId && agentPerspectiveRoomId),
        staleTime: STALE_TIMES.STANDARD,
        ...options,
    });
}

/**
 * Hook to delete an agent internal memory entry.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteAgentInternalMemory(
    options: Partial<UseMutationOptions<void, Error, { agentId: UUID; memoryId: UUID }, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; memoryId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ agentId, memoryId }) => {
            await client.memory.deleteAgentInternalMemory(agentId, memoryId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['agentInternalMemories', variables.agentId] });
            (onSuccess as any)?.(data, variables, context);
        },
    });
}

/**
 * Hook to delete all agent internal memories for a specific room.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteAllAgentInternalMemories(
    options: Partial<
        UseMutationOptions<void, Error, { agentId: UUID; agentPerspectiveRoomId: UUID }, unknown>
    > = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; agentPerspectiveRoomId: UUID }, unknown>({
        ...options,
        mutationFn: async ({ agentId, agentPerspectiveRoomId }) => {
            await client.memory.deleteAllAgentInternalMemories(agentId, agentPerspectiveRoomId);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({
                queryKey: ['agentInternalMemories', variables.agentId, variables.agentPerspectiveRoomId],
            });
            (onSuccess as any)?.(data, variables, context);
        },
    });
}

/**
 * Hook to update an agent internal memory entry.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useUpdateAgentInternalMemory(
    options: Partial<
        UseMutationOptions<
            { success: boolean; data: { id: UUID; message: string } },
            Error,
            { agentId: UUID; memoryId: UUID; memoryData: Partial<CoreMemory> },
            unknown
        >
    > = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<
        { success: boolean; data: { id: UUID; message: string } },
        Error,
        { agentId: UUID; memoryId: UUID; memoryData: Partial<CoreMemory> },
        unknown
    >({
        ...options,
        mutationFn: async ({ agentId, memoryId, memoryData }) => {
            return await client.memory.updateAgentInternalMemory(agentId, memoryId, memoryData);
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['agentInternalMemories', variables.agentId] });
            (onSuccess as any)?.(data, variables, context);
        },
    });
}

