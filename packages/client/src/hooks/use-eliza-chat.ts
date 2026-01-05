import { useState, useCallback, useMemo } from 'react';
import { ChannelType, type UUID, type Media } from '@elizaos/core';
import type { TransportType } from '@elizaos/api-client';
import { useChannelMessages, useAgents, type UiMessage } from './use-query-hooks';
import { useSocketChat } from './use-socket-chat';
import { useSSEChat } from './use-sse-chat';
import { useHTTPChat } from './use-http-chat';
import { getEntityId, randomUUID } from '@/lib/utils';
import { USER_NAME } from '@/constants';
import clientLogger from '@/lib/logger';

interface UseElizaChatOptions {
  channelId: UUID | undefined;
  serverId: UUID;
  agentId?: UUID;
  chatType?: ChannelType.DM | ChannelType.GROUP;
  /**
   * Transport type for sending messages
   * - "websocket": Real-time bidirectional (default)
   * - "sse": Server-Sent Events streaming
   * - "http": Synchronous HTTP request/response
   */
  transport?: TransportType;
  /**
   * Session ID for SSE/HTTP transports (required when not using websocket)
   */
  sessionId?: string;

  // Lifecycle callbacks (optional) - for custom side effects
  /**
   * Called when a message is added to the chat (user or agent)
   * Use for: scroll to bottom, update chat title, analytics, notifications
   */
  onMessageAdded?: (message: UiMessage) => void;
  /**
   * Called when a message is updated (e.g., streaming complete, loading done)
   * Use for: scroll to bottom on stream end, UI updates
   */
  onMessageUpdated?: (id: UUID, updates: Partial<UiMessage>) => void;
  /**
   * Called when a message is deleted
   */
  onMessageDeleted?: (id: UUID) => void;
  /**
   * Called when messages are cleared
   */
  onMessagesCleared?: () => void;
  /**
   * Called when input disabled state changes
   */
  onInputDisabledChange?: (disabled: boolean) => void;
  /**
   * Called when an error occurs during send
   */
  onError?: (error: Error) => void;
}

/**
 * Unified hook for chat functionality.
 * Combines message fetching, sending, and real-time streaming.
 * Supports multiple transport types: websocket (default), sse, http.
 *
 * @example
 * ```tsx
 * // WebSocket (default)
 * const { messages, sendMessage, isTyping } = useElizaChat({
 *   channelId,
 *   serverId,
 *   agentId,
 * });
 *
 * // SSE streaming
 * const { messages, sendMessage, isTyping } = useElizaChat({
 *   channelId,
 *   serverId,
 *   agentId,
 *   transport: 'sse',
 *   sessionId,
 * });
 *
 * // HTTP sync
 * const { messages, sendMessage } = useElizaChat({
 *   channelId,
 *   serverId,
 *   agentId,
 *   transport: 'http',
 *   sessionId,
 * });
 * ```
 */
