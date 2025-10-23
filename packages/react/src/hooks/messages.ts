import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query';
import type { UUID } from '@elizaos/core';
import type { Message } from '@elizaos/api-client';
import { useElizaClient } from '../provider/ElizaReactProvider';

/**
 * Hook for managing channel messages with pagination and stateful updates.
 * Provides methods to add, update, and remove messages from the local state.
 * 
 * @param channelId - The UUID of the channel
 * @param initialServerId - Optional server ID for context
 * @returns Object containing messages data, pagination controls, and state mutators
 */
export function useChannelMessages(
    channelId: UUID | undefined,
    initialServerId?: UUID | undefined
): {
    data: Message[] | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    fetchNextPage: () => Promise<void>;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    addMessage: (newMessage: Message) => void;
    updateMessage: (messageId: UUID, updates: Partial<Message>) => void;
    removeMessage: (messageId: UUID) => void;
    clearMessages: () => void;
} {
    const client = useElizaClient();
    const [messages, setMessages] = useState<Message[]>([]);
    const [oldestMessageTimestamp, setOldestMessageTimestamp] = useState<number | null>(null);
    const [hasMoreMessages, setHasMoreMessages] = useState<boolean>(true);
    const [internalIsLoading, setInternalIsLoading] = useState<boolean>(true);
    const [internalIsError, setInternalIsError] = useState<boolean>(false);
    const [internalError, setInternalError] = useState<unknown>(null);
    const [isFetchingMore, setIsFetchingMore] = useState<boolean>(false);

    const fetchMessages = useCallback(
        async (beforeTimestamp?: number) => {
            if (!channelId) {
                setMessages([]);
                setInternalIsLoading(false);
                return;
            }
            if (!beforeTimestamp) {
                setInternalIsLoading(true);
            } else {
                setIsFetchingMore(true);
            }
            setInternalIsError(false);
            setInternalError(null);

            try {
                const response = await client.messaging.getChannelMessages(channelId, {
                    limit: 30,
                    before: beforeTimestamp ? new Date(beforeTimestamp).toISOString() : undefined,
                });

                const newMessages = response.messages;

                setMessages((prev) => {
                    const combined = beforeTimestamp ? [...newMessages, ...prev] : newMessages;
                    const uniqueMessages = Array.from(
                        new Map(combined.map((item) => [item.id, item])).values()
                    );
                    return uniqueMessages.sort(
                        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                    );
                });

                if (newMessages.length > 0) {
                    const oldestFetched = Math.min(
                        ...newMessages.map((m) => new Date(m.createdAt).getTime())
                    );
                    if (!beforeTimestamp || oldestFetched < (oldestMessageTimestamp || Infinity)) {
                        setOldestMessageTimestamp(oldestFetched);
                    }
                }
                setHasMoreMessages(newMessages.length >= 30);
            } catch (err) {
                setInternalIsError(true);
                setInternalError(err);
                console.error(`Failed to fetch messages for channel ${channelId}:`, err);
            } finally {
                setInternalIsLoading(false);
                setIsFetchingMore(false);
            }
        },
        [channelId, client.messaging, oldestMessageTimestamp]
    );

    useEffect(() => {
        if (channelId) {
            setMessages([]);
            setOldestMessageTimestamp(null);
            setHasMoreMessages(true);
            fetchMessages();
        } else {
            setMessages([]);
            setOldestMessageTimestamp(null);
            setHasMoreMessages(true);
            setInternalIsLoading(false);
        }
    }, [channelId, fetchMessages]);

    const fetchNextPage = async () => {
        if (hasMoreMessages && !isFetchingMore && oldestMessageTimestamp) {
            await fetchMessages(oldestMessageTimestamp - 1);
        }
    };

    const addMessage = useCallback((newMessage: Message) => {
        setMessages((prev) => {
            const existingIndex = prev.findIndex((m) => m.id === newMessage.id);

            if (existingIndex >= 0) {
                const updated = [...prev];
                updated[existingIndex] = newMessage;
                return updated.sort(
                    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                );
            } else {
                return [...prev, newMessage].sort(
                    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                );
            }
        });
    }, []);

    const updateMessage = useCallback((messageId: UUID, updates: Partial<Message>) => {
        setMessages((prev) => {
            return prev.map((m) => {
                if (m.id === messageId) {
                    return { ...m, ...updates };
                }
                return m;
            });
        });
    }, []);

    const removeMessage = useCallback((messageId: UUID) => {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
    }, []);

    const clearMessages = useCallback(() => {
        setMessages([]);
        setOldestMessageTimestamp(null);
        setHasMoreMessages(true);
    }, []);

    return {
        data: messages,
        isLoading: internalIsLoading && messages.length === 0,
        isError: internalIsError,
        error: internalError,
        fetchNextPage,
        hasNextPage: hasMoreMessages,
        isFetchingNextPage: isFetchingMore,
        addMessage,
        updateMessage,
        removeMessage,
        clearMessages,
    };
}

/**
 * Hook to delete a specific channel message.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useDeleteChannelMessage(
  options: Partial<UseMutationOptions<void, Error, { channelId: UUID; messageId: UUID }, unknown>> = {}
) {
  const client = useElizaClient();
  const { ...restOptions } = options;

  return useMutation<void, Error, { channelId: UUID; messageId: UUID }, unknown>({
    ...restOptions,
    mutationFn: async ({ channelId, messageId }) => {
      await client.messaging.deleteMessage(channelId, messageId);
    },
  });
}

/**
 * Hook to clear all messages in a channel.
 * 
 * @param options - Optional mutation options including onSuccess/onError callbacks
 * @returns Mutation result
 */
export function useClearChannelMessages(
  options: Partial<UseMutationOptions<void, Error, UUID, unknown>> = {}
) {
  const client = useElizaClient();
  const queryClient = useQueryClient();
  const { onSuccess, ...restOptions } = options;

  return useMutation<void, Error, UUID, unknown>({
    ...restOptions,
    mutationFn: async (channelId: UUID) => {
      await client.messaging.clearChannelHistory(channelId);
    },
    onSuccess: (data, channelId, context) => {
      queryClient.invalidateQueries({ queryKey: ['messages', channelId] });
      queryClient.setQueryData(['messages', channelId], () => []);
      (onSuccess as any)?.(data, channelId, context);
    },
    ...restOptions,
  });
}

