import { useEffect, useRef, useCallback } from 'react';
import { SocketIOManager } from '@/lib/socketio-manager';
import type { Media } from '@elizaos/core';
import type {
  MessageBroadcastData,
  MessageCompleteData,
  ControlMessageData,
  MessageDeletedData,
  ChannelClearedData,
  ChannelDeletedData,
  StreamChunkData,
} from '@/lib/socketio-manager';
import { UUID, Agent, ChannelType } from '@elizaos/core';
import type { UiMessage } from './use-query-hooks';
import { randomUUID } from '@/lib/utils';
import clientLogger from '@/lib/logger';
import { useAuth } from '@/context/AuthContext';

// Timeout for stream inactivity - if no chunk received for this duration, mark stream as complete
const STREAM_TIMEOUT_MS = 30000;

interface UseSocketChatProps {
  channelId: UUID | undefined;
  currentUserId: string;
  contextId: UUID | undefined; // agentId for DM, channelId for GROUP - undefined is safe, hook early-returns without channelId
  chatType: ChannelType.DM | ChannelType.GROUP;
  allAgents: Agent[];
  messages: UiMessage[];
  onAddMessage: (message: UiMessage) => void;
  onUpdateMessage: (messageId: string, updates: Partial<UiMessage>) => void;
  onDeleteMessage: (messageId: string) => void;
  onClearMessages: () => void;
  onInputDisabledChange: (disabled: boolean) => void;
}