export function useElizaChat({
  channelId,
  serverId,
  agentId,
  chatType = ChannelType.DM,
  transport = 'websocket',
  sessionId,
  // Lifecycle callbacks
  onMessageAdded,
  onMessageUpdated,
  onMessageDeleted,
  onMessagesCleared,
  onInputDisabledChange,
  onError,
}: UseElizaChatOptions) {
  const currentUserId = getEntityId();
  const [inputDisabled, setInputDisabled] = useState(false);

  // Fetch agents for name resolution in streaming
  const agentsQuery = useAgents();
  const allAgents = useMemo(() => agentsQuery.data?.data?.agents ?? [], [agentsQuery.data]);

  // Message state management
  const {
    data: messages = [],
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    addMessage: internalAddMessage,
    updateMessage: internalUpdateMessage,
    removeMessage: internalRemoveMessage,
    clearMessages: internalClearMessages,
  } = useChannelMessages(channelId, serverId);

  // Wrapped handlers that call internal + external callbacks
  const handleAddMessage = useCallback(
    (message: UiMessage) => {
      internalAddMessage(message);
      onMessageAdded?.(message);
    },
    [internalAddMessage, onMessageAdded]
  );

  const handleUpdateMessage = useCallback(
    (id: UUID, updates: Partial<UiMessage>) => {
      internalUpdateMessage(id, updates);
      onMessageUpdated?.(id, updates);
    },
    [internalUpdateMessage, onMessageUpdated]
  );

  const handleRemoveMessage = useCallback(
    (id: UUID) => {
      internalRemoveMessage(id);
      onMessageDeleted?.(id);
    },
    [internalRemoveMessage, onMessageDeleted]
  );

  const handleClearMessages = useCallback(() => {
    internalClearMessages();
    onMessagesCleared?.();
  }, [internalClearMessages, onMessagesCleared]);

  const handleInputDisabledChange = useCallback(
    (disabled: boolean) => {
      setInputDisabled(disabled);
      onInputDisabledChange?.(disabled);
    },
    [onInputDisabledChange]
  );

  // Detect if agent is currently typing (streaming)
  const isTyping = useMemo(() => messages.some((m) => m.isStreaming), [messages]);

  // Derive contextId - agentId for DM, channelId for GROUP
  const contextId = agentId ?? channelId;

  // WebSocket transport
  const { sendMessage: socketSend } = useSocketChat({
    channelId,
    currentUserId,
    contextId,
    chatType,
    allAgents,
    messages,
    onAddMessage: handleAddMessage,
    onUpdateMessage: (id, updates) => handleUpdateMessage(id as UUID, updates),
    onDeleteMessage: (id) => handleRemoveMessage(id as UUID),
    onClearMessages: handleClearMessages,
    onInputDisabledChange: handleInputDisabledChange,
  });

  // SSE transport
  const {
    sendMessage: sseSend,
    isStreaming: sseIsStreaming,
    inputDisabled: sseInputDisabled,
    stopStreaming,
  } = useSSEChat({
    sessionId,
    agentId,
    serverId,
    channelId,
    onAddMessage: handleAddMessage,
    onUpdateMessage: (id, updates) => handleUpdateMessage(id as UUID, updates),
  });

  // HTTP transport
  const {
    sendMessage: httpSend,
    isLoading: httpIsLoading,
    inputDisabled: httpInputDisabled,
  } = useHTTPChat({
    sessionId,
    agentId,
    serverId,
    channelId,
    onAddMessage: handleAddMessage,
    onUpdateMessage: (id, updates) => handleUpdateMessage(id as UUID, updates),
  });

  /**
   * Send a message through the configured transport.
   *
   * @param text - Message text
   * @param options - Optional advanced options
   * @param options.attachments - Media attachments
   * @param options.messageId - Use existing message ID (skip optimistic update creation)
   * @param options.source - Message source identifier (default: 'client')
   * @param options.skipOptimisticUpdate - Don't create optimistic message (caller handles it)
   * @param options.overrideChannelId - Override the channel ID for this message
   */
  const sendMessage = useCallback(
    async (
      text: string,
      options?: {
        attachments?: Media[];
        messageId?: UUID;
        source?: string;
        skipOptimisticUpdate?: boolean;
        overrideChannelId?: UUID;
      }
    ) => {
      if (!text.trim() && !options?.attachments?.length) return;

      const {
        attachments,
        messageId,
        source = 'client',
        skipOptimisticUpdate = false,
        overrideChannelId,
      } = options || {};

      try {
        if (transport === 'sse') {
          if (!sessionId) {
            throw new Error('sessionId is required for SSE transport');
          }
          await sseSend(text, attachments);
        } else if (transport === 'http') {
          if (!sessionId) {
            throw new Error('sessionId is required for HTTP transport');
          }
          await httpSend(text, attachments);
        } else {
          // Default: websocket
          const targetChannelId = overrideChannelId ?? channelId;
          if (!targetChannelId) return;

          const tempId = messageId ?? randomUUID();

          // Optimistic UI update (unless caller handles it)
          if (!skipOptimisticUpdate && !messageId) {
            const optimisticMessage: UiMessage = {
              id: tempId,
              text,
              name: USER_NAME,
              senderId: currentUserId as UUID,
              isAgent: false,
              createdAt: Date.now(),
              channelId: targetChannelId,
              serverId,
              isLoading: true,
              attachments,
            };
            handleAddMessage(optimisticMessage);
          }

          // Send via socket
          await socketSend(text, serverId, source, attachments, tempId, undefined, targetChannelId);
        }
      } catch (error) {
        clientLogger.error('[useElizaChat] Error sending message:', error);
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [
      transport,
      sessionId,
      channelId,
      serverId,
      currentUserId,
      socketSend,
      sseSend,
      httpSend,
      handleAddMessage,
      onError,
    ]
  );

  // Compute combined states (no useMemo needed - simple conditionals on primitives)
  const combinedInputDisabled =
    transport === 'sse'
      ? sseInputDisabled
      : transport === 'http'
        ? httpInputDisabled
        : inputDisabled;

  const combinedIsTyping =
    transport === 'sse' ? sseIsStreaming : transport === 'http' ? httpIsLoading : isTyping;

  return {
    // Data
    messages,
    // States
    isLoading,
    isTyping: combinedIsTyping,
    isError,
    inputDisabled: combinedInputDisabled,
    // Pagination
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
    // Error
    error,
    // Actions
    sendMessage,
    fetchMore: fetchNextPage,
    clearMessages: handleClearMessages,
    // Direct message manipulation (for advanced use cases like retry, optimistic updates)
    addMessage: handleAddMessage,
    updateMessage: handleUpdateMessage,
    removeMessage: handleRemoveMessage,
    // SSE specific
    stopStreaming: transport === 'sse' ? stopStreaming : undefined,
  };
}
