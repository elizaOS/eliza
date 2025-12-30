import { useState, useCallback } from 'react';
import type { UUID, Media } from '@elizaos/core';
import { getElizaClient } from '@/lib/api-client-config';
import { getEntityId, randomUUID, getAttachmentType } from '@/lib/utils';
import { USER_NAME } from '@/constants';
import clientLogger from '@/lib/logger';
import type { UiMessage } from '../types';

interface UseHTTPChatOptions {
  sessionId: string | undefined;
  agentId: UUID | undefined;
  serverId: UUID;
  channelId: UUID | undefined;
  onAddMessage: (message: UiMessage) => void;
  onUpdateMessage: (id: string, updates: Partial<UiMessage>) => void;
}

/**
 * HTTP transport for chat (synchronous request/response).
 * Waits for complete agent response before returning.
 *
 * @internal Used by useElizaChat with transport: 'http'
 */
export function useHTTPChat({
  sessionId,
  agentId,
  serverId,
  channelId,
  onAddMessage,
  onUpdateMessage,
}: UseHTTPChatOptions) {
  const [isLoading, setIsLoading] = useState(false);
  const [inputDisabled, setInputDisabled] = useState(false);
  const currentUserId = getEntityId();

  const sendMessage = useCallback(
    async (text: string, attachments?: Media[]) => {
      if (!sessionId || !channelId || !agentId || !text.trim()) return;

      const tempId = randomUUID();
      setInputDisabled(true);
      setIsLoading(true);

      // Add optimistic user message
      const userMessage: UiMessage = {
        id: tempId,
        text,
        name: USER_NAME,
        senderId: currentUserId as UUID,
        isAgent: false,
        createdAt: Date.now(),
        channelId,
        serverId,
        isLoading: true,
        attachments,
      };
      onAddMessage(userMessage);

      try {
        const client = getElizaClient();

        // Send message with HTTP transport (sync mode)
        const response = await client.sessions.sendMessage(sessionId, {
          content: text,
          transport: 'http',
          attachments: attachments?.map((a) => ({
            type: getAttachmentType(a.contentType),
            url: a.url,
            name: a.title,
          })),
        });

        // Mark user message as sent
        onUpdateMessage(tempId, { isLoading: false });

        // Add agent response if present
        if (response.agentResponse) {
          const agentMessage: UiMessage = {
            id: randomUUID(),
            text: response.agentResponse.text,
            name: 'Agent',
            senderId: agentId,
            isAgent: true,
            createdAt: Date.now(),
            channelId,
            serverId,
            isLoading: false,
            thought: response.agentResponse.thought,
            actions: response.agentResponse.actions,
          };
          onAddMessage(agentMessage);
        }
      } catch (error) {
        clientLogger.error('[useHTTPChat] Error sending message:', error);
        onUpdateMessage(tempId, {
          isLoading: false,
          text: `${text} (Failed to send)`,
        });
      } finally {
        setIsLoading(false);
        setInputDisabled(false);
      }
    },
    [sessionId, agentId, serverId, channelId, currentUserId, onAddMessage, onUpdateMessage]
  );

  return {
    sendMessage,
    isLoading,
    inputDisabled,
  };
}
