import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
    useAgentInternalActions,
    useDeleteAgentInternalLog,
    useAgentInternalMemories,
    useDeleteAgentInternalMemory,
    useDeleteAllAgentInternalMemories,
    useUpdateAgentInternalMemory,
} from './internal';
import { createTestQueryClient, createWrapper, createMockElizaClient } from '../__tests__/test-utils';

describe('internal hooks', () => {
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        client = createMockElizaClient();
    });

    it('fetches agent internal actions when enabled', async () => {
        (client.agents.getAgentLogs as any).mockResolvedValueOnce([{ id: 'log-1' }]);
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentInternalActions('agent-1'), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgentLogs).toHaveBeenCalledWith('agent-1', { limit: 50 });
        expect(result.current.data).toEqual([{ id: 'log-1' }]);
    });

    it('skips fetching when agentId is null', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentInternalActions(null), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.agents.getAgentLogs).not.toHaveBeenCalled();
        expect(result.current.data).toEqual([]);
    });

    it('invalidates queries after deleting internal log', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteAgentInternalLog(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ agentId: 'agent-1', logId: 'log-1' });
        });

        expect(client.agents.deleteAgentLog).toHaveBeenCalledWith('agent-1', 'log-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agentInternalActions', 'agent-1'] });
    });

    it('fetches internal memories with required parameters', async () => {
        (client.memory.getAgentInternalMemories as any).mockResolvedValueOnce({ data: [{ id: 'mem-1' }] });
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentInternalMemories('agent-1', 'room-1'), { wrapper });
        await act(async () => {
            await result.current.refetch();
        });
        expect(client.memory.getAgentInternalMemories).toHaveBeenCalledWith('agent-1', 'room-1', false);
        expect(result.current.data).toEqual([{ id: 'mem-1' }]);
    });

    it('invalidates caches after deleting a single internal memory', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteAgentInternalMemory(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ agentId: 'agent-1', memoryId: 'mem-1' });
        });

        expect(client.memory.deleteAgentInternalMemory).toHaveBeenCalledWith('agent-1', 'mem-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agentInternalMemories', 'agent-1'] });
    });

    it('invalidates room scoped caches after deleting all internal memories', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteAllAgentInternalMemories(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ agentId: 'agent-1', agentPerspectiveRoomId: 'room-1' });
        });

        expect(client.memory.deleteAllAgentInternalMemories).toHaveBeenCalledWith('agent-1', 'room-1');
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: ['agentInternalMemories', 'agent-1', 'room-1'],
        });
    });

    it('invalidates caches after updating internal memory', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useUpdateAgentInternalMemory(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({
                agentId: 'agent-1',
                memoryId: 'mem-1',
                memoryData: { message: 'updated' },
            });
        });

        expect(client.memory.updateAgentInternalMemory).toHaveBeenCalledWith('agent-1', 'mem-1', {
            message: 'updated',
        });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agentInternalMemories', 'agent-1'] });
    });
});

