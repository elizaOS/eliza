import {
    useQuery,
    useMutation,
    useQueries,
    useQueryClient,
    type UseQueryOptions,
    type UseQueryResult,
    type UseMutationOptions,
} from '@tanstack/react-query';
import type { UUID } from '@elizaos/core';
import type { Agent, AgentLog, AgentPanel } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';
import { useNetworkStatus } from '../internal/useNetworkStatus';
import { STALE_TIMES } from '../internal/constants';

/**
 * Hook for fetching agents with smart polling based on network conditions.
 * 
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing list of agents
 */
export function useAgents(options: Partial<UseQueryOptions<Agent[], Error>> = {}) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<Agent[], Error>({
        queryKey: ['agents'],
        queryFn: async () => {
            const result = await client.agents.listAgents();
            // The API client unwraps the response, so result should be { agents: Agent[] }
            return result.agents || [];
        },
        staleTime: STALE_TIMES.FREQUENT,
        refetchInterval: !network.isOffline ? STALE_TIMES.FREQUENT : false,
        refetchIntervalInBackground: false,
        ...(!network.isOffline &&
            network.effectiveType === 'slow-2g' && {
            refetchInterval: STALE_TIMES.STANDARD,
        }),
        ...options,
    });
}

/**
 * Hook for fetching a specific agent by ID with smart polling.
 * 
 * @param agentId - The UUID of the agent to fetch
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing the agent data
 */
export function useAgent(
    agentId: UUID | undefined | null,
    options: Partial<UseQueryOptions<Agent, Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<Agent, Error>({
        queryKey: ['agent', agentId],
        queryFn: async () => {
            if (!agentId) throw new Error('Agent ID is required');
            return await client.agents.getAgent(agentId);
        },
        staleTime: STALE_TIMES.FREQUENT,
        enabled: Boolean(agentId),
        refetchInterval: !network.isOffline && Boolean(agentId) ? STALE_TIMES.FREQUENT : false,
        refetchIntervalInBackground: false,
        ...(!network.isOffline &&
            network.effectiveType === 'slow-2g' && {
            refetchInterval: STALE_TIMES.STANDARD,
        }),
        ...options,
    });
}

/**
 * Hook for starting an agent.
 * Returns a mutation that can be called with an agent ID.
 * Does not handle UI concerns like toasts - use onSuccess/onError callbacks.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useStartAgent(
    options: Partial<UseMutationOptions<{ status: string }, Error, UUID, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<{ status: string }, Error, UUID, unknown>({
        ...options,
        mutationFn: async (agentId: UUID) => {
            return await client.agents.startAgent(agentId);
        },
        onSuccess: (data, agentId, context) => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            (onSuccess as any)?.(data, agentId, context);
        },
    });
}

/**
 * Hook for stopping an agent.
 * Returns a mutation that can be called with an agent ID.
 * Does not handle UI concerns like toasts - use onSuccess/onError callbacks.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useStopAgent(
    options: Partial<UseMutationOptions<{ status: string }, Error, UUID, unknown>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, ...restOptions } = options;

    return useMutation<{ status: string }, Error, UUID, unknown>({
        ...options,
        mutationFn: async (agentId: UUID) => {
            return await client.agents.stopAgent(agentId);
        },
        onSuccess: (data, agentId, context) => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            (onSuccess as any)?.(data, agentId, context);
        },
    });
}

/**
 * Hook for fetching agent actions/logs.
 * 
 * @param agentId - The UUID of the agent
 * @param roomId - Optional room ID to filter logs
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing agent logs
 */
export function useAgentActions(
    agentId: UUID | null,
    roomId?: UUID,
    options: Partial<UseQueryOptions<AgentLog[], Error>> = {}
) {
    const client = useElizaClient();

    return useQuery<AgentLog[], Error>({
        queryKey: ['agentActions', agentId, roomId],
        queryFn: async () => {
            if (!agentId) return [];
            const response = await client.agents.getAgentLogs(agentId, {
                limit: 50,
            });
            return response || [];
        },
        enabled: Boolean(agentId),
        refetchInterval: 1000,
        staleTime: 1000,
        ...options,
    });
}

