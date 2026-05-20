import { logger, type MessageMetadata } from '@feed/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MessageReactionSummary,
  type MessageType,
  MessageTypeEnum,
  type ReplyToMessage,
} from '@/components/chats/types';
import { useAuth } from '@/hooks/useAuth';
import { getPrivyAccessTokenSafely } from '@/lib/auth/privyAccessToken';
import { setCachedMessages } from '@/lib/chat/message-store';
import { CHAT_PAGE_SIZE } from '@/lib/constants';
import { useAuthStore } from '@/stores/authStore';
import { useSSEChannel } from './useSSE';
import { applyReactionDelta } from './useToggleReaction';

/**
 * Represents a chat message in the system.
 */
export interface ChatMessage {
  id: string;
  content: string;
  chatId: string;
  senderId: string;
  type?: MessageType;
  createdAt: string;
  isGameChat?: boolean;
  /** Stable key for React rendering - prevents flash when optimistic messages are replaced */
  stableKey?: string;
  /** Whether this message is a "thinking" placeholder (shows spinner while waiting for response) */
  isThinking?: boolean;
  /** Metadata containing action tags for sidebar display */
  metadata?: MessageMetadata | null;
  /** Aggregated emoji reactions summary (counts + whether current user reacted). */
  reactions?: MessageReactionSummary[];
  /** ID of the message this is replying to */
  replyToMessageId?: string | null;
  /** Denormalized snippet of the replied-to message */
  replyToMessage?: ReplyToMessage | null;
}

/** Raw message from API (createdAt may be string or Date) */
interface RawApiMessage {
  id: string;
  content: string;
  senderId: string;
  type?: MessageType;
  createdAt: string | Date;
  metadata?: MessageMetadata | null;
  reactions?: MessageReactionSummary[];
  replyToMessageId?: string | null;
  replyToMessage?: ReplyToMessage | null;
}

/** Format raw API message to ChatMessage */
function formatMessage(msg: RawApiMessage, chatId: string): ChatMessage {
  return {
    id: msg.id,
    content: msg.content,
    chatId,
    senderId: msg.senderId,
    type: msg.type,
    createdAt:
      typeof msg.createdAt === 'string'
        ? msg.createdAt
        : msg.createdAt.toISOString(),
    metadata: msg.metadata,
    reactions: msg.reactions,
    replyToMessageId: msg.replyToMessageId,
    replyToMessage: msg.replyToMessage,
  };
}

/**
 * Prefix for optimistic message IDs. Used so SSE/replaceOptimisticMessage can
 * match and replace placeholders instead of appending duplicates.
 */
export enum OptimisticMessageIdPrefix {
  /** User message not yet confirmed by server */
  Pending = 'pending-',
  /** Agent/coordinator response in progress (thinking placeholder) */
  Thinking = 'thinking-',
}

/**
 * Time window (ms) for matching optimistic messages to confirmed messages.
 * If a confirmed message arrives within this window of an optimistic message
 * with matching content and sender, they are considered the same message.
 */
const OPTIMISTIC_MATCH_WINDOW_MS = 30000;

/** Check if a message is an optimistic placeholder matching the incoming confirmed message */
export function isMatchingOptimistic(
  pending: ChatMessage,
  incoming: ChatMessage
): boolean {
  const inWindow =
    Math.abs(
      new Date(pending.createdAt).getTime() -
        new Date(incoming.createdAt).getTime()
    ) < OPTIMISTIC_MATCH_WINDOW_MS;
  if (pending.id.startsWith(OptimisticMessageIdPrefix.Pending)) {
    return (
      pending.senderId === incoming.senderId &&
      pending.content === incoming.content &&
      inWindow
    );
  }
  if (pending.id.startsWith(OptimisticMessageIdPrefix.Thinking)) {
    return pending.senderId === incoming.senderId && inWindow;
  }
  return false;
}

/**
 * Adds a confirmed message to the list, replacing any matching optimistic message.
 * Preserves the stableKey from the optimistic message to prevent React remount.
 * Merges metadata from SSE messages when a message with the same ID already exists.
 */
