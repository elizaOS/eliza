import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
    useServers,
    useChannels,
    useChannelDetails,
    useChannelParticipants,
    useDeleteChannel,
} from './messaging';
import { createMockElizaClient, createTestQueryClient, createWrapper } from '../__tests__/test-utils';

describe('messaging hooks', () => {
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        client = createMockElizaClient({
            messaging: {
                listServers: mock(async () => ({ servers: [{ id: 'server-1', name: 'Server' }] })),
                getServerChannels: mock(async () => ({ channels: [{ id: 'channel-1', name: 'Channel' }] })),
                getChannelDetails: mock(async () => ({ id: 'channel-1', name: 'Channel' })),
                getChannelParticipants: mock(async () => ({ participants: [{ userId: 'user-1' }] })),
                deleteChannel: mock(async () => ({ success: true })),
            },
        });
    });

    it('fetches servers', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useServers(), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.messaging.listServers).toHaveBeenCalledTimes(1);
        expect(result.current.data).toEqual([{ id: 'server-1', name: 'Server' }]);
    });

    it('fetches channels when server id provided', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useChannels('server-1'), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.messaging.getServerChannels).toHaveBeenCalledWith('server-1');
        expect(result.current.data).toEqual([{ id: 'channel-1', name: 'Channel' }]);
    });

    it('skips channels query without server id', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useChannels(undefined), { wrapper });

        await act(async () => {
            await result.current.refetch();
        });

        expect(client.messaging.getServerChannels).not.toHaveBeenCalled();
        expect(result.current.data).toEqual([]);
    });

    it('fetches channel details and participants', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const details = renderHook(() => useChannelDetails('channel-1'), { wrapper });
        const participants = renderHook(() => useChannelParticipants('channel-1'), { wrapper });

        await act(async () => {
            await details.result.current.refetch();
            await participants.result.current.refetch();
        });

        expect(client.messaging.getChannelDetails).toHaveBeenCalledWith('channel-1');
        expect(client.messaging.getChannelParticipants).toHaveBeenCalledWith('channel-1');
        expect(details.result.current.data).toEqual({ id: 'channel-1', name: 'Channel' });
        expect(participants.result.current.data).toEqual(['user-1']);
    });

    it('deletes channel and invalidates caches', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        (queryClient as unknown as { invalidateQueries: typeof invalidateSpy }).invalidateQueries = invalidateSpy;
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useDeleteChannel(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ channelId: 'channel-1', serverId: 'server-1' });
        });

        expect(client.messaging.deleteChannel).toHaveBeenCalledWith('channel-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channels', 'server-1'] });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channels'] });
    });
});



