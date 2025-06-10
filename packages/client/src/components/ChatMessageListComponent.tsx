import React from 'react';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { ChatMessageList } from '@/components/ui/chat/chat-message-list';
import { ChatBubble } from '@/components/ui/chat/chat-bubble';
import { MemoizedMessageContent } from './chat';
import { UUID, Agent, ChannelType } from '@elizaos/core';
import type { UiMessage } from '@/hooks/use-query-hooks';
import { cn } from '@/lib/utils';
import { getAgentAvatar } from '@/lib/utils';

interface ChatMessageListComponentProps {
  messages: UiMessage[];
  isLoadingMessages: boolean;
  chatType: ChannelType.GROUP | ChannelType.DM;
  currentClientEntityId: string;
  targetAgentData?: Agent;
  allAgents: Partial<Agent>[];
  animatedMessageId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  disableAutoScroll: () => void;
  finalChannelId: UUID | undefined;
  getAgentInMessage?: (agentId: UUID) => Partial<Agent> | undefined;
  agentAvatarMap?: Record<UUID, string | null>;
  onDeleteMessage: (messageId: string) => void;
  onRetryMessage: (messageText: string) => void;
  selectedGroupAgentId?: UUID | null;
}

export const ChatMessageListComponent: React.FC<ChatMessageListComponentProps> = ({
  messages,
  isLoadingMessages,
  chatType,
  currentClientEntityId,
  targetAgentData,
  allAgents,
  animatedMessageId,
  scrollRef,
  isAtBottom,
  scrollToBottom,
  disableAutoScroll,
  finalChannelId,
  getAgentInMessage,
  agentAvatarMap,
  onDeleteMessage,
  onRetryMessage,
  selectedGroupAgentId,
}) => {
  // Filter messages based on selected agent in group chat
  const filteredMessages = React.useMemo(() => {
    if (chatType === ChannelType.GROUP && selectedGroupAgentId) {
      return messages.filter((message) => {
        // Show user messages and messages from selected agent
        const isUser = message.senderId === currentClientEntityId;
        const isSelectedAgent = message.senderId === selectedGroupAgentId;
        return isUser || isSelectedAgent;
      });
    }
    return messages;
  }, [messages, chatType, selectedGroupAgentId, currentClientEntityId]);

  return (
    <ChatMessageList
      key={finalChannelId || 'no-channel'}
      scrollRef={scrollRef}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      disableAutoScroll={disableAutoScroll}
      className="h-full w-full"
    >
      {isLoadingMessages && filteredMessages.length === 0 && (
        <div className="flex flex-1 justify-center items-center">
          <p>Loading messages...</p>
        </div>
      )}
      {!isLoadingMessages && filteredMessages.length === 0 && (
        <div className="flex flex-1 justify-center items-center">
          <p>No messages yet. Start the conversation!</p>
        </div>
      )}
      {filteredMessages.map((message: UiMessage, index: number) => {
        const isUser = message.senderId === currentClientEntityId;
        const shouldAnimate =
          index === filteredMessages.length - 1 &&
          message.isAgent &&
          message.id === animatedMessageId;

        const senderAgent =
          chatType === ChannelType.GROUP && !isUser && getAgentInMessage
            ? getAgentInMessage(message.senderId)
            : undefined;

        return (
          <div
            key={`${message.id}-${message.createdAt}`}
            className={cn('flex gap-1 p-1', isUser ? 'justify-end' : 'justify-start')}
          >
            <ChatBubble
              variant={isUser ? 'sent' : 'received'}
              className={`flex flex-row items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
            >
              {!isUser && (
                <Avatar className="size-8 border rounded-full select-none mb-2">
                  <AvatarImage
                    src={getAgentAvatar(
                      chatType === ChannelType.DM
                        ? targetAgentData
                        : senderAgent ||
                            (agentAvatarMap && message.senderId && allAgents
                              ? allAgents.find((a: Partial<Agent>) => a.id === message.senderId)
                              : undefined)
                    )}
                  />
                </Avatar>
              )}
              <MemoizedMessageContent
                message={message}
                agentForTts={
                  chatType === ChannelType.DM ? targetAgentData : (senderAgent as Agent | undefined)
                }
                shouldAnimate={shouldAnimate}
                onDelete={onDeleteMessage}
                onRetry={onRetryMessage}
                isUser={isUser}
                getAgentInMessage={chatType === ChannelType.GROUP ? getAgentInMessage : undefined}
                agentAvatarMap={chatType === ChannelType.GROUP ? agentAvatarMap : undefined}
                chatType={chatType}
              />
            </ChatBubble>
          </div>
        );
      })}
    </ChatMessageList>
  );
};
