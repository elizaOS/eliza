import { Button } from '@/components/ui/button';
import {
  ChatBubble,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from '@/components/ui/chat/chat-bubble';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessageList } from '@/components/ui/chat/chat-message-list';
import { GROUP_CHAT_SOURCE, USER_NAME } from '@/constants';
import {
  useAgentsWithDetails,
  useCentralChannelMessages,
  useDeleteCentralChannelMessage,
  useClearCentralChannelMessages,
  useCentralChannelDetails,
  useCentralChannelParticipants,
} from '@/hooks/use-query-hooks';
import SocketIOManager from '@/lib/socketio-manager';
import { getEntityId, moment, randomUUID } from '@/lib/utils';
import type { Agent, Content, UUID, Media } from '@elizaos/core';
import {
  AgentStatus as CoreAgentStatus,
  ChannelType as CoreChannelType,
  ContentType,
} from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Edit, Paperclip, Send, X, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import AIWriter from 'react-aiwriter';
import clientLogger from '../lib/logger';
import AgentAvatarStack from './agent-avatar-stack';
import { Avatar, AvatarImage } from './ui/avatar';
import { Badge } from './ui/badge';
import ChatTtsButton from './ui/chat/chat-tts-button';
import { useAutoScroll } from './ui/chat/hooks/useAutoScroll';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { UiMessage } from '@/hooks/use-query-hooks';
import type {
  MessageCompleteData,
  ControlMessageData,
  MessageBroadcastData,
} from '@/lib/socketio-manager';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import {
  parseMediaFromText,
  removeMediaUrlsFromText,
  type ParsedMediaInfo,
} from '@/lib/media-utils';

interface UploadingFile {
  file: File;
  id: string;
  isUploading: boolean;
  uploadProgress?: number;
  error?: string;
}

// Local definition for ParsedMediaInfo
interface ParsedMediaInfo {
  url: string;
  type: 'image' | 'video' | 'unknown';
}

const MemoizedMessageContent = React.memo(MessageContent);

