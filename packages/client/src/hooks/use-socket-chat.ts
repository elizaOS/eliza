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

interface UseSocketChatProps {
  channelId: UUID | undefined;
  currentUserId: string;
  contextId: UUID; // agentId for DM, channelId for GROUP
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

      const clientMessageId = 'clientMessageId' in data ? (data as MessageBroadcastData & { clientMessageId?: string }).clientMessageId : undefined;
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
        const messageId = data.id || randomUUID();
        const streamingMessages = streamingMessagesRef.current;

        // Check if this message was being streamed
        if (data.id && streamingMessages.has(data.id)) {
          // Message was streamed - update with final content and mark streaming complete
          clientLogger.info('[useSocketChat] Completing streamed message:', data.id);
          streamingMessages.delete(data.id);
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

        // Check if message already exists
        const messageExists = messages.some((m) => m.id === data.id);
        if (!messageExists) {
          clientLogger.info('[useSocketChat] Adding new UiMessage:', JSON.stringify(newUiMsg));
          onAddMessage(newUiMsg);
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
        // Clear streaming messages for this channel
        streamingMessagesRef.current.clear();
      }
      detachSubscriptions([msgSub, completeSub, controlSub, deleteSub, clearSub, deletedSub, streamSub]);
    };

    function detachSubscriptions(subscriptions: Array<{ detach: () => void } | undefined>) {
      subscriptions.forEach((sub) => sub?.detach());
    }
  }, [channelId, currentUserId, socketIOManager]);

  return {
    sendMessage,
  };
}