/**
 * Hook to delete an agent log/action.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteLog(
    options: Partial<UseMutationOptions<void, Error, { agentId: UUID; logId: UUID }, { previousLogs: unknown; agentId: UUID; logId: UUID }>> = {}
) {
    const client = useElizaClient();
    const queryClient = useQueryClient();
    const { onSuccess, onError, onMutate, ...restOptions } = options;

    return useMutation<void, Error, { agentId: UUID; logId: UUID }, { previousLogs: unknown; agentId: UUID; logId: UUID }>({
        ...options,
        mutationFn: async ({ agentId, logId }) => {
            await client.agents.deleteAgentLog(agentId, logId);
        },
        onMutate: async (variables) => {
            const customContext = await await (onMutate as any)?.(variables);
            const previousLogs = queryClient.getQueryData(['agentActions', variables.agentId]);

            if (previousLogs) {
                queryClient.setQueryData(['agentActions', variables.agentId], (oldData: AgentLog[] | undefined) =>
                    oldData?.filter((log) => log.id !== variables.logId)
                );
            }

            return { ...customContext, previousLogs, agentId: variables.agentId, logId: variables.logId };
        },
        onSuccess: (data, variables, context) => {
            queryClient.invalidateQueries({ queryKey: ['agentActions', variables.agentId] });
            (onSuccess as any)?.(data, variables, context);
        },
        onError: (error, variables, context) => {
            if (context?.previousLogs) {
                queryClient.setQueryData(['agentActions', variables.agentId], context.previousLogs);
            }
            queryClient.invalidateQueries({ queryKey: ['agentActions', variables.agentId] });
            (onError as any)?.(error, variables, context);
        },
    });
}

/**
 * Hook for fetching agent panels (public GET routes).
 * 
 * @param agentId - The UUID of the agent
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing agent panels
 */
export function useAgentPanels(
    agentId: UUID | undefined | null,
    options: Partial<UseQueryOptions<AgentPanel[], Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<AgentPanel[], Error>({
        queryKey: ['agentPanels', agentId],
        queryFn: async () => {
            if (!agentId) throw new Error('Agent ID required');
            const result = await client.agents.getAgentPanels(agentId);
            return result.panels;
        },
        enabled: Boolean(agentId),
        staleTime: STALE_TIMES.STANDARD,
        refetchInterval: !network.isOffline && Boolean(agentId) ? STALE_TIMES.RARE : false,
        refetchIntervalInBackground: false,
        ...(!network.isOffline &&
            network.effectiveType === 'slow-2g' && {
            refetchInterval: STALE_TIMES.NEVER,
        }),
        ...options,
    });
}

/**
 * Hook that fetches a list of agents with detailed information for each agent in parallel.
 * Combines the agent list with individual agent detail queries using useQueries.
 * 
 * @returns Object containing detailed agent data, loading and error states
 */
export function useAgentsWithDetails() {
    const client = useElizaClient();
    const network = useNetworkStatus();
    const { data: agents, isLoading: isAgentsLoading } = useAgents();
    const agentIds = agents?.map((agent) => agent.id) || [];

    const agentQueries = useQueries<UseQueryResult<Agent, Error>[]>({
        queries: agentIds.map((id) => ({
            queryKey: ['agent', id] as const,
            queryFn: async () => {
                return await client.agents.getAgent(id);
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

    const isLoading = isAgentsLoading || agentQueries.some((query) => query.isLoading);
    const isError = agentQueries.some((query) => query.isError);
    const error = agentQueries.find((query) => query.error)?.error;

    const detailedAgents = agentQueries
        .filter((query): query is UseQueryResult<Agent, Error> & { data: Agent } =>
            Boolean(query.data)
        )
        .map((query) => query.data);

    return {
        data: detailedAgents,
        isLoading,
        isError,
        error,
    };
}

