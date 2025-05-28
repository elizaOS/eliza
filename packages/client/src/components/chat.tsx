import MediaContent from '@/components/media-content';
import { Button } from '@/components/ui/button';
import {
  ChatBubble,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from '@/components/ui/chat/chat-bubble';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessageList } from '@/components/ui/chat/chat-message-list';
import { USER_NAME } from '@/constants';
import {
  useCentralChannelMessages,
  useDeleteCentralChannelMessage,
  useClearCentralChannelMessages,
  useAgent,
  type UiMessage,
} from '@/hooks/use-query-hooks';
import clientLogger from '@/lib/logger';
import { parseMediaFromText, removeMediaUrlsFromText } from '@/lib/media-utils';
import SocketIOManager from '@/lib/socketio-manager';
import { cn, getEntityId, moment, randomUUID } from '@/lib/utils';
import type { Agent, Content, Media, UUID, Room } from '@elizaos/core';
import {
  AgentStatus,
  ContentType as CoreContentType,
  ChannelType as CoreChannelType,
  validateUuid,
} from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';

import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  PanelRight,
  Paperclip,
  Send,
  Trash2,
  X,
  Loader2,
  FileText,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AIWriter from 'react-aiwriter';
import { AudioRecorder } from './audio-recorder';
import CopyButton from './copy-button';
import DeleteButton from './delete-button';
import { Badge } from './ui/badge';
import ChatTtsButton from './ui/chat/chat-tts-button';
import { useAutoScroll } from './ui/chat/hooks/useAutoScroll';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

import { CHAT_SOURCE } from '@/constants';
import { apiClient } from '@/lib/api';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import type {
  MessageCompleteData,
  ControlMessageData,
  MessageBroadcastData,
} from '@/lib/socketio-manager';
import { useToast } from '@/hooks/use-toast';
import { useParams, useSearchParams } from 'react-router-dom';

type ExtraContentFields = {
  name: string;
  createdAt: number;
  isLoading?: boolean;
};

type ContentWithUser = Content & ExtraContentFields;

type UploadingFile = {
  file: File;
  id: string;
  isUploading: boolean;
  uploadProgress?: number;
  error?: string;
};

const MemoizedMessageContent = React.memo(MessageContent);