export function replaceOptimisticMessage(
  messages: ChatMessage[],
  confirmed: ChatMessage
): ChatMessage[] {
  // Check if message with same ID already exists
  const existingIdx = messages.findIndex((msg) => msg.id === confirmed.id);
  if (existingIdx >= 0) {
    const existingMsg = messages[existingIdx];
    // Merge metadata from confirmed message (SSE) into existing message
    // This handles the case where updateMessage is called first (without metadata)
    // and then SSE arrives with metadata
    if (confirmed.metadata && existingMsg && !existingMsg.metadata) {
      return messages.map((msg, idx) =>
        idx === existingIdx ? { ...msg, metadata: confirmed.metadata } : msg
      );
    }
    return messages;
  }

  // Replace optimistic message if found
  const pending = messages.find((msg) => isMatchingOptimistic(msg, confirmed));
  if (pending) {
    // Preserve the optimistic message's createdAt to maintain visual order
    // The server timestamp might differ due to network latency, but we want
    // to keep the message in the same position the user saw it
    return messages.map((msg) =>
      msg.id === pending.id
        ? {
            ...confirmed,
            stableKey: pending.stableKey || pending.id,
            createdAt: pending.createdAt,
          }
        : msg
    );
  }

  // Don't sort - just append. This preserves visual order during real-time chat.
  // Messages are already sorted when loaded from API.
  return [...messages, confirmed];
}

/** Polling interval — only used when SSE is disconnected */
const POLLING_INTERVAL_MS = 15000;

/**
 * React Query cache key for chat messages.
 * Scoped to userId so different users never share cached data.
 * Exported so other modules can read/invalidate.
 */
export const chatMessagesQueryKey = (chatId: string, userId?: string | null) =>
  userId
    ? (['chat-messages', userId, chatId] as const)
    : (['chat-messages', chatId] as const);

/**
 * Shape of the data stored in the React Query cache for a chat.
 * Bundles messages with pagination state so they stay in sync.
 *
 * Cache lifetime: Data is written/read via setQueryData/getQueryData (not useQuery).
 * React Query's default gcTime (5 min) applies — unused chat data is garbage-collected
 * 5 minutes after the last component stops referencing it. For frequently-visited chats,
 * data stays alive indefinitely. For cross-session persistence, IndexedDB handles it.
 */
