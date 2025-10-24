import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
    useAgents,
    useAgent,
    useStartAgent,
    useStopAgent,
    useDeleteLog,
    useAgentsWithDetails,
    useAgentPanels,
    useAgentActions,
} from './agents';
import { createMockElizaClient, createTestQueryClient, createWrapper } from '../__tests__/test-utils';

describe('agent hooks', () => {
    const agentList = [{ id: 'agent-1', name: 'Agent One' }];
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        client = createMockElizaClient({
            agents: {
                listAgents: mock(async () => ({ agents: agentList })),
                getAgent: mock(async (id: string) => ({ id, name: `Agent ${id}` })),
                startAgent: mock(async () => ({ status: 'started' })),
                stopAgent: mock(async () => ({ status: 'stopped' })),
                deleteAgentLog: mock(async () => ({ success: true })),
                getAgentLogs: mock(async () => [{ id: 'log-1' }]),
                getAgentPanels: mock(async () => ({ panels: [{ id: 'panel-1', name: 'Panel', url: '/panel', type: 'plugin' }] })),
            },
        });
    });

    it('returns agents list data', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgents(), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.listAgents).toHaveBeenCalledTimes(1);
        expect(result.current.data).toEqual(agentList);
    });

    it('fetches individual agent when id provided', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgent('agent-42'), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgent).toHaveBeenCalledWith('agent-42');
        expect(result.current.data).toEqual({ id: 'agent-42', name: 'Agent agent-42' });
    });

    it('does not fetch agent when id is missing', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgent(null), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgent).not.toHaveBeenCalled();
        expect(result.current.data).toBeUndefined();
    });

    it('starts agent and invalidates cached queries', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useStartAgent(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync('agent-1');
        });

        expect(client.agents.startAgent).toHaveBeenCalledWith('agent-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agent', 'agent-1'] });
    });

    it('stops agent and invalidates cached queries', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useStopAgent(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync('agent-1');
        });

        expect(client.agents.stopAgent).toHaveBeenCalledWith('agent-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agent', 'agent-1'] });
    });

    it('optimistically removes agent log and restores on error', async () => {
        const erroringClient = createMockElizaClient({
            agents: {
                listAgents: client.agents.listAgents,
                getAgent: client.agents.getAgent,
                startAgent: client.agents.startAgent,
                stopAgent: client.agents.stopAgent,
                getAgentLogs: client.agents.getAgentLogs,
                deleteAgentLog: mock(async () => {
                    throw new Error('failed');
                }),
                getAgentPanels: client.agents.getAgentPanels,
            },
        });
        const queryClient = createTestQueryClient();
        queryClient.setQueryData(['agentActions', 'agent-1'], [{ id: 'log-1' }]);
        const wrapper = createWrapper({ client: erroringClient, queryClient });
        const { result } = renderHook(() => useDeleteLog(), { wrapper });

        await act(async () => {
            await expect(result.current.mutateAsync({ agentId: 'agent-1', logId: 'log-1' })).rejects.toThrow('failed');
        });

        const restored = queryClient.getQueryData(['agentActions', 'agent-1']);
        expect(restored).toEqual([{ id: 'log-1' }]);
    });

    it('aggregates detailed agent info', async () => {
        const detailedClient = createMockElizaClient({
            agents: {
                listAgents: mock(async () => ({ agents: agentList })),
                getAgent: mock(async (id: string) => ({ id, name: 'Detailed Agent' })),
            },
        });
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client: detailedClient, queryClient });
        const { result } = renderHook(() => useAgentsWithDetails(), { wrapper });

        await waitFor(() => {
            expect(result.current.data).toEqual([{ id: 'agent-1', name: 'Detailed Agent' }]);
            expect(result.current.isLoading).toBe(false);
        });
    });

    it('fetches agent panels', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentPanels('agent-1'), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgentPanels).toHaveBeenCalledWith('agent-1');
        expect(result.current.data).toEqual([{ id: 'panel-1', name: 'Panel', url: '/panel', type: 'plugin' }]);
    });

    it('polls agent actions and returns data', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentActions('agent-1'), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgentLogs).toHaveBeenCalledWith('agent-1', { limit: 50 });
        expect(result.current.data).toEqual([{ id: 'log-1' }]);
    });
});