function MessageContent({
  message,
  agentForTts,
  shouldAnimate,
  onDelete,
}: {
  message: UiMessage;
  agentForTts: Agent | Partial<Agent> | null;
  shouldAnimate: boolean;
  onDelete: (id: string) => void;
}) {
  const isUser = !message.isAgent;

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
          {(() => {
            if (!message.text) return null;

            // Parse media from message text
            const mediaInfos = parseMediaFromText(message.text);
            // Get URLs from attachments to avoid duplicates
            const attachmentUrls = new Set(
              message.attachments?.map((att) => att.url).filter(Boolean) || []
            );
            // Filter out media that's already in attachments
            const uniqueMediaInfos = mediaInfos.filter((media) => !attachmentUrls.has(media.url));
            const textWithoutUrls = removeMediaUrlsFromText(message.text, mediaInfos);

            return (
              <div className="space-y-3">
                {/* Display text content if there's any remaining after removing URLs */}
                {textWithoutUrls.trim() && (
                  <div>
                    {isUser ? (
                      textWithoutUrls
                    ) : shouldAnimate ? (
                      <AIWriter>{textWithoutUrls}</AIWriter>
                    ) : (
                      textWithoutUrls
                    )}
                  </div>
                )}

                {/* Display parsed media only if not already in attachments */}
                {uniqueMediaInfos.length > 0 && (
                  <div className="space-y-2">
                    {uniqueMediaInfos.map((media, index) => (
                      <div key={`${media.url}-${index}`}>
                        <MediaContent url={media.url} title="Shared media" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
        {!message.text &&
          message.thought &&
          (isUser ? (
            message.thought
          ) : shouldAnimate ? (
            <AIWriter>
              <span className="italic text-muted-foreground">{message.thought}</span>
            </AIWriter>
          ) : (
            <span className="italic text-muted-foreground">{message.thought}</span>
          ))}

        {message.attachments
          ?.filter((attachment) => attachment.url && attachment.url.trim() !== '')
          .map((attachment: Media) => (
            <MediaContent
              key={`${attachment.url}-${attachment.title}`}
              url={attachment.url}
              title={attachment.title || 'Attachment'}
            />
          ))}
        {message.text && message.createdAt && (
          <ChatBubbleTimestamp timestamp={moment(message.createdAt).format('LT')} />
        )}
      </ChatBubbleMessage>
      <div className="flex justify-between items-end w-full">
        <div className="flex items-center gap-1">
          {!isUser && message.text && !message.isLoading && agentForTts?.id && (
            <>
              <CopyButton text={message.text} />
              <ChatTtsButton agentId={agentForTts.id} text={message.text} />
            </>
          )}
          <DeleteButton onClick={() => onDelete(message.id as string)} />
        </div>
        <div>
          {message.text && message.actions && (
            <Badge variant="outline" className="text-sm">
              {Array.isArray(message.actions) ? message.actions.join(', ') : message.actions}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DMPage() {
  const { channelId: channelIdFromPath } = useParams<{ channelId: string }>();
  const [searchParams] = useSearchParams();
  const agentIdFromQuery = searchParams.get('agentId');
  const serverIdFromQuery = searchParams.get('serverId');

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentClientEntityId = getEntityId();

  // Use resolved IDs for hooks
  const channelId = channelIdFromPath ? validateUuid(channelIdFromPath) : undefined;
  const targetAgentId = agentIdFromQuery ? validateUuid(agentIdFromQuery) : undefined;
  const serverId = serverIdFromQuery ? validateUuid(serverIdFromQuery) : undefined;

  const { data: agentDataWrapper, isLoading: isLoadingAgentData } = useAgent(targetAgentId, {
    enabled: !!targetAgentId,
  });
  const targetAgentData = agentDataWrapper?.data;

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCentralChannelMessages(channelId, serverId);

  const [selectedFiles, setSelectedFiles] = useState<UploadingFile[]>([]);
  const [input, setInput] = useState('');
  const [inputDisabled, setInputDisabled] = useState<boolean>(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const { mutate: deleteMessageCentral } = useDeleteCentralChannelMessage();
  const { mutate: clearMessagesCentral } = useClearCentralChannelMessages();

  const socketIOManager = SocketIOManager.getInstance();
  const animatedMessageIdRef = useRef<string | null>(null);

  // Show details state (assuming passed from a layout or managed differently for DMs)
  // For simplicity, let's assume it's not a feature of this direct DM page for now.
  const [showDetails, setShowDetails] = useState(false);
  const toggleDetails = () => setShowDetails((prev) => !prev);

  useEffect(() => {
    if (!channelId || !currentClientEntityId) return;
    socketIOManager.initialize(currentClientEntityId);
    socketIOManager.joinRoom(channelId);
    clientLogger.info(`[DMPage] Joined DM channel ${channelId} as user ${currentClientEntityId}`);

    const handleMessageBroadcasting = (data: MessageBroadcastData) => {
      if (data.roomId !== channelId) return;
      const isCurrentUser = data.senderId === currentClientEntityId;
      const isTargetAgent = data.senderId === targetAgentId;
      if (!isCurrentUser && isTargetAgent) setInputDisabled(false);

      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) => {
        const messageExists = old.some((m) => m.id === data.id);
        if (messageExists) return old;
        const newUiMsg: UiMessage = {
          id: data.id || randomUUID(),
          text: data.text,
          name: data.senderName,
          senderId: data.senderId as UUID,
          isAgent: isTargetAgent, // In a DM, non-user message is from the targetAgent
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
        if (isTargetAgent && newUiMsg.id) animatedMessageIdRef.current = newUiMsg.id;
        else animatedMessageIdRef.current = null;
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
      (d: MessageBroadcastData) => d.roomId === channelId,
      handleMessageBroadcasting
    );
    const completeSub = socketIOManager.evtMessageComplete.attach(
      (d: MessageCompleteData) => d.roomId === channelId,
      handleMessageComplete
    );
    const controlSub = socketIOManager.evtControlMessage.attach(
      (d: ControlMessageData) => d.roomId === channelId,
      handleControlMessage
    );

    return () => {
      if (channelId) socketIOManager.leaveRoom(channelId);
      msgSub?.detach();
      completeSub?.detach();
      controlSub?.detach();
    };
  }, [channelId, currentClientEntityId, queryClient, socketIOManager, targetAgentId]);

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

  const getContentTypeFromMimeType = (mimeType: string): CoreContentType | undefined => {
    if (mimeType.startsWith('image/')) return CoreContentType.IMAGE;
    if (mimeType.startsWith('video/')) return CoreContentType.VIDEO;
    if (mimeType.startsWith('audio/')) return CoreContentType.AUDIO;
    if (mimeType.includes('pdf') || mimeType.includes('document')) return CoreContentType.DOCUMENT;
    return undefined;
  };

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      (!input.trim() && selectedFiles.length === 0) ||
      inputDisabled ||
      !channelId ||
      !serverId ||
      !currentClientEntityId ||
      !targetAgentData?.id
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
      source: CHAT_SOURCE,
      attachments: selectedFiles
        .map((sf) => ({
          id: sf.id,
          url: URL.createObjectURL(sf.file),
          title: sf.file.name,
          contentType: getContentTypeFromMimeType(sf.file.type),
        }))
        .filter((att) => att.contentType !== undefined) as Media[],
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
    formRef.current?.reset();

    try {
      if (selectedFiles.length > 0) {
        const currentUploads = selectedFiles.map((sf) => ({ ...sf, isUploading: true }));
        setSelectedFiles(currentUploads.map((f) => ({ ...f, isUploading: true })));

        const uploadPromises = currentUploads.map(async (fileData) => {
          try {
            const uploadResult = await apiClient.uploadAgentMedia(
              targetAgentData.id!,
              fileData.file
            );
            if (uploadResult.success) {
              return {
                id: fileData.id,
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
        setSelectedFiles((prev) => prev.filter((f) => !uiAttachments.find((up) => up.id === f.id)));
        if (!messageText && uiAttachments.length > 0) {
          messageText = `Shared ${uiAttachments.length} file(s).`;
        }
      }

      const mediaInfosFromText = parseMediaFromText(messageText || currentInputVal);
      const textMediaAttachments: Media[] = mediaInfosFromText.map(
        (media: ParsedMediaInfo, index: number): Media => ({
          id: `media-${tempMessageId}-${index}`,
          url: media.url,
          title: media.type === 'image' ? 'Image' : 'Video',
          source: 'user_input_url',
          contentType: media.type === 'image' ? CoreContentType.IMAGE : CoreContentType.VIDEO,
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
        );
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
        source_type: CHAT_SOURCE,
      });

      queryClient.setQueryData<UiMessage[]>(['messages', channelId], (old = []) =>
        old.map((m) => {
          if (m.id === tempMessageId) {
            const serverResponseData = response.data;
            const isAgentResp = serverResponseData.authorId === targetAgentId;
            return {
              id: serverResponseData.id,
              text: serverResponseData.content,
              name: isAgentResp
                ? targetAgentData?.name || serverResponseData.metadata?.agentName || 'Agent'
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
      clientLogger.error('Error sending message or uploading files:', error);
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
      setSelectedFiles((prev) => prev.filter((f) => f.isUploading));
      formRef.current?.reset();
      inputRef.current?.focus();
    }
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
      return Array.from(
        new Map(combined.map((f) => [`${f.file.name}-${f.file.size}`, f])).values()
      );
    });
    if (e.target) e.target.value = '';
  };

  const removeFile = (fileId: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!channelId) return;
    deleteMessageCentral({ channelId, messageId: messageId as UUID });
  };

  const handleClearChat = () => {
    if (!channelId) return;
    if (window.confirm('Clear all messages in this chat?')) {
      clearMessagesCentral(channelId);
    }
  };

  if (isLoadingAgentData || (!targetAgentData && targetAgentId)) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading agent details...</p>
      </div>
    );
  }
  if (!channelId || !serverId || !targetAgentData) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading chat context...</p>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col w-full h-screen items-center ${showDetails ? 'col-span-3' : 'col-span-4'}`}
    >
      <div className="flex flex-col w-full md:max-w-4xl h-full p-4">
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <Avatar className="size-10 border rounded-full">
              <AvatarImage src={targetAgentData?.settings?.avatar || '/elizaos-icon.png'} />
            </Avatar>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg">{targetAgentData?.name || 'Agent'}</h2>
                {targetAgentData?.status === AgentStatus.ACTIVE ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="size-2.5 rounded-full bg-green-500 ring-2 ring-green-500/20 animate-pulse" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>Agent is active</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="size-2.5 rounded-full bg-gray-300 ring-2 ring-gray-300/20" />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>Agent is inactive</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              {targetAgentData?.bio && (
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {Array.isArray(targetAgentData.bio)
                    ? targetAgentData.bio[0]
                    : targetAgentData.bio}
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearChat}
              disabled={!messages || messages.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
            {/* <Button variant="outline" size="sm" onClick={toggleDetails} className={cn('gap-1.5', showDetails && 'bg-secondary')}>
              <PanelRight className="size-4" />
            </Button> */}
          </div>
        </div>

        <div
          className={cn('flex flex-col transition-all duration-300 w-full grow overflow-hidden ')}
        >
          <ChatMessageList
            scrollRef={scrollRef}
            isAtBottom={isAtBottom}
            scrollToBottom={safeScrollToBottom}
            disableAutoScroll={disableAutoScroll}
            className="flex-grow scrollbar-hide overflow-y-auto"
            onScrollUp={fetchNextPage}
            isLoadingMore={isFetchingNextPage}
          >
            {isLoadingMessages && messages.length === 0 && (
              <div className="flex flex-1 justify-center items-center">
                <p>Loading messages...</p>
              </div>
            )}
            {!isLoadingMessages && messages.length === 0 && (
              <div className="flex flex-1 justify-center items-center">
                <p>No messages yet. Start the conversation!</p>
              </div>
            )}
            {messages.map((message: UiMessage, index: number) => {
              const isUser = !message.isAgent;
              const shouldAnimate =
                index === messages.length - 1 &&
                message.isAgent &&
                message.id === animatedMessageIdRef.current;
              return (
                <div
                  key={`${message.id}-${message.createdAt}`}
                  className={cn(
                    'flex flex-col gap-1 p-1',
                    isUser ? 'justify-end' : 'justify-start'
                  )}
                >
                  <ChatBubble
                    variant={isUser ? 'sent' : 'received'}
                    className={`flex flex-row items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
                  >
                    {!isUser && (
                      <Avatar className="size-8 border rounded-full select-none mb-2">
                        <AvatarImage
                          src={targetAgentData?.settings?.avatar || '/elizaos-icon.png'}
                        />
                      </Avatar>
                    )}
                    <MemoizedMessageContent
                      message={message}
                      agentForTts={targetAgentData}
                      shouldAnimate={shouldAnimate}
                      onDelete={() => handleDeleteMessage(message.id as string)}
                    />
                  </ChatBubble>
                </div>
              );
            })}
          </ChatMessageList>

          <div className="px-4 pb-4 mt-auto flex-shrink-0">
            {inputDisabled && (
              <div className="px-2 pb-2 text-sm text-muted-foreground flex items-center gap-2">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:0ms]"></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:150ms]"></div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:300ms]"></div>
                </div>
                <span>{targetAgentData.name} is thinking</span>
                <div className="flex">
                  <span className="animate-pulse [animation-delay:0ms]">.</span>
                  <span className="animate-pulse [animation-delay:200ms]">.</span>
                  <span className="animate-pulse [animation-delay:400ms]">.</span>
                </div>
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
                        onClick={() => removeFile(fileData.id)}
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
                placeholder={
                  inputDisabled
                    ? `${targetAgentData.name} is thinking...`
                    : 'Type your message here...'
                }
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
                        accept="image/*,video/*,.pdf,.doc,.docx,.txt,.rtf,.xls,.xlsx,.ppt,.pptx,.csv"
                        multiple
                        className="hidden"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>Attach files</p>
                  </TooltipContent>
                </Tooltip>
                {targetAgentData?.id && (
                  <AudioRecorder
                    agentId={targetAgentData.id}
                    onChange={(newInput: string) => setInput(newInput)}
                  />
                )}
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
  );
}