export interface ChatMessagesData {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Hook for managing chat messages with React Query caching + real-time SSE updates.
 *
 * Uses React Query for in-memory caching so switching between chats is instant
 * on return visits (gcTime: 30 min). SSE pushes live messages via
 * queryClient.setQueryData. Polling fallback only activates when SSE drops.
 *
 * @param chatId - The ID of the chat to load messages for, or null to clear.
 */
export function useChatMessages(chatId: string | null) {
  const { getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const pendingReactionDeltasRef = useRef<Set<string>>(new Set());

  const markPendingReactionDelta = useCallback(
    (delta: {
      messageId: string;
      emoji: string;
      action: 'added' | 'removed';
    }) => {
      const key = `${delta.messageId}:${delta.emoji}:${delta.action}`;
      pendingReactionDeltasRef.current.add(key);
      setTimeout(() => pendingReactionDeltasRef.current.delete(key), 5000);
    },
    []
  );

  const getSafeAccessToken = useCallback(
    () =>
      getPrivyAccessTokenSafely(getAccessToken, {
        onError: (error) => {
          logger.warn(
            'Failed to retrieve chat access token',
            { error: error.message },
            'useChatMessages'
          );
        },
      }),
    [getAccessToken]
  );

  const userId = user?.id ?? null;

  // ── Helpers to read/write the React Query cache ─────────────────────
  const getCachedData = useCallback((): ChatMessagesData | undefined => {
    if (!chatId) return undefined;
    return queryClient.getQueryData<ChatMessagesData>(
      chatMessagesQueryKey(chatId, userId)
    );
  }, [chatId, userId, queryClient]);

  const setCachedData = useCallback(
    (
      updater: (
        old: ChatMessagesData | undefined
      ) => ChatMessagesData | undefined
    ) => {
      if (!chatId) return;
      queryClient.setQueryData<ChatMessagesData>(
        chatMessagesQueryKey(chatId, userId),
        updater
      );
    },
    [chatId, userId, queryClient]
  );

  // ── Initial message loading ─────────────────────────────────────────
  // Uses the query cache: if data already exists (from a previous visit
  // or IndexedDB hydration), it's returned instantly with no fetch.
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef<Set<string>>(new Set());

  const loadMessages = useCallback(
    async (targetChatId: string) => {
      // If React Query already has data for this chat, skip the fetch
      const existing = queryClient.getQueryData<ChatMessagesData>(
        chatMessagesQueryKey(targetChatId, userId)
      );
      if (existing && existing.messages.length > 0) {
        hasLoadedRef.current.add(targetChatId);
        return;
      }

      if (hasLoadedRef.current.has(targetChatId)) {
        return;
      }

      setIsLoading(true);
      try {
        const token = await getSafeAccessToken();
        if (!token) {
          logger.error(
            'Failed to load messages - no auth token',
            { chatId: targetChatId },
            'useChatMessages'
          );
          return;
        }

        const response = await fetch(
          `/api/chats/${targetChatId}?limit=${CHAT_PAGE_SIZE}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (response.ok) {
          const data = await response.json();
          if (data.messages) {
            const formatted = (data.messages as RawApiMessage[]).map((msg) =>
              formatMessage(msg, targetChatId)
            );
            queryClient.setQueryData<ChatMessagesData>(
              chatMessagesQueryKey(targetChatId, userId),
              {
                messages: formatted,
                hasMore: data.pagination?.hasMore ?? false,
                nextCursor: data.pagination?.nextCursor ?? null,
              }
            );
            hasLoadedRef.current.add(targetChatId);
            logger.debug(
              `Loaded ${formatted.length} messages`,
              { chatId: targetChatId, count: formatted.length },
              'useChatMessages'
            );
          }
        } else {
          logger.error(
            'Failed to load messages',
            { chatId: targetChatId, status: response.status },
            'useChatMessages'
          );
        }
      } catch (error) {
        logger.error(
          'Failed to load messages',
          {
            chatId: targetChatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'useChatMessages'
        );
      } finally {
        setIsLoading(false);
      }
    },
    [getSafeAccessToken, userId, queryClient]
  );

  // ── Load more (older messages via cursor pagination) ────────────────
  const loadMore = useCallback(async () => {
    const currentData = getCachedData();
    if (
      !chatId ||
      !currentData?.nextCursor ||
      isLoadingMore ||
      !currentData.hasMore
    )
      return;

    setIsLoadingMore(true);
    try {
      const token = await getSafeAccessToken();
      if (!token) {
        logger.error(
          'Failed to load more messages - no auth token',
          { chatId },
          'useChatMessages'
        );
        return;
      }

      const response = await fetch(
        `/api/chats/${chatId}?cursor=${currentData.nextCursor}&limit=${CHAT_PAGE_SIZE}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.messages?.length > 0) {
          const formatted = (data.messages as RawApiMessage[]).map((msg) =>
            formatMessage(msg, chatId)
          );
          setCachedData((old) => {
            if (!old) return old;
            return {
              messages: [...formatted, ...old.messages],
              hasMore: data.pagination?.hasMore ?? false,
              nextCursor: data.pagination?.nextCursor ?? null,
            };
          });
        }
      } else {
        logger.error(
          'Failed to load more messages',
          { chatId, status: response.status },
          'useChatMessages'
        );
      }
    } catch (error) {
      logger.warn(
        'Loading more messages failed',
        {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'useChatMessages'
      );
    } finally {
      setIsLoadingMore(false);
    }
  }, [chatId, isLoadingMore, getSafeAccessToken, getCachedData, setCachedData]);

  // ── SSE handler ─────────────────────────────────────────────────────
  const handleChatUpdate = useCallback(
    (data: Record<string, unknown>) => {
      if (data.type === 'new_message' && data.message) {
        const m = data.message as Record<string, unknown>;
        if (
          typeof m.id !== 'string' ||
          typeof m.content !== 'string' ||
          typeof m.chatId !== 'string' ||
          typeof m.senderId !== 'string' ||
          typeof m.createdAt !== 'string' ||
          m.chatId !== chatId
        ) {
          return;
        }

        const newMessage: ChatMessage = {
          id: m.id,
          content: m.content,
          chatId: m.chatId,
          senderId: m.senderId,
          type:
            m.type === MessageTypeEnum.USER || m.type === MessageTypeEnum.SYSTEM
              ? (m.type as MessageType)
              : undefined,
          createdAt: m.createdAt,
          isGameChat:
            typeof m.isGameChat === 'boolean' ? m.isGameChat : undefined,
          metadata: m.metadata as MessageMetadata | null | undefined,
          reactions: Array.isArray(m.reactions)
            ? (m.reactions as MessageReactionSummary[])
            : undefined,
          replyToMessageId:
            typeof m.replyToMessageId === 'string'
              ? m.replyToMessageId
              : undefined,
          replyToMessage: m.replyToMessage as ReplyToMessage | null | undefined,
        };

        setIsLoading(false);
        setCachedData((old) => {
          if (!old)
            return {
              messages: [newMessage],
              hasMore: false,
              nextCursor: null,
            };
          return {
            ...old,
            messages: replaceOptimisticMessage(old.messages, newMessage),
          };
        });
        return;
      }

      if (data.type === 'message_reaction' && data.reaction) {
        const r = data.reaction as Record<string, unknown>;
        if (
          typeof r.messageId !== 'string' ||
          typeof r.chatId !== 'string' ||
          typeof r.emoji !== 'string' ||
          typeof r.userId !== 'string' ||
          typeof r.action !== 'string' ||
          r.chatId !== chatId ||
          (r.action !== 'added' && r.action !== 'removed')
        ) {
          return;
        }

        const isMine = !!user?.id && r.userId === user.id;
        const emoji = r.emoji;
        const action = r.action as 'added' | 'removed';

        if (isMine) {
          const key = `${r.messageId}:${emoji}:${action}`;
          if (pendingReactionDeltasRef.current.has(key)) {
            pendingReactionDeltasRef.current.delete(key);
            return;
          }
        }

        setCachedData((old) => {
          if (!old) return old;
          const idx = old.messages.findIndex((m) => m.id === r.messageId);
          if (idx < 0) return old;
          const msg = old.messages[idx]!;
          const next = applyReactionDelta(msg.reactions, emoji, action, isMine);
          return {
            ...old,
            messages: old.messages.map((m, i) =>
              i === idx ? { ...m, reactions: next } : m
            ),
          };
        });
      }
    },
    [chatId, user?.id, setCachedData]
  );

  // Subscribe to chat channel
  const channel: `chat:${string}` | null = chatId ? `chat:${chatId}` : null;
  const { isConnected } = useSSEChannel(channel, handleChatUpdate);

  // ── Load on chat switch ─────────────────────────────────────────────
  const previousChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousChatIdRef.current !== chatId) {
      if (chatId) {
        void loadMessages(chatId);
      } else {
        setIsLoading(false);
      }
      previousChatIdRef.current = chatId;
    }
  }, [chatId, loadMessages]);

  // ── Incremental sync: fetch only new messages via ?after= param ─────
  // Paginates until hasMore is false so long disconnects don't silently drop messages.
  const syncNewMessages = useCallback(
    async (targetChatId: string) => {
      try {
        const currentData = queryClient.getQueryData<ChatMessagesData>(
          chatMessagesQueryKey(targetChatId, userId)
        );
        const lastMessage = currentData?.messages?.at(-1);
        if (!lastMessage) {
          // No cache — do a full reload instead of sync
          hasLoadedRef.current.delete(targetChatId);
          void loadMessages(targetChatId);
          return;
        }

        const token = await getSafeAccessToken();
        if (!token) return;

        // Paginate until all missed messages are fetched
        let afterTimestamp = lastMessage.createdAt;
        const MAX_SYNC_PAGES = 10; // Safety cap to avoid infinite loops
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const response = await fetch(
            `/api/chats/${targetChatId}?after=${encodeURIComponent(afterTimestamp)}&limit=${CHAT_PAGE_SIZE}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!response.ok) return;

          const data = await response.json();
          if (!data.messages || data.messages.length === 0) return;

          const newMessages = (data.messages as RawApiMessage[]).map((msg) =>
            formatMessage(msg, targetChatId)
          );

          queryClient.setQueryData<ChatMessagesData>(
            chatMessagesQueryKey(targetChatId, userId),
            (old) => {
              if (!old) return old;
              const existingIds = new Set(old.messages.map((m) => m.id));
              const deduped = newMessages.filter((m) => !existingIds.has(m.id));
              if (deduped.length === 0) return old;
              return { ...old, messages: [...old.messages, ...deduped] };
            }
          );

          // If server says no more, we're caught up
          if (!data.pagination?.hasMore) break;

          // Advance cursor to the last message we received
          const lastNew = newMessages.at(-1);
          if (!lastNew) break;
          afterTimestamp = lastNew.createdAt;
        }
      } catch (error) {
        logger.warn(
          'Incremental chat sync failed',
          {
            chatId: targetChatId,
            error: error instanceof Error ? error.message : String(error),
          },
          'useChatMessages'
        );
      }
    },
    [queryClient, userId, getSafeAccessToken, loadMessages]
  );

  // ── Polling fallback — only when SSE is disconnected ────────────────
  // Uses incremental sync (?after=) instead of full refetch.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!chatId || isConnected) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    const startTimeout = setTimeout(() => {
      pollIntervalRef.current = setInterval(() => {
        void syncNewMessages(chatId);
      }, POLLING_INTERVAL_MS);
    }, 1000);

    return () => {
      clearTimeout(startTimeout);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [chatId, isConnected, syncNewMessages]);

  // On SSE reconnect, sync any messages missed during the disconnect
  const wasConnectedRef = useRef(isConnected);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current && chatId) {
      void syncNewMessages(chatId);
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, chatId, syncNewMessages]);

  // SSE connected means we're ready
  useEffect(() => {
    if (isConnected && chatId) setIsLoading(false);
  }, [isConnected, chatId]);

  // ── Derived state from cache ────────────────────────────────────────
  const cachedData = getCachedData();
  const messages = cachedData?.messages ?? [];
  const hasMore = cachedData?.hasMore ?? false;

  // ── Persist to IndexedDB for cross-session survival ─────────────────
  // Fire-and-forget — never blocks renders. Only persists confirmed
  // messages (filters out optimistic pending-* and thinking-* entries).
  // Debounced to 2s to batch rapid message bursts in active chats.
  const lastPersistedCountRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!chatId || !userId || !cachedData || cachedData.messages.length === 0)
      return;
    const confirmedMessages = cachedData.messages.filter(
      (m) =>
        !m.id.startsWith(OptimisticMessageIdPrefix.Pending) &&
        !m.id.startsWith(OptimisticMessageIdPrefix.Thinking)
    );
    if (confirmedMessages.length === lastPersistedCountRef.current) return;

    // Debounce: wait 2s of quiet before persisting
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    const capturedChatId = chatId;
    const capturedUserId = userId;
    const capturedData = {
      messages: confirmedMessages,
      hasMore: cachedData.hasMore,
      nextCursor: cachedData.nextCursor,
    };
    persistTimerRef.current = setTimeout(() => {
      lastPersistedCountRef.current = confirmedMessages.length;
      void setCachedMessages(capturedUserId, capturedChatId, capturedData);
      persistTimerRef.current = null;
    }, 2000);

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [chatId, userId, cachedData]);

  // ── Mutation helpers (same interface as before) ─────────────────────
  const addMessage = useCallback(
    (message: ChatMessage) => {
      const isOptimistic =
        message.id.startsWith(OptimisticMessageIdPrefix.Pending) ||
        message.id.startsWith(OptimisticMessageIdPrefix.Thinking);
      setCachedData((old) => {
        if (!old)
          return { messages: [message], hasMore: false, nextCursor: null };
        if (isOptimistic) {
          return { ...old, messages: [...old.messages, message] };
        }
        return {
          ...old,
          messages: replaceOptimisticMessage(old.messages, message),
        };
      });
    },
    [setCachedData]
  );

  const updateMessage = useCallback(
    (messageId: string, updates: Partial<ChatMessage>) => {
      setCachedData((old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.map((msg) =>
            msg.id === messageId ? { ...msg, ...updates } : msg
          ),
        };
      });
    },
    [setCachedData]
  );

  const removeMessage = useCallback(
    (messageId: string) => {
      setCachedData((old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.filter((msg) => msg.id !== messageId),
        };
      });
    },
    [setCachedData]
  );

  const clearMessages = useCallback(() => {
    if (chatId) {
      queryClient.removeQueries({
        queryKey: chatMessagesQueryKey(chatId, userId),
      });
    }
    hasLoadedRef.current.clear();
  }, [chatId, userId, queryClient]);

  const reloadMessages = useCallback(() => {
    if (chatId) {
      hasLoadedRef.current.delete(chatId);
      queryClient.removeQueries({
        queryKey: chatMessagesQueryKey(chatId, userId),
      });
      void loadMessages(chatId);
    }
  }, [chatId, userId, loadMessages, queryClient]);

  return {
    messages,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    addMessage,
    updateMessage,
    removeMessage,
    clearMessages,
    reloadMessages,
    isConnected,
    markPendingReactionDelta,
  };
}
