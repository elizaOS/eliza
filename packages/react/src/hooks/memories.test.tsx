import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
    useAgentMemories,
    useDeleteMemory,
    useDeleteAllMemories,
    useUpdateMemory,
    useDeleteGroupMemory,
    useClearGroupChat,
} from './memories';
import { createMockElizaClient, createTestQueryClient, createWrapper } from '../__tests__/test-utils';

describe('memory hooks', () => {
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        client = createMockElizaClient({
            memory: {
                getAgentMemories: mock(async () => ({ memories: [{ id: 'mem-1', roomId: 'room-1' }] })),
                getRoomMemories: mock(async () => ({ memories: [{ id: 'mem-1', roomId: 'room-1' }] })),
                deleteMemory: mock(async () => ({ success: true })),
                clearRoomMemories: mock(async () => ({ success: true })),
                updateMemory: mock(async () => ({ id: 'mem-1', roomId: 'room-1' })),
            },
            messaging: {
                deleteMessage: mock(async () => ({ success: true })),
                clearChannelHistory: mock(async () => ({ deleted: 1 })),
            },
        });
    });

    it('fetches agent memories by agent only', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useAgentMemories('agent-1', 'messages'), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.memory.getAgentMemories).toHaveBeenCalledWith('agent-1', {
            tableName: 'messages',
            includeEmbedding: false,
        });
        expect(result.current.data).toEqual([{ id: 'mem-1', roomId: 'room-1' }]);
    });

    it('fetches agent memories scoped to room', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(
            () => useAgentMemories('agent-1', 'messages', 'room-1', true),
            { wrapper }
        );

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.memory.getRoomMemories).toHaveBeenCalledWith('agent-1', 'room-1', {
            tableName: 'messages',
            includeEmbedding: true,
        });
    });

    it('deletes memory and invalidates queries', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteMemory(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ agentId: 'agent-1', memoryId: 'mem-1' });
        });

        expect(client.memory.deleteMemory).toHaveBeenCalledWith('agent-1', 'mem-1');
        expect(
            invalidateSpy.mock.calls.some((call) => Array.isArray(call[0]?.queryKey) && call[0]?.queryKey[0] === 'agents')
        ).toBe(true);
    });

    it('clears memories for a room and invalidates', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteAllMemories(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ agentId: 'agent-1', roomId: 'room-1' });
        });

        expect(client.memory.clearRoomMemories).toHaveBeenCalledWith('agent-1', 'room-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents', 'agent-1', 'memories'] });
    });

    it('updates memory and invalidates relevant caches', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useUpdateMemory(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({
                agentId: 'agent-1',
                memoryId: 'mem-1',
                memoryData: { message: 'updated' },
            });
        });

        expect(client.memory.updateMemory).toHaveBeenCalledWith('agent-1', 'mem-1', { message: 'updated' });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents', 'agent-1', 'memories'] });
    });

    it('deletes group memory using messaging endpoint', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteGroupMemory(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ serverId: 'server-1', memoryId: 'mem-1' });
        });

        expect(client.messaging.deleteMessage).toHaveBeenCalledWith('server-1', 'mem-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['groupmessages', 'server-1'] });
    });

    it('clears group chat history', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useClearGroupChat(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync('server-1');
        });

        expect(client.messaging.clearChannelHistory).toHaveBeenCalledWith('server-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['groupmessages', 'server-1'] });
    });
});