function MessageContent({
  message,
  isUser,
  agentAvatarMap,
  getAgentInMessage,
}: {
  message: UiMessage;
  isUser: boolean;
  agentAvatarMap: Record<UUID, string | null>;
  getAgentInMessage: (agentId: UUID) => Partial<Agent> | undefined;
}) {
  const agentData = !isUser ? getAgentInMessage(message.senderId) : undefined;

  return (
    <div className="flex flex-col w-full">
      <ChatBubbleMessage
        isLoading={message.isLoading}
        {...(isUser ? { variant: 'sent' } : {})}
        {...(!message.text && !message.attachments?.length ? { className: 'bg-transparent' } : {})}
      >
        {!isUser && agentData && (
          <div className="w-full">
            {message.text && message.thought && (
              <Collapsible className="mb-1">
                <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors group">
                  <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
                  {agentData.name || 'Agent'}'s Thought Process
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
        {message.text && (
          <div className="py-2">{isUser ? message.text : <AIWriter>{message.text}</AIWriter>}</div>
        )}
        {message.attachments?.map((attachment: Media) => (
          <div key={attachment.id || attachment.url} className="my-1 p-2 border rounded-md">
            <p className="text-xs font-semibold truncate">{attachment.title || attachment.url}</p>
            {attachment.contentType === ContentType.IMAGE && attachment.url && (
              <img
                src={attachment.url}
                alt={attachment.title || 'image attachment'}
                className="max-w-xs max-h-xs rounded mt-1"
              />
            )}
            {attachment.contentType === ContentType.VIDEO && attachment.url && (
              <video src={attachment.url} controls className="max-w-xs rounded mt-1" />
            )}
            {attachment.contentType === ContentType.AUDIO && attachment.url && (
              <audio src={attachment.url} controls className="w-full mt-1" />
            )}
            {attachment.url &&
              (attachment.contentType === ContentType.DOCUMENT || !attachment.contentType) && (
                <a
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline text-sm"
                >
                  Download {attachment.title || 'document'}
                </a>
              )}
            {attachment.text && (
              <p className="text-xs text-muted-foreground mt-1 Dtruncate">{attachment.text}</p>
            )}
          </div>
        ))}
        {(message.text || message.attachments?.length) && message.createdAt && (
          <ChatBubbleTimestamp timestamp={moment(message.createdAt).format('LT')} />
        )}
      </ChatBubbleMessage>
      {!isUser && (
        <div className="flex justify-between items-end w-full">
          <div>
            {message.text && !message.isLoading && agentData?.id && (
              <ChatTtsButton
                agentId={agentData.id}
                text={typeof message.text === 'string' ? message.text : ''}
              />
            )}
          </div>
          {message.actions && message.actions.length > 0 && (
            <Badge variant="outline" className="text-sm">
              {Array.isArray(message.actions) ? message.actions.join(', ') : message.actions}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

export default function GroupChatPage({
  channelId,
  serverId,
}: {
  channelId: UUID;
  serverId: UUID;
}) {
  const [selectedFiles, setSelectedFiles] = useState<UploadingFile[]>([]);
  const [input, setInput] = useState('');
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [inputDisabled, setInputDisabled] = useState<boolean>(false);
  const { toast } = useToast();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();

  const { mutate: deleteMessageCentral } = useDeleteCentralChannelMessage();
  const { mutate: clearMessagesCentral } = useClearCentralChannelMessages();

  const currentClientEntityId = getEntityId();

  const { data: channelDetailsData } = useCentralChannelDetails(channelId);
  const { data: participantsData } = useCentralChannelParticipants(channelId);
  const participants = participantsData?.data;

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCentralChannelMessages(channelId, serverId);

  const socketIOManager = SocketIOManager.getInstance();
  const animatedMessageIdRef = useRef<string | null>(null);

  const { data: agentsResponse } = useAgentsWithDetails();
  const allAgents = agentsResponse?.agents || [];

  const agentAvatarMap = useMemo(
    () =>
      allAgents.reduce(
        (acc, agent) => {
          if (agent.id && agent.settings?.avatar) acc[agent.id] = agent.settings.avatar;
          return acc;
        },
        {} as Record<UUID, string | null>
      ),
    [allAgents]
  );

  const getAgentInMessage = useCallback(
    (agentId: UUID) => {
      return allAgents.find((a) => a.id === agentId);
    },
    [allAgents]
  );

  const roomParticipantAgents = useMemo(() => {
    if (!participants || !allAgents.length) return [];
    return allAgents.filter((agent) => agent.id && participants.includes(agent.id));
  }, [participants, allAgents]);

  useEffect(() => {
    if (!channelId || !currentClientEntityId) return;
    socketIOManager.initialize(currentClientEntityId);
    socketIOManager.joinRoom(channelId);
    clientLogger.info(
      `[GroupChatPage] Joined central channel ${channelId} as user ${currentClientEntityId}`
    );

    const handleMessageBroadcasting = (data: MessageBroadcastData) => {
      clientLogger.info('[GroupChatPage] Received message broadcast:', data);
      if (data.roomId !== channelId) {
        clientLogger.info(`[GroupChatPage] Ignoring message for different channel: ${data.roomId}`);
        return;
      }
      const isCurrentUser = data.senderId === currentClientEntityId;
      // Determine if sender is an agent based on presence in allAgents list
      const isAgentSender = allAgents.some((a) => a.id === data.senderId);

      if (isAgentSender && !isCurrentUser) {
        // Message from an agent, not self
        setInputDisabled(false);
      }
      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) => {
        const messageExists = old.some((m) => m.id === data.id);
        if (messageExists) return old;

        const newUiMsg: UiMessage = {
          id: data.id || randomUUID(),
          text: data.text,
          name: data.senderName, // This is display name from server
          senderId: data.senderId as UUID,
          isAgent: isAgentSender,
          createdAt: data.createdAt,
          channelId: data.roomId as UUID,
          serverId: data.serverId as UUID | undefined,
          source: data.source,
          attachments: data.attachments,
          thought: data.thought,
          actions: data.actions,
          isLoading: false,
        };
        const newMessages = [...old, newUiMsg].sort((a, b) => a.createdAt - b.createdAt);
        if (isAgentSender && newUiMsg.id && !isCurrentUser) {
          animatedMessageIdRef.current = newUiMsg.id;
        } else {
          animatedMessageIdRef.current = null;
        }
        return newMessages;
      });
    };

    const handleMessageComplete = (data: MessageCompleteData) => {
      if (data.roomId === channelId) setInputDisabled(false);
    };
    const handleControlMessage = (data: ControlMessageData) => {
      if (data.roomId === channelId) {
        if (data.action === 'disable_input') setInputDisabled(true);
        else if (data.action === 'enable_input') setInputDisabled(false);
      }
    };

    const msgSub = socketIOManager.evtMessageBroadcast.attach(
      (data: MessageBroadcastData) => data.roomId === channelId,
      handleMessageBroadcasting
    );
    const completeSub = socketIOManager.evtMessageComplete.attach(
      (data: MessageCompleteData) => data.roomId === channelId,
      handleMessageComplete
    );
    const controlSub = socketIOManager.evtControlMessage.attach(
      (data: ControlMessageData) => data.roomId === channelId,
      handleControlMessage
    );

    return () => {
      clientLogger.info(`[GroupChatPage] Leaving central channel ${channelId}`);
      socketIOManager.leaveRoom(channelId);
      msgSub?.detach();
      completeSub?.detach();
      controlSub?.detach();
    };
  }, [channelId, currentClientEntityId, queryClient, socketIOManager, allAgents]);

  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll({
    smooth: true,
  });
  const prevMessageCountRef = useRef(0);
  const safeScrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollToBottom();
    }, 0);
  }, [scrollToBottom]);

  useEffect(() => {
    if (messages.length !== prevMessageCountRef.current) {
      safeScrollToBottom();
      prevMessageCountRef.current = messages.length;
    }
  }, [messages.length, safeScrollToBottom]);

  useEffect(() => {
    safeScrollToBottom();
  }, [safeScrollToBottom]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      (!input.trim() && selectedFiles.length === 0) ||
      inputDisabled ||
      !channelId ||
      !serverId ||
      !currentClientEntityId
    )
      return;

    setInputDisabled(true);
    const tempMessageId = randomUUID() as UUID;
    let messageText = input.trim();
    let uiAttachments: Media[] = [];

    const optimisticUiMessage: UiMessage = {
      id: tempMessageId,
      text: messageText,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: currentClientEntityId,
      isAgent: false,
      isLoading: true,
      channelId: channelId,
      serverId: serverId,
      source: GROUP_CHAT_SOURCE,
      attachments: selectedFiles.map((sf) => ({
        id: sf.id,
        url: URL.createObjectURL(sf.file),
        title: sf.file.name,
        contentType: getContentTypeFromMimeType(sf.file.type),
      })),
    };
    if (messageText || selectedFiles.length > 0) {
      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) => [
        ...old,
        optimisticUiMessage,
      ]);
    }
    safeScrollToBottom();
    const currentInputVal = input;
    setInput('');
    // Keep selectedFiles for upload, clear after success/fail
    // formRef.current?.reset(); // This would clear file input too early

    try {
      if (selectedFiles.length > 0) {
        const currentUploads = selectedFiles.map((sf) => ({ ...sf, isUploading: true }));
        // Update state for UI to show loading spinners for these files
        setSelectedFiles(currentUploads.map((f) => ({ ...f, isUploading: true })));

        const uploadPromises = currentUploads.map(async (fileData) => {
          try {
            // For group chats, uploads might be generic or associated with the current user, not a specific agent.
            // This might need a general media upload endpoint if not tied to an agent.
            // Assuming a primary agent for the group for now, or this needs adjustment.
            const primaryAgentInGroup =
              roomParticipantAgents.find((agent) => agent.status === CoreAgentStatus.ACTIVE) ||
              roomParticipantAgents[0];
            const agentIdForUpload =
              primaryAgentInGroup?.id ||
              allAgents.find((a) => a.status === CoreAgentStatus.ACTIVE)?.id; // Fallback to any active agent

            if (!agentIdForUpload) {
              throw new Error('No active agent available in group for media upload context.');
            }

            const uploadResult = await apiClient.uploadAgentMedia(agentIdForUpload, fileData.file);
            if (uploadResult.success) {
              return {
                id: fileData.id, // Use the UploadingFile id
                url: uploadResult.data.url,
                title: fileData.file.name,
                source: 'file_upload',
                contentType: getContentTypeFromMimeType(fileData.file.type),
              } as Media;
            } else {
              throw new Error(`Upload failed for ${fileData.file.name}`);
            }
          } catch (uploadError) {
            clientLogger.error(`Failed to upload ${fileData.file.name}:`, uploadError);
            setSelectedFiles((prev) =>
              prev.map((f) =>
                f.id === fileData.id ? { ...f, isUploading: false, error: 'Upload failed' } : f
              )
            );
            throw uploadError;
          }
        });
        uiAttachments = await Promise.all(uploadPromises);
        setSelectedFiles((prev) => prev.filter((f) => !uiAttachments.find((up) => up.id === f.id))); // Remove successfully uploaded files
        if (!messageText && uiAttachments.length > 0) {
          messageText = `Shared ${uiAttachments.length} file(s).`;
        }
      }

      const mediaInfosFromText: ParsedMediaInfo[] = parseMediaFromText(
        messageText || currentInputVal
      );
      const textMediaAttachments: Media[] = mediaInfosFromText.map(
        (media: ParsedMediaInfo, index: number): Media => ({
          id: `media-${tempMessageId}-${index}`,
          url: media.url,
          title: media.type === 'image' ? 'Image' : 'Video',
          source: 'user_input_url',
          contentType: media.type === 'image' ? ContentType.IMAGE : ContentType.VIDEO,
        })
      );

      const finalAttachments = [...uiAttachments, ...textMediaAttachments];
      const finalText =
        messageText ||
        (finalAttachments.length > 0 ? `Shared ${finalAttachments.length} item(s)` : '') ||
        currentInputVal;

      if (!finalText && finalAttachments.length === 0) {
        clientLogger.warn('Attempted to send an empty message.');
        setInputDisabled(false);
        queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) =>
          old.filter((m) => m.id !== tempMessageId)
        ); // Remove optimistic
        return;
      }

      const response = await apiClient.postMessageToCentralChannel(channelId, {
        author_id: currentClientEntityId,
        content: finalText,
        server_id: serverId,
        metadata: {
          attachments: finalAttachments.length > 0 ? finalAttachments : undefined,
          user_display_name: USER_NAME,
        },
        source_type: GROUP_CHAT_SOURCE,
      });

      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) =>
        old.map((m) => {
          if (m.id === tempMessageId) {
            const serverResponseData = response.data;
            const isAgentResp =
              allAgents.some((a) => a.id === serverResponseData.authorId) &&
              serverResponseData.authorId !== currentClientEntityId;
            return {
              id: serverResponseData.id,
              text: serverResponseData.content,
              name: isAgentResp
                ? serverResponseData.metadata?.agentName ||
                  serverResponseData.metadata?.authorDisplayName ||
                  'Agent'
                : USER_NAME,
              senderId: serverResponseData.authorId,
              isAgent: isAgentResp,
              createdAt: serverResponseData.createdAt,
              attachments: serverResponseData.metadata?.attachments as Media[] | undefined,
              thought: isAgentResp ? serverResponseData.metadata?.thought : undefined,
              actions: isAgentResp
                ? (serverResponseData.metadata?.actions as string[] | undefined)
                : undefined,
              channelId: serverResponseData.channelId,
              serverId: serverResponseData.metadata?.serverId || serverId,
              source: serverResponseData.sourceType,
              isLoading: false,
            } as UiMessage;
          }
          return m;
        })
      );
    } catch (error) {
      clientLogger.error('Error sending group message:', error);
      toast({
        title: 'Error Sending Message',
        description: error instanceof Error ? error.message : 'Could not send message.',
        variant: 'destructive',
      });
      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) =>
        old.map((m) =>
          m.id === tempMessageId
            ? { ...m, isLoading: false, text: `${m.text || 'Attachment'} (Failed to send)` }
            : m
        )
      );
    } finally {
      setInputDisabled(false);
      formRef.current?.reset(); // Reset form, which should clear file input visually
      setSelectedFiles((prev) => prev.filter((f) => f.isUploading)); // Clear any files that were in uploading state but might have failed silently
      inputRef.current?.focus();
    }
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!channelId) return;
    deleteMessageCentral({ channelId, messageId: messageId as UUID });
  };

  const handleClearChat = () => {
    if (!channelId) return;
    if (window.confirm('Clear all messages in this group chat?')) {
      clearMessagesCentral(channelId);
    }
  };

  const getContentTypeFromMimeType = (mimeType: string): ContentType | undefined => {
    if (mimeType.startsWith('image/')) return ContentType.IMAGE;
    if (mimeType.startsWith('video/')) return ContentType.VIDEO;
    if (mimeType.startsWith('audio/')) return ContentType.AUDIO;
    if (mimeType.includes('pdf') || mimeType.includes('document')) return ContentType.DOCUMENT;
    return undefined;
  };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const newUploadingFiles: UploadingFile[] = files.map((file) => ({
      file,
      id: randomUUID(),
      isUploading: false,
    }));
    setSelectedFiles((prev) => {
      const combined = [...prev, ...newUploadingFiles];
      // Filter out duplicates by file name and size (simple check)
      return Array.from(
        new Map(combined.map((f) => [`${f.file.name}-${f.file.size}`, f])).values()
      );
    });
    if (e.target) e.target.value = '';
  };

  if (
    !channelId ||
    !serverId ||
    (isLoadingMessages && messages.length === 0 && !channelDetailsData?.data)
  ) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading group chat...</p>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <div className="flex flex-col w-full h-screen p-4">
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <AgentAvatarStack
              agentIds={roomParticipantAgents.map((a) => a.id!)}
              agentAvatars={agentAvatarMap}
              agentNames={roomParticipantAgents.map((a) => a.name)}
              size="md"
            />
            <div className="flex flex-col">
              <h2 className="font-semibold text-lg">
                {channelDetailsData?.data?.name || 'Group Chat'}
              </h2>
            </div>
          </div>
          <div className="flex gap-2 ml-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClearChat}
              disabled={messages.length === 0}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            {/* GroupPanel for editing central channel details - TBD */}
            {/* <Button variant="ghost" size="icon" onClick={() => setShowGroupPanel(true)}>
              <Edit className="h-4 w-4" />
            </Button> */}
          </div>
        </div>

        <div className="flex flex-row w-full overflow-y-auto grow gap-4">
          <div className={'flex flex-col transition-all duration-300 w-full'}>
            <ChatMessageList
              scrollRef={scrollRef}
              isAtBottom={isAtBottom}
              scrollToBottom={safeScrollToBottom}
              disableAutoScroll={disableAutoScroll}
              className="flex-grow scrollbar-hide overflow-y-auto"
            >
              {isLoadingMessages && messages.length === 0 && (
                <div className="flex flex-1 justify-center items-center">
                  <p>Loading messages...</p>
                </div>
              )}
              {!isLoadingMessages && messages.length === 0 && (
                <div className="flex flex-1 justify-center items-center">
                  <p>No messages in this group yet. Start the conversation!</p>
                </div>
              )}
              {messages.map((message: UiMessage, index: number) => {
                const isUser = message.senderId === currentClientEntityId;
                const shouldAnimate =
                  index === messages.length - 1 &&
                  message.isAgent &&
                  message.id === animatedMessageIdRef.current;
                const senderAgent = !isUser ? getAgentInMessage(message.senderId) : undefined;
                return (
                  <div
                    key={`${message.id}-${message.createdAt}`}
                    className={`flex flex-col gap-1 p-1 ${isUser ? 'justify-end' : ''}`}
                  >
                    <ChatBubble
                      variant={isUser ? 'sent' : 'received'}
                      className={`flex flex-row items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
                    >
                      {!isUser && (
                        <Avatar className="size-8 border rounded-full select-none mb-2">
                          <AvatarImage
                            src={
                              senderAgent?.settings?.avatar ||
                              agentAvatarMap[message.senderId] ||
                              '/elizaos-icon.png'
                            }
                          />
                        </Avatar>
                      )}
                      <MemoizedMessageContent
                        message={message}
                        isUser={isUser}
                        agentAvatarMap={agentAvatarMap}
                        getAgentInMessage={getAgentInMessage}
                      />
                    </ChatBubble>
                    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteMessage(message.id as string)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </ChatMessageList>

            <div className="px-4 pb-4 mt-auto flex-shrink-0">
              {inputDisabled && (
                <div className="px-2 pb-2 text-sm text-muted-foreground flex items-center gap-2">
                  {/* ... thinking animation ... */}
                  <span>Agent is thinking...</span>
                </div>
              )}
              <form
                ref={formRef}
                onSubmit={handleSendMessage}
                className="relative rounded-md border bg-card"
              >
                {selectedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-3 p-3 pb-0">
                    {selectedFiles.map((fileData) => (
                      <div key={fileData.id} className="relative p-2">
                        <div className="relative w-16 h-16 rounded-lg overflow-hidden border bg-muted">
                          {fileData.isUploading && (
                            <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-10">
                              <Loader2 className="h-4 w-4 animate-spin text-white" />
                            </div>
                          )}
                          {fileData.file.type.startsWith('image/') ? (
                            <img
                              alt="Selected file"
                              src={URL.createObjectURL(fileData.file)}
                              className="w-full h-full object-cover"
                            />
                          ) : fileData.file.type.startsWith('video/') ? (
                            <video
                              src={URL.createObjectURL(fileData.file)}
                              className="w-full h-full object-cover"
                              muted
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-muted">
                              <FileText className="h-8 w-8 text-muted-foreground" />
                            </div>
                          )}
                          {fileData.error && (
                            <div className="absolute bottom-0 left-0 right-0 bg-red-500 text-white text-xs p-1 text-center">
                              Error
                            </div>
                          )}
                        </div>
                        <Button
                          onClick={() =>
                            setSelectedFiles((prev) => prev.filter((f) => f.id !== fileData.id))
                          }
                          className="absolute -right-1 -top-1 size-[20px] ring-2 ring-background z-20"
                          variant="outline"
                          size="icon"
                          disabled={fileData.isUploading}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                        <div className="text-xs text-center mt-1 truncate w-16">
                          {fileData.file.name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <ChatInput
                  ref={inputRef}
                  onKeyDown={handleKeyDown}
                  value={input}
                  onChange={({ target }) => setInput(target.value)}
                  placeholder={inputDisabled ? 'Agent is processing...' : 'Message group...'}
                  className="min-h-12 resize-none rounded-md bg-card border-0 p-3 shadow-none focus-visible:ring-0"
                  disabled={inputDisabled}
                />
                <div className="flex items-center p-3 pt-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (fileInputRef.current) fileInputRef.current.click();
                          }}
                        >
                          <Paperclip className="size-4" />
                          <span className="sr-only">Attach file</span>
                        </Button>
                        <input
                          type="file"
                          ref={fileInputRef}
                          onChange={handleFileChange}
                          accept="image/*,video/*,.pdf,.doc,.docx,.txt,.rtf"
                          multiple
                          className="hidden"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>Attach file</p>
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    disabled={inputDisabled || selectedFiles.some((f) => f.isUploading)}
                    type="submit"
                    size="sm"
                    className="ml-auto gap-1.5 h-[30px]"
                  >
                    {inputDisabled || selectedFiles.some((f) => f.isUploading) ? (
                      <div className="flex gap-0.5 items-center justify-center">
                        <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0s]" />
                        <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                        <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.4s]" />
                      </div>
                    ) : (
                      <Send className="size-3.5" />
                    )}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
      {/* {showGroupPanel && <GroupPanel agents={allAgents} onClose={() => setShowGroupPanel(false)} channelId={channelId} serverId={serverId} />} */}
    </div>
  );
}
