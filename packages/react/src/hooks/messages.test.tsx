import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import {
    useChannelMessages,
    useDeleteChannelMessage,
    useClearChannelMessages,
} from './messages';
import { createMockElizaClient, createTestQueryClient, createWrapper } from '../__tests__/test-utils';
import type { Message } from '@elizaos/api-client';

describe('channel message hooks', () => {
    let client: ReturnType<typeof createMockElizaClient>;

    beforeEach(() => {
        const now = new Date().toISOString();
        client = createMockElizaClient({
            messaging: {
                getChannelMessages: mock(async () => ({
                    messages: [
                        { id: 'msg-1', createdAt: now } as unknown as Message,
                        { id: 'msg-2', createdAt: now } as unknown as Message,
                    ],
                })),
                deleteMessage: mock(async () => ({ success: true })),
                clearChannelHistory: mock(async () => ({ deleted: 2 })),
            },
        });
    });

    it('loads messages and supports pagination', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useChannelMessages('channel-1'), { wrapper });

        await act(async () => {
            await result.current.fetchNextPage();
        });

        expect(client.messaging.getChannelMessages).toHaveBeenCalled();
        expect(result.current.data?.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
        expect(result.current.isLoading).toBe(false);
    });

    it('returns empty state when channel omitted', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useChannelMessages(undefined), { wrapper });

        expect(result.current.data).toEqual([]);
        expect(result.current.isLoading).toBe(false);
    });

    it('deletes a channel message via mutation', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const deleteHook = renderHook(() => useDeleteChannelMessage(), { wrapper });

        await act(async () => {
            await deleteHook.result.current.mutateAsync({ channelId: 'channel-1', messageId: 'msg-1' });
        });

        expect(client.messaging.deleteMessage).toHaveBeenCalledWith('channel-1', 'msg-1');
    });

    it('clears channel messages and invalidates cache', async () => {
        const queryClient = createTestQueryClient();
        const invalidateSpy = mock(queryClient.invalidateQueries.bind(queryClient));
        const setQueryDataSpy = mock(queryClient.setQueryData.bind(queryClient));
        (queryClient as unknown as {
            invalidateQueries: typeof invalidateSpy;
            setQueryData: typeof setQueryDataSpy;
        }).invalidateQueries = invalidateSpy;
        (queryClient as unknown as {
            invalidateQueries: typeof invalidateSpy;
            setQueryData: typeof setQueryDataSpy;
        }).setQueryData = setQueryDataSpy;

        const wrapper = createWrapper({ client, queryClient });
        const clearHook = renderHook(() => useClearChannelMessages(), { wrapper });

        await act(async () => {
            await clearHook.result.current.mutateAsync('channel-1');
        });

        expect(client.messaging.clearChannelHistory).toHaveBeenCalledWith('channel-1');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['messages', 'channel-1'] });
        expect(setQueryDataSpy).toHaveBeenCalledWith(['messages', 'channel-1'], expect.any(Function));
    });

    it('local add/update/remove helpers manipulate state', async () => {
        const queryClient = createTestQueryClient();
        const wrapper = createWrapper({ client, queryClient });
        const { result } = renderHook(() => useChannelMessages('channel-1'), { wrapper });

        const baseMessage = {
            id: 'msg-local',
            createdAt: new Date().toISOString(),
        } as unknown as Message;

        act(() => {
            result.current.addMessage(baseMessage);
        });
        expect(result.current.data?.some((m) => m.id === 'msg-local')).toBe(true);

        act(() => {
            result.current.updateMessage('msg-local', { content: 'hello' } as Partial<Message>);
        });
        expect(result.current.data?.find((m) => m.id === 'msg-local')?.content).toBe('hello');

        act(() => {
            result.current.removeMessage('msg-local');
        });
        expect(result.current.data?.some((m) => m.id === 'msg-local')).toBe(false);
    });
});



