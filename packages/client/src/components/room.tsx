import { Button } from '@/components/ui/button';
import {
  ChatBubble,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from '@/components/ui/chat/chat-bubble';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessageList } from '@/components/ui/chat/chat-message-list';
import { USER_NAME } from '@/constants';
import { GROUP_CHAT_SOURCE } from '@/constants';
import { useAgents, useGroupMessages, useRooms } from '@/hooks/use-query-hooks';
import SocketIOManager from '@/lib/socketio-manager';
import { getEntityId, moment } from '@/lib/utils';
import { WorldManager } from '@/lib/world-manager';
import type { IAttachment } from '@/types';
import type { Agent, Content, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Paperclip, Send, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import React from 'react';
import AIWriter from 'react-aiwriter';
import { AgentStatusSidebar } from './agent-status-sidebar';
import CopyButton from './copy-button';
import { Avatar, AvatarImage } from './ui/avatar';
import { Badge } from './ui/badge';
import ChatTtsButton from './ui/chat/chat-tts-button';
import { useAutoScroll } from './ui/chat/hooks/useAutoScroll';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

type ExtraContentFields = {
  name: string;
  createdAt: number;
  isLoading?: boolean;
};

type ContentWithUser = Content & ExtraContentFields;

const MemoizedMessageContent = React.memo(MessageContent);

function MessageContent({
  message,
  isLastMessage,
  isUser,
}: {
  message: ContentWithUser;
  isLastMessage: boolean;
  isUser: boolean;
}) {
  // Only log message details in development mode
  if (import.meta.env.DEV) {
    console.log(`[Chat] Rendering message from ${message.name}:`, {
      isUser: isUser,
      text: message.text?.substring(0, 20) + '...',
      senderId: message.senderId,
      source: message.source,
    });
  }

  return (
    <div className="flex flex-col w-full">
      <ChatBubbleMessage
        isLoading={message.isLoading}
        {...(isUser ? { variant: 'sent' } : {})}
        {...(!message.text ? { className: 'bg-transparent' } : {})}
      >
        {!isUser && (
          <div className="w-full">
            {message.text && message.thought && (
              <Collapsible className="mb-1">
                <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors group">
                  <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
                  Thought Process
                </CollapsibleTrigger>
                <CollapsibleContent className="pl-5 pt-1">
                  <Badge variant="outline" className="text-xs">
                    {message.thought}
                  </Badge>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}

        <div className="py-2">
          {isUser ? (
            message.text
          ) : isLastMessage && !isUser ? (
            <AIWriter>{message.text}</AIWriter>
          ) : (
            message.text
          )}
        </div>
        {!message.text && message.thought && (
          <div>
            {isUser ? (
              message.thought
            ) : isLastMessage && !isUser ? (
              <AIWriter>
                <span className="italic text-muted-foreground">{message.thought}</span>
              </AIWriter>
            ) : (
              <span className="italic text-muted-foreground">{message.thought}</span>
            )}
          </div>
        )}

        {message.attachments?.map((attachment: IAttachment) => (
          <div className="flex flex-col gap-1" key={`${attachment.url}-${attachment.title}`}>
            <img
              alt="attachment"
              src={attachment.url}
              width="100%"
              height="100%"
              className="w-64 rounded-md"
            />
            <div className="flex items-center justify-between gap-4">
              <span />
              <span />
            </div>
          </div>
        ))}
        {message.text && message.createdAt && (
          <ChatBubbleTimestamp timestamp={moment(message.createdAt).format('LT')} />
        )}
      </ChatBubbleMessage>
      {!isUser && (
        <div className="flex justify-between items-end w-full">
          <div>
            {message.text && !message.isLoading ? (
              <div className="flex items-center gap-2">
                <CopyButton text={message.text} />
                <ChatTtsButton agentId={message.agentId} text={message.text} />
              </div>
            ) : (
              <div />
            )}
          </div>
          <div>
            {message.text && message.actions && (
              <Badge variant="outline" className="text-sm">
                {message.actions}
              </Badge>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page({ serverId }: { serverId: UUID }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const worldId = WorldManager.getWorldId();

  const { data: roomsData } = useRooms();
  const entityId = getEntityId();

  const { data: messages = [] } = useGroupMessages(serverId, GROUP_CHAT_SOURCE);

  const socketIOManager = SocketIOManager.getInstance();

  const { data: { data: agentsData } = {}, isLoading, isError } = useAgents();
  const agents = agentsData?.agents || [];

  const prevServerIdRef = useRef<UUID | null>(null);
  const prevActiveAgentIdsRef = useRef<UUID[]>([]);

  const getAvatar = (agentId: string) => {
    const rooms = roomsData?.get(serverId);
    const agent = rooms?.find((room) => room.agentId === agentId);
    const character = agent?.character;
    return character?.settings?.avatar;
  };

  const getRoomThumbnail = () => {
    const rooms = roomsData?.get(serverId);
    if (rooms && rooms.length) {
      return rooms[0].metadata?.thumbnail;
    }

    return null;
  };

  const getRoomName = () => {
    const rooms = roomsData?.get(serverId);
    if (rooms && rooms.length) {
      return rooms[0].name;
    }

    return null;
  };

  useEffect(() => {
    if (isLoading || isError || !agents || !agents.length || !roomsData) {
      return;
    }
    let activeAgentIds: UUID[] = [];

    const roomDatas = roomsData.get(serverId);
    if (roomDatas) {
      for (const roomData of roomDatas) {
        const agentData = agents.find((agent) => agent.id === roomData.agentId);
        if (agentData) {
          if (agentData.status === AgentStatus.ACTIVE) {
            activeAgentIds.push(roomData.agentId as UUID);
          }
        }
      }
    }

    const isSameServer = prevServerIdRef.current === serverId;
    const isSameAgents =
      activeAgentIds.length === prevActiveAgentIdsRef.current.length &&
      activeAgentIds.every((id, index) => id === prevActiveAgentIdsRef.current[index]);

    if (isSameServer && isSameAgents) {
      return; // No changes, avoid reconnecting
    }

    // Update refs
    prevServerIdRef.current = serverId;
    prevActiveAgentIdsRef.current = activeAgentIds;

    socketIOManager.initialize(entityId, activeAgentIds);

    // Join the room for this agent
    socketIOManager.joinRoom(serverId);

    console.log(`[Chat] Joined room ${serverId} with entityId ${entityId}`);

    const handleMessageBroadcasting = (data: ContentWithUser) => {
      console.log(`[Chat] Received message broadcast:`, data);

      // Skip messages that don't have required content
      if (!data) {
        console.warn('[Chat] Received empty or invalid message data:', data);
        return;
      }

      // Skip messages not for this room
      if (data.roomId !== serverId) {
        console.log(
          `[Chat] Ignoring message for different room: ${data.roomId}, we're in ${serverId}`
        );
        return;
      }

      // Check if the message is from the current user or from the agent
      const isCurrentUser = data.senderId === entityId;

      // Build a proper ContentWithUser object that matches what the messages query expects
      const newMessage: ContentWithUser = {
        ...data,
        // Set the correct name based on who sent the message
        name: isCurrentUser ? USER_NAME : (data.senderName as string),
        createdAt: data.createdAt || Date.now(),
        isLoading: false,
      };

      console.log(`[Chat] Adding new message to UI from ${newMessage.name}:`, newMessage);

      // Update the message list without triggering a re-render cascade
      queryClient.setQueryData(
        ['groupmessages', serverId, worldId],
        (old: ContentWithUser[] = []) => {
          console.log(`[Chat] Current messages:`, old?.length || 0);

          // Check if this message is already in the list (avoid duplicates)
          const isDuplicate = old.some(
            (msg) =>
              msg.text === newMessage.text &&
              msg.name === newMessage.name &&
              Math.abs((msg.createdAt || 0) - (newMessage.createdAt || 0)) < 5000 // Within 5 seconds
          );

          if (isDuplicate) {
            console.log('[Chat] Skipping duplicate message');
            return old;
          }

          return [...old, newMessage];
        }
      );

      // Remove the redundant state update that was causing render loops
      // setInput(prev => prev + '');
    };

    // Add listener for message broadcasts
    console.log(`[Chat] Adding messageBroadcast listener`);
    socketIOManager.on('messageBroadcast', handleMessageBroadcasting);

    return () => {
      // When leaving this chat, leave the room but don't disconnect
      console.log(`[Chat] Leaving room ${serverId}`);
      socketIOManager.leaveRoom(serverId);
      socketIOManager.off('messageBroadcast', handleMessageBroadcasting);
      prevServerIdRef.current = null;
      prevActiveAgentIdsRef.current = [];
    };
  }, [isLoading, isError, agents, roomsData, serverId]);

  // Use a stable ID for refs to avoid excessive updates
  const scrollRefId = useRef(`scroll-${Math.random().toString(36).substring(2, 9)}`).current;

  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll({
    smooth: true,
  });

  // Use a ref to track the previous message count to avoid excessive scrolling
  const prevMessageCountRef = useRef(0);

  // Update scroll without creating a circular dependency
  const safeScrollToBottom = useCallback(() => {
    // Add a small delay to avoid render loops
    setTimeout(() => {
      scrollToBottom();
    }, 0);
  }, []);

  useEffect(() => {
    // Only scroll if the message count has changed
    if (messages.length !== prevMessageCountRef.current) {
      console.log(`[Chat][${scrollRefId}] Messages updated, scrolling to bottom`);
      safeScrollToBottom();
      prevMessageCountRef.current = messages.length;
    }
  }, [messages.length, safeScrollToBottom, scrollRefId]);

  useEffect(() => {
    safeScrollToBottom();
  }, [safeScrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  const handleSendMessage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input) return;

    // Always add the user's message immediately to the UI before sending it to the server
    const userMessage: ContentWithUser = {
      text: input,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: entityId,
      senderName: USER_NAME,
      roomId: serverId,
      source: GROUP_CHAT_SOURCE,
      id: crypto.randomUUID(), // Add a unique ID for React keys and duplicate detection
    };

    console.log('[Chat] Adding user message to UI:', userMessage);

    // Update the local message list first for immediate feedback
    queryClient.setQueryData(
      ['groupmessages', serverId, worldId],
      (old: ContentWithUser[] = []) => {
        // Check if exact same message exists already to prevent duplicates
        const exists = old.some(
          (msg) =>
            msg.text === userMessage.text &&
            msg.name === USER_NAME &&
            Math.abs((msg.createdAt || 0) - userMessage.createdAt) < 1000
        );

        if (exists) {
          console.log('[Chat] Skipping duplicate user message');
          return old;
        }

        return [...old, userMessage];
      }
    );

    // We don't need to call scrollToBottom here, the message count change will trigger it
    // via the useEffect hook

    // Send the message to the server/agent
    socketIOManager.sendMessage(input, serverId, GROUP_CHAT_SOURCE);

    setSelectedFile(null);
    setInput('');
    formRef.current?.reset();
  };

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file?.type.startsWith('image/')) {
      setSelectedFile(file);
    }
  };

  // Sort agents: enabled first, then disabled
  const sortedAgents = [...agents]
    .filter((agent) => roomsData?.get(serverId)?.some((room) => room.agentId === agent.id))
    .sort((a, b) => {
      // Sort by status (active agents first)
      if (a.status === AgentStatus.ACTIVE && b.status !== AgentStatus.ACTIVE) return -1;
      if (a.status !== AgentStatus.ACTIVE && b.status === AgentStatus.ACTIVE) return 1;
      // If both have the same status, sort alphabetically by name
      return a.name.localeCompare(b.name);
    });

  // Split into enabled and disabled groups
  const activeAgents = sortedAgents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.ACTIVE
  );
  const inactiveAgents = sortedAgents.filter(
    (agent: Partial<Agent & { status: string }>) => agent.status === AgentStatus.INACTIVE
  );

  return (
    <div className="flex">
      <div className="flex flex-col w-full h-screen p-4">
        {/* Agent Header */}
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <Avatar className="size-10 border rounded-full">
              <AvatarImage src={getRoomThumbnail() || '/elizaos-icon.png'} />
            </Avatar>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg">{getRoomName() || 'Group Chat'}</h2>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-row w-full overflow-y-auto grow gap-4">
          {/* Main Chat Area */}
          <div className={'flex flex-col transition-all duration-300 w-full'}>
            {/* Chat Messages */}
            <ChatMessageList
              scrollRef={scrollRef}
              isAtBottom={isAtBottom}
              scrollToBottom={safeScrollToBottom}
              disableAutoScroll={disableAutoScroll}
            >
              {messages.map((message: ContentWithUser, index: number) => {
                const isUser = message.name === USER_NAME;

                return (
                  <div
                    key={`${message.id as string}-${message.createdAt}`}
                    className={`flex flex-column gap-1 p-1 ${isUser ? 'justify-end' : ''}`}
                  >
                    <ChatBubble
                      variant={isUser ? 'sent' : 'received'}
                      className={`flex flex-row items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
                    >
                      {message.text && !isUser && (
                        <Avatar className="size-8 border rounded-full select-none mb-2">
                          <AvatarImage
                            src={
                              isUser
                                ? '/user-icon.png'
                                : getAvatar(message.agentId) ||
                                  getAvatar(message.senderId) ||
                                  '/elizaos-icon.png'
                            }
                          />
                        </Avatar>
                      )}

                      <MemoizedMessageContent
                        message={message}
                        isLastMessage={index === messages.length - 1}
                        isUser={isUser}
                      />
                    </ChatBubble>
                  </div>
                );
              })}
            </ChatMessageList>

            {/* Chat Input */}
            <div className="px-4 pb-4 mt-auto">
              <form
                ref={formRef}
                onSubmit={handleSendMessage}
                className="relative rounded-md border bg-card"
              >
                {selectedFile ? (
                  <div className="p-3 flex">
                    <div className="relative rounded-md border p-2">
                      <Button
                        onClick={() => setSelectedFile(null)}
                        className="absolute -right-2 -top-2 size-[22px] ring-2 ring-background"
                        variant="outline"
                        size="icon"
                      >
                        <X />
                      </Button>
                      <img
                        alt="Selected file"
                        src={URL.createObjectURL(selectedFile)}
                        height="100%"
                        width="100%"
                        className="aspect-square object-contain w-16"
                      />
                    </div>
                  </div>
                ) : null}
                <ChatInput
                  ref={inputRef}
                  onKeyDown={handleKeyDown}
                  value={input}
                  onChange={({ target }) => setInput(target.value)}
                  placeholder="Type your message here..."
                  className="min-h-12 resize-none rounded-md bg-card border-0 p-3 shadow-none focus-visible:ring-0"
                />
                <div className="flex items-center p-3 pt-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (fileInputRef.current) {
                              fileInputRef.current.click();
                            }
                          }}
                        >
                          <Paperclip className="size-4" />
                          <span className="sr-only">Attach file</span>
                        </Button>
                        <input
                          type="file"
                          ref={fileInputRef}
                          onChange={handleFileChange}
                          accept="image/*"
                          className="hidden"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>Attach file</p>
                    </TooltipContent>
                  </Tooltip>
                  <Button type="submit" size="sm" className="ml-auto gap-1.5 h-[30px]">
                    <Send className="size-3.5" />
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
      <AgentStatusSidebar
        onlineAgents={activeAgents}
        offlineAgents={inactiveAgents}
        isLoading={isLoading}
      />
    </div>
  );
}
