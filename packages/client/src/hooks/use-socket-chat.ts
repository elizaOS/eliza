import { useEffect, useRef, useCallback } from 'react';
import { SocketIOManager } from '@/lib/socketio-manager';
import type {
  MessageBroadcastData,
  MessageCompleteData,
  ControlMessageData,
} from '@/lib/socketio-manager';
import { UUID, Agent, ChannelType } from '@elizaos/core';
import type { UiMessage } from './use-query-hooks';
import { randomUUID } from '@/lib/utils';
import clientLogger from '@/lib/logger';

interface UseSocketChatProps {
  channelId: UUID | undefined;
  currentUserId: string;
  contextId: UUID; // agentId for DM, channelId for GROUP
  chatType: ChannelType.DM | ChannelType.GROUP;
  allAgents: Agent[];
  messages: UiMessage[];
  onAddMessage: (message: UiMessage) => void;
  onUpdateMessage: (messageId: string, updates: Partial<UiMessage>) => void;
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
  onInputDisabledChange,
}: UseSocketChatProps) {
  const socketIOManager = SocketIOManager.getInstance();
  const animatedMessageIdRef = useRef<string | null>(null);
  const joinedChannelRef = useRef<string | null>(null); // Ref to track joined channel

  const sendMessage = useCallback(
    async (
      text: string,
      serverId: UUID,
      source: string,
      attachments?: any[],
      tempMessageId?: string,
      metadata?: Record<string, any>,
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
        serverId,
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

    socketIOManager.initialize(currentUserId); // Initialize on user context

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

      const clientMessageId = (data as any).clientMessageId;
      if (clientMessageId && isCurrentUser) {
        // Update optimistic message with server response
        onUpdateMessage(clientMessageId, {
          id: data.id || randomUUID(),
          isLoading: false,
          createdAt:
            typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt),
          text: data.text,
          attachments: data.attachments,
          isAgent: false,
        });
      } else {
        // Add new message from other participants
        const newUiMsg: UiMessage = {
          id: data.id || randomUUID(),
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
        };

        // Check if message already exists
        const messageExists = messages.some((m) => m.id === data.id);
        if (!messageExists) {
          clientLogger.info('[useSocketChat] Adding new UiMessage:', JSON.stringify(newUiMsg));
          onAddMessage(newUiMsg);

          if (isTargetAgent && newUiMsg.id) {
            animatedMessageIdRef.current = newUiMsg.id;
          } else {
            animatedMessageIdRef.current = null;
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
      }
      msgSub?.detach();
      completeSub?.detach();
      controlSub?.detach();
    };
  }, [channelId, currentUserId, socketIOManager]);

  return {
    sendMessage,
    animatedMessageId: animatedMessageIdRef.current,
  };
}