export function useSocketChat({
  channelId,
  currentUserId,
  contextId,
  chatType,
  allAgents,
  messages,
  onAddMessage,
  onUpdateMessage,
  onDeleteMessage,
  onClearMessages,
  onInputDisabledChange,
}: UseSocketChatProps) {
  const socketIOManager = SocketIOManager.getInstance();
  const { getApiKey } = useAuth();
  const joinedChannelRef = useRef<string | null>(null); // Ref to track joined channel
  // Track streaming messages for this channel instance.
  // Map is cleared on channel cleanup - safe because handleStreamChunk filters by channelId.
  const streamingMessagesRef = useRef<Map<string, string>>(new Map()); // messageId → accumulated text
  // Track stream timeouts to handle stalled streams
  const streamTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Track seen message IDs to avoid stale closure issues with React state
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  const sendMessage = useCallback(
    async (
      text: string,
      messageServerId: UUID,
      source: string,
      attachments?: Media[],
      tempMessageId?: string,
      metadata?: Record<string, unknown>,
      overrideChannelId?: UUID
    ) => {
      const channelIdToUse = overrideChannelId || channelId;
      if (!channelIdToUse) {
        clientLogger.error('[useSocketChat] Cannot send message: no channel ID available');
        return;
      }

      // Add metadata for DM channels
      const messageMetadata = {
        ...metadata,
        channelType: chatType,
        ...(chatType === ChannelType.DM && {
          isDm: true,
          targetUserId: contextId, // The agent ID for DM channels
        }),
      };

      await socketIOManager.sendMessage(
        text,
        channelIdToUse,
        messageServerId,
        source,
        attachments,
        tempMessageId,
        messageMetadata
      );
    },
    [channelId, socketIOManager, chatType, contextId]
  );

  useEffect(() => {
    if (!channelId || !currentUserId) {
      // If channelId becomes undefined (e.g., navigating away), ensure we reset the ref
      if (joinedChannelRef.current) {
        clientLogger.info(
          `[useSocketChat] useEffect: channelId is now null/undefined, resetting joinedChannelRef from ${joinedChannelRef.current}`
        );
        joinedChannelRef.current = null;
      }
      return;
    }

    // Initialize socket with API key for authentication
    const apiKey = getApiKey();
    socketIOManager.initialize(currentUserId, apiKey ?? undefined);

    // Only join if this specific channelId hasn't been joined by this hook instance yet,
    // or if the channelId has changed.
    if (channelId !== joinedChannelRef.current) {
      clientLogger.info(
        `[useSocketChat] useEffect: Joining channel ${channelId}. Previous joinedChannelRef: ${joinedChannelRef.current}`
      );
      socketIOManager.joinChannel(channelId);
      joinedChannelRef.current = channelId; // Mark this channelId as joined by this instance
    } else {
      clientLogger.info(
        `[useSocketChat] useEffect: Channel ${channelId} already marked as joined by this instance. Skipping joinChannel call.`
      );
    }

    const handleMessageBroadcasting = (data: MessageBroadcastData) => {
      clientLogger.info(
        '[useSocketChat] Received raw messageBroadcast data:',
        JSON.stringify(data)
      );
      const msgChannelId = data.channelId || data.roomId;
      if (msgChannelId !== channelId) return;
      const isCurrentUser = data.senderId === currentUserId;

      // Unified message handling for both DM and GROUP
      const isTargetAgent =
        chatType === ChannelType.DM
          ? data.senderId === contextId
          : allAgents.some((agent) => agent.id === data.senderId);

      if (!isCurrentUser && isTargetAgent) onInputDisabledChange(false);

      const clientMessageId =
        'clientMessageId' in data
          ? (data as MessageBroadcastData & { clientMessageId?: string }).clientMessageId
          : undefined;
      if (clientMessageId && isCurrentUser) {
        // Update optimistic message with server response
        onUpdateMessage(clientMessageId, {
          id: (data.id as UUID) || randomUUID(),
          isLoading: false,
          createdAt:
            typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt),
          text: data.text,
          attachments: data.attachments,
          isAgent: false,
        });
      } else {
        const streamingMessages = streamingMessagesRef.current;

        // Check if this message was being streamed
        if (data.id && streamingMessages.has(data.id)) {
          clientLogger.info('[useSocketChat] Completing streamed message by ID:', data.id);
          streamingMessages.delete(data.id);
          // Clear timeout since stream completed normally
          const streamTimeouts = streamTimeoutsRef.current;
          const timeout = streamTimeouts.get(data.id);
          if (timeout) {
            clearTimeout(timeout);
            streamTimeouts.delete(data.id);
          }
          onUpdateMessage(data.id, {
            text: data.text,
            thought: data.thought,
            actions: data.actions,
            attachments: data.attachments,
            isStreaming: false,
            prompt: data.prompt,
            rawMessage: data.rawMessage,
          });
          return;
        }

        // Add new message from other participants
        const messageId = data.id || randomUUID();
        const newUiMsg: UiMessage = {
          id: messageId as UUID,
          text: data.text,
          name: data.senderName,
          senderId: data.senderId as UUID,
          isAgent: isTargetAgent,
          createdAt:
            typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt),
          channelId: (data.channelId || data.roomId) as UUID,
          serverId: data.serverId as UUID | undefined,
          source: data.source,
          attachments: data.attachments,
          thought: data.thought,
          actions: data.actions,
          isLoading: false,
          prompt: data.prompt,
          rawMessage: data.rawMessage,
        };

        // Use ref to track seen message IDs (avoids stale closure with React state)
        const seenIds = seenMessageIdsRef.current;
        const alreadySeen = seenIds.has(messageId);

        clientLogger.info(
          '[useSocketChat] Processing message:',
          messageId,
          'alreadySeen:',
          alreadySeen,
          'source:',
          data.source
        );

        if (data.source === 'agent_action' && data.id) {
          // For action messages, we receive multiple broadcasts (executing -> completed)
          if (alreadySeen) {
            // Update existing action message with new status
            clientLogger.info(
              '[useSocketChat] Updating action message:',
              data.id,
              'actionStatus:',
              (data.rawMessage as { actionStatus?: string })?.actionStatus
            );
            onUpdateMessage(data.id, {
              text: data.text,
              thought: data.thought,
              actions: data.actions,
              attachments: data.attachments,
              rawMessage: data.rawMessage,
            });
          } else {
            // First time seeing this action message
            clientLogger.info('[useSocketChat] Adding new action message:', data.id);
            seenIds.add(messageId);
            onAddMessage(newUiMsg);
          }
        } else {
          // Regular messages - only add if not seen
          if (!alreadySeen) {
            clientLogger.info('[useSocketChat] Adding new message:', messageId);
            seenIds.add(messageId);
            onAddMessage(newUiMsg);
          }
        }
      }
    };

    const handleMessageComplete = (data: MessageCompleteData) => {
      const completeChannelId = data.channelId || data.roomId;
      if (completeChannelId === channelId) onInputDisabledChange(false);
    };

    const handleControlMessage = (data: ControlMessageData) => {
      const ctrlChannelId = data.channelId || data.roomId;
      if (ctrlChannelId === channelId) {
        if (data.action === 'disable_input') onInputDisabledChange(true);
        else if (data.action === 'enable_input') onInputDisabledChange(false);
      }
    };

    const handleMessageDeleted = (data: MessageDeletedData) => {
      const deletedChannelId = data.channelId || data.roomId;
      if (deletedChannelId === channelId && data.messageId) {
        onDeleteMessage(data.messageId);
      }
    };

    const handleChannelCleared = (data: ChannelClearedData) => {
      const clearedChannelId = data.channelId || data.roomId;
      if (clearedChannelId === channelId) {
        onClearMessages();
      }
    };

    const handleChannelDeleted = (data: ChannelDeletedData) => {
      const deletedChannelId = data.channelId || data.roomId;
      if (deletedChannelId === channelId) {
        onClearMessages();
      }
    };

    const handleStreamChunk = (data: StreamChunkData) => {
      if (data.channelId !== channelId) return;

      const { messageId, chunk, agentId } = data;
      const streamingMessages = streamingMessagesRef.current;
      const streamTimeouts = streamTimeoutsRef.current;

      // Clear existing timeout for this message and set a new one
      const existingTimeout = streamTimeouts.get(messageId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Set timeout to mark stream as complete if no more chunks arrive
      const timeout = setTimeout(() => {
        clientLogger.warn(`[useSocketChat] Stream timeout for message ${messageId}`);
        streamingMessages.delete(messageId);
        streamTimeouts.delete(messageId);
        onUpdateMessage(messageId, { isStreaming: false });
      }, STREAM_TIMEOUT_MS);
      streamTimeouts.set(messageId, timeout);

      // Check if we already have this message being streamed
      const existingText = streamingMessages.get(messageId);

      if (existingText === undefined) {
        // First chunk - create placeholder message
        const agent = allAgents.find((a) => a.id === agentId);
        const newUiMsg: UiMessage = {
          id: messageId as UUID,
          text: chunk,
          name: agent?.name || 'Agent',
          senderId: agentId as UUID,
          isAgent: true,
          createdAt: Date.now(),
          channelId: channelId as UUID,
          source: 'streaming',
          isLoading: false,
          isStreaming: true,
        };
        streamingMessages.set(messageId, chunk);
        onAddMessage(newUiMsg);
      } else {
        // Subsequent chunk - update existing message
        const newText = existingText + chunk;
        streamingMessages.set(messageId, newText);
        onUpdateMessage(messageId, { text: newText });
      }
    };

    const msgSub = socketIOManager.evtMessageBroadcast.attach(
      (d: MessageBroadcastData) => (d.channelId || d.roomId) === channelId,
      handleMessageBroadcasting
    );
    const completeSub = socketIOManager.evtMessageComplete.attach(
      (d: MessageCompleteData) => (d.channelId || d.roomId) === channelId,
      handleMessageComplete
    );
    const controlSub = socketIOManager.evtControlMessage.attach(
      (d: ControlMessageData) => (d.channelId || d.roomId) === channelId,
      handleControlMessage
    );
    const deleteSub = socketIOManager.evtMessageDeleted.attach(
      (d: MessageDeletedData) => (d.channelId || d.roomId) === channelId,
      handleMessageDeleted
    );
    const clearSub = socketIOManager.evtChannelCleared.attach(
      (d: ChannelClearedData) => (d.channelId || d.roomId) === channelId,
      handleChannelCleared
    );
    const deletedSub = socketIOManager.evtChannelDeleted.attach(
      (d: ChannelDeletedData) => (d.channelId || d.roomId) === channelId,
      handleChannelDeleted
    );
    const streamSub = socketIOManager.evtMessageStreamChunk.attach(
      (d: StreamChunkData) => d.channelId === channelId,
      handleStreamChunk
    );

    return () => {
      if (channelId) {
        clientLogger.info(
          `[useSocketChat] useEffect cleanup: Leaving channel ${channelId}. Current joinedChannelRef: ${joinedChannelRef.current}`
        );
        socketIOManager.leaveChannel(channelId);
        // Reset ref when component unmounts or channelId changes leading to cleanup
        if (channelId === joinedChannelRef.current) {
          joinedChannelRef.current = null;
          clientLogger.info(
            `[useSocketChat] useEffect cleanup: Reset joinedChannelRef for ${channelId}`
          );
        }
        // Clear streaming state, timeouts, and seen IDs for this channel
        streamingMessagesRef.current.clear();
        // Clear all pending timeouts to prevent memory leaks
        streamTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
        streamTimeoutsRef.current.clear();
        seenMessageIdsRef.current.clear();
      }
      detachSubscriptions([
        msgSub,
        completeSub,
        controlSub,
        deleteSub,
        clearSub,
        deletedSub,
        streamSub,
      ]);
    };

    function detachSubscriptions(subscriptions: Array<{ detach: () => void } | undefined>) {
      subscriptions.forEach((sub) => sub?.detach());
    }
  }, [channelId, currentUserId, socketIOManager]);

  return {
    sendMessage,
  };
}
