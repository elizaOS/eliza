import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueryClientConfig } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { ElizaReactProvider } from '../provider/ElizaReactProvider';
import type { ElizaClient } from '@elizaos/api-client';
import { mock } from 'bun:test';

export function createTestQueryClient(config?: QueryClientConfig): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
                ...config?.defaultOptions?.queries,
            },
            mutations: {
                retry: false,
                ...config?.defaultOptions?.mutations,
            },
        },
        logger: {
            log: () => { },
            warn: () => { },
            error: () => { },
            ...(config?.logger ?? {}),
        },
    });
}

export function createWrapper({
    client,
    queryClient,
}: {
    client: ElizaClient;
    queryClient: QueryClient;
}) {
    return function Wrapper({ children }: PropsWithChildren): JSX.Element {
        return (
            <QueryClientProvider client={queryClient}>
                <ElizaReactProvider client={client}>{children}</ElizaReactProvider>
            </QueryClientProvider>
        );
    };
}

export function createMockElizaClient(overrides: Partial<ElizaClient> = {}): ElizaClient {
    const client: Partial<ElizaClient> = {
        agents: {
            listAgents: mock(async () => ({ agents: [] })),
            getAgent: mock(async () => ({ id: 'agent-1' })),
            startAgent: mock(async () => ({ status: 'started' })),
            stopAgent: mock(async () => ({ status: 'stopped' })),
            getAgentLogs: mock(async () => []),
            deleteAgentLog: mock(async () => ({ success: true })),
            getAgentPanels: mock(async () => ({ panels: [] })),
        },
        runs: {
            listRuns: mock(async () => ({ runs: [], total: 0, hasMore: false })),
            getRun: mock(async () => ({ id: 'run-1' })),
        },
        messaging: {
            listServers: mock(async () => ({ servers: [] })),
            getServerChannels: mock(async () => ({ channels: [] })),
            getChannelDetails: mock(async () => null),
            getChannelParticipants: mock(async () => ({ participants: [] })),
            deleteChannel: mock(async () => ({ success: true })),
            getChannelMessages: mock(async () => ({ messages: [] })),
            deleteMessage: mock(async () => ({ success: true })),
            clearChannelHistory: mock(async () => ({ deleted: 0 })),
        },
        memory: {
            getAgentMemories: mock(async () => ({ memories: [] })),
            getRoomMemories: mock(async () => ({ memories: [] })),
            deleteMemory: mock(async () => ({ success: true })),
            clearRoomMemories: mock(async () => ({ success: true })),
            updateMemory: mock(async () => ({ id: 'memory-1' })),
            getAgentInternalMemories: mock(async () => ({ data: [] })),
            deleteAgentInternalMemory: mock(async () => ({ success: true })),
            deleteAllAgentInternalMemories: mock(async () => ({ success: true })),
            updateAgentInternalMemory: mock(async () => ({ success: true, data: { id: 'memory-1', message: '' } })),
        },
    } as Partial<ElizaClient>;

    return Object.assign(client, overrides) as ElizaClient;
}

