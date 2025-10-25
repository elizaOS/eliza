import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueryClientConfig } from '@tanstack/react-query';
import type { PropsWithChildren, ReactElement } from 'react';
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
    });
}

export function createWrapper({
    client,
    queryClient,
}: {
    client: ElizaClient;
    queryClient: QueryClient;
}) {
    return function Wrapper({ children }: PropsWithChildren): ReactElement {
        return (
            <QueryClientProvider client={queryClient}>
                <ElizaReactProvider client={client}>{children}</ElizaReactProvider>
            </QueryClientProvider>
        );
    };
}

export function createMockElizaClient(overrides?: Partial<ElizaClient>): ElizaClient {
    const baseClient = {
        agents: {
            listAgents: mock(async () => ({ agents: [] })),
            getAgent: mock(async () => ({ id: 'agent-1', name: 'Test Agent', status: 'stopped' })),
            createAgent: mock(async () => ({ id: 'agent-1', name: 'Test Agent' })),
            updateAgent: mock(async () => ({ id: 'agent-1', name: 'Updated Agent' })),
            deleteAgent: mock(async () => ({ success: true })),
            startAgent: mock(async () => ({ status: 'started' })),
            stopAgent: mock(async () => ({ status: 'stopped' })),
            getAgentLogs: mock(async () => []),
            deleteAgentLog: mock(async () => ({ success: true })),
            getAgentPanels: mock(async () => ({ panels: [] })),
            getWorlds: mock(async () => ({ worlds: [] })),
            getWorld: mock(async () => ({ id: 'world-1' })),
            getRooms: mock(async () => ({ rooms: [] })),
            getRoom: mock(async () => ({ id: 'room-1' })),
            getRoomParticipants: mock(async () => ({ participants: [] })),
            getActions: mock(async () => ({ actions: [] })),
            deleteAction: mock(async () => ({ success: true })),
        },
        runs: {
            listRuns: mock(async () => ({ runs: [], total: 0, hasMore: false })),
            getRun: mock(async () => ({ id: 'run-1', agentId: 'agent-1', status: 'completed' })),
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
    };

    return { ...baseClient, ...overrides } as unknown as ElizaClient;
}

