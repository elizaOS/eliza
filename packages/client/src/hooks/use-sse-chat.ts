import { useState, useCallback, useRef, useEffect } from 'react';
import type { UUID, Media } from '@elizaos/core';
import { createApiClientConfig } from '@/lib/api-client-config';
import { getEntityId, randomUUID, getAttachmentType } from '@/lib/utils';
import { USER_NAME } from '@/constants';
import clientLogger from '@/lib/logger';
import type { UiMessage } from '../types';

interface UseSSEChatOptions {
  sessionId: string | undefined;
  agentId: UUID | undefined;
  serverId: UUID;
  channelId: UUID | undefined;
  onAddMessage: (message: UiMessage) => void;
  onUpdateMessage: (id: string, updates: Partial<UiMessage>) => void;
}

/**
 * SSE (Server-Sent Events) transport for chat.
 * Streams agent responses via SSE instead of WebSocket.
 *
 * @internal Used by useElizaChat with transport: 'sse'
 */
export function useSSEChat({
  sessionId,
  agentId,
  serverId,
  channelId,
  onAddMessage,
  onUpdateMessage,
}: UseSSEChatOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [inputDisabled, setInputDisabled] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentUserId = getEntityId();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string, attachments?: Media[]) => {
      if (!sessionId || !channelId || !agentId || !text.trim()) return;

      const tempId = randomUUID();
      setInputDisabled(true);

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
        const config = createApiClientConfig();
        const baseUrl = config.baseUrl;

        // Abort any previous stream
        abortControllerRef.current?.abort();
        abortControllerRef.current = new AbortController();

        // Send message with SSE transport
        const response = await fetch(`${baseUrl}/api/messaging/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
          },
          body: JSON.stringify({
            content: text,
            transport: 'sse',
            attachments: attachments?.map((a) => ({
              type: getAttachmentType(a.contentType),
              url: a.url,
              name: a.title,
            })),
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Mark user message as sent
        onUpdateMessage(tempId, { isLoading: false });

        // Handle SSE stream
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        setIsStreaming(true);

        // Create agent message placeholder
        const agentMessageId = randomUUID();
        const agentMessage: UiMessage = {
          id: agentMessageId,
          text: '',
          name: 'Agent',
          senderId: agentId,
          isAgent: true,
          createdAt: Date.now(),
          channelId,
          serverId,
          isStreaming: true,
          isLoading: true,
        };
        onAddMessage(agentMessage);

        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process SSE events
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                onUpdateMessage(agentMessageId, {
                  text: accumulatedText,
                  isStreaming: false,
                  isLoading: false,
                });
                setIsStreaming(false);
                continue;
              }

              try {
                const chunk = JSON.parse(data);

                if (chunk.type === 'chunk' && chunk.text) {
                  accumulatedText += chunk.text;
                  onUpdateMessage(agentMessageId, {
                    text: accumulatedText,
                    isStreaming: true,
                  });
                } else if (chunk.type === 'complete') {
                  onUpdateMessage(agentMessageId, {
                    text: chunk.text || accumulatedText,
                    isStreaming: false,
                    isLoading: false,
                  });
                  setIsStreaming(false);
                } else if (chunk.type === 'error') {
                  throw new Error(chunk.error || 'Stream error');
                }
              } catch (parseError) {
                // Non-JSON data, treat as text chunk
                clientLogger.debug('[useSSEChat] Non-JSON SSE data, treating as text chunk', {
                  data,
                  parseError,
                });
                accumulatedText += data;
                onUpdateMessage(agentMessageId, {
                  text: accumulatedText,
                  isStreaming: true,
                });
              }
            }
          }
        }

        // Ensure final state
        onUpdateMessage(agentMessageId, {
          text: accumulatedText,
          isStreaming: false,
          isLoading: false,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }

        clientLogger.error('[useSSEChat] Error sending message:', error);
        onUpdateMessage(tempId, {
          isLoading: false,
          text: `${text} (Failed to send)`,
        });
      } finally {
        setIsStreaming(false);
        setInputDisabled(false);
      }
    },
    [sessionId, agentId, serverId, channelId, currentUserId, onAddMessage, onUpdateMessage]
  );

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return {
    sendMessage,
    stopStreaming,
    isStreaming,
    inputDisabled,
  };
}
