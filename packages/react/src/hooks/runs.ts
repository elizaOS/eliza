import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type { UUID } from '@elizaos/core';
import type { RunSummary, RunDetail, ListRunsParams } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';
import { useNetworkStatus } from '../internal/useNetworkStatus';
import { STALE_TIMES } from '../internal/constants';

interface RunsListResponse {
    runs: RunSummary[];
    total: number;
    hasMore: boolean;
}

/**
 * Hook for fetching agent runs with optional filtering.
 * 
 * @param agentId - The UUID of the agent
 * @param params - Optional parameters for filtering runs (roomId, status, limit, from, to)
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing runs list
 */
export function useAgentRuns(
    agentId: UUID | undefined | null,
    params?: ListRunsParams,
    options: Partial<UseQueryOptions<RunsListResponse, Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    const sanitizedParams = params
        ? Object.fromEntries(Object.entries(params).filter(([_, value]) => value !== undefined))
        : undefined;
    const serializedParams = sanitizedParams ? JSON.stringify(sanitizedParams) : 'default';

    return useQuery<RunsListResponse, Error>({
        queryKey: ['agent', agentId, 'runs', serializedParams],
        queryFn: async () => {
            if (!agentId) throw new Error('Agent ID is required');
            return await client.runs.listRuns(agentId, sanitizedParams as ListRunsParams | undefined);
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

/**
 * Hook for fetching detailed information about a specific run.
 * 
 * @param agentId - The UUID of the agent
 * @param runId - The UUID of the run
 * @param roomId - Optional room ID for filtering
 * @param options - Optional TanStack Query configuration options
 * @returns Query result containing run details
 */
export function useAgentRunDetail(
    agentId: UUID | undefined | null,
    runId: UUID | undefined | null,
    roomId?: UUID | null,
    options: Partial<UseQueryOptions<RunDetail, Error>> = {}
) {
    const client = useElizaClient();
    const network = useNetworkStatus();

    return useQuery<RunDetail, Error>({
        queryKey: ['agent', agentId, 'runs', 'detail', runId, roomId ?? null],
        queryFn: async () => {
            if (!agentId || !runId) throw new Error('Agent ID and Run ID are required');
            return await client.runs.getRun(agentId, runId, roomId ?? undefined);
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

