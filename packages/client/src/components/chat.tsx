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
import { useDeleteAllMemories, useDeleteMemory, useMessages } from '@/hooks/use-query-hooks';
import clientLogger from '@/lib/logger';
import { parseMediaFromText, removeMediaUrlsFromText } from '@/lib/media-utils';
import SocketIOManager from '@/lib/socketio-manager';
import { cn, getEntityId, moment, randomUUID } from '@/lib/utils';
import { WorldManager } from '@/lib/world-manager';
import type { Agent, Content, Media, UUID } from '@elizaos/core';
import { AgentStatus, ContentType } from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';

import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, PanelRight, Send, Trash2, X, Loader2, FileText, Image } from 'lucide-react';
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
  agentId,
  shouldAnimate,
  onDelete,
}: {
  message: ContentWithUser;
  agentId: UUID;
  shouldAnimate: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col w-full">
      <ChatBubbleMessage
        isLoading={message.isLoading}
        {...(message.name === USER_NAME ? { variant: 'sent' } : {})}
        {...(!message.text ? { className: 'bg-transparent' } : {})}
      >
        {message.name !== USER_NAME && (
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
                    {message.name === USER_NAME ? (
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
          (message.name === USER_NAME ? (
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
          {message.name !== USER_NAME && message.text && !message.isLoading && (
            <>
              <CopyButton text={message.text} />
              <ChatTtsButton agentId={agentId} text={message.text} />
            </>
          )}
          <DeleteButton onClick={() => onDelete(message.id as string)} />
        </div>
        <div>
          {message.text && message.actions && (
            <Badge variant="outline" className="text-sm">
              {message.actions}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page({
  agentId,
  worldId,
  agentData,
  showDetails,
  toggleDetails,
}: {
  agentId: UUID;
  worldId: UUID;
  agentData: Agent;
  showDetails: boolean;
  toggleDetails: () => void;
}) {
  const [selectedFiles, setSelectedFiles] = useState<UploadingFile[]>([]);
  const [input, setInput] = useState('');
  const [inputDisabled, setInputDisabled] = useState<boolean>(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const deleteMemoryMutation = useDeleteMemory();
  const clearMemoriesMutation = useDeleteAllMemories();

  const entityId = getEntityId();
  const roomId = WorldManager.generateRoomId(agentId);

  const { data: messages = [] } = useMessages(agentId, roomId);

  const socketIOManager = SocketIOManager.getInstance();

  const animatedMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Initialize Socket.io connection once with our entity ID
    socketIOManager.initialize(entityId, [agentId]);

    // Join the room for this agent
    socketIOManager.joinRoom(roomId);

    setInputDisabled(false);

    console.log(`[Chat] Joined room ${roomId} with entityId ${entityId}`);

    const handleMessageBroadcasting = (data: ContentWithUser) => {
      console.log('[Chat] Received message broadcast:', data);

      // Skip messages that don't have required content
      if (!data) {
        console.warn('[Chat] Received empty or invalid message data:', data);
        return;
      }

      // Skip messages not for this room
      if (data.roomId !== roomId) {
        console.log(
          `[Chat] Ignoring message for different room: ${data.roomId}, we're in ${roomId}`
        );
        return;
      }

      // Check if the message is from the current user or from the agent
      const isCurrentUser = data.senderId === entityId;

      if (!isCurrentUser) {
        console.log('[Chat] Agent message received, re-enabling input');
        setInputDisabled(false);
      }

      // Build a proper ContentWithUser object that matches what the messages query expects
      const newMessage: ContentWithUser = {
        ...data,
        // Set the correct name based on who sent the message
        name: isCurrentUser ? USER_NAME : (data.senderName as string),
        createdAt: data.createdAt || Date.now(),
        senderId: entityId,
        senderName: USER_NAME,
        roomId: roomId,
        source: CHAT_SOURCE,
        id: data.id, // Add a unique ID for React keys and duplicate detection
      };

      console.log(`[Chat] Adding new message to UI from ${newMessage.name}:`, newMessage);

      // Update the message list without triggering a re-render cascade
      queryClient.setQueryData(
        ['messages', agentId, roomId, worldId],
        (old: ContentWithUser[] = []) => {
          console.log('[Chat] Current messages:', old?.length || 0);

          // --- Start modification for IGNORE case ---
          let messageToAdd = { ...newMessage }; // Copy the received message data
          const isIgnore = messageToAdd.actions?.includes('IGNORE');

          if (isIgnore) {
            // Customize text for ignored messages
            messageToAdd.text = ``;
            // Ensure thought is preserved, actions array might also be useful
            messageToAdd.thought = data.thought; // Make sure thought from data is used
            messageToAdd.actions = data.actions; // Keep the IGNORE action marker
            clientLogger.debug('[Chat] Handling IGNORE action, modifying message', messageToAdd);
          }

          // Check if this message (potentially modified) is already in the list (avoid duplicates)
          const isDuplicate = old.some(
            (msg) =>
              // Use a combination of sender, text/thought, and time to detect duplicates
              msg.senderId === messageToAdd.senderId &&
              (msg.text === messageToAdd.text ||
                (!msg.text && !messageToAdd.text && msg.thought === messageToAdd.thought)) &&
              Math.abs((msg.createdAt || 0) - (messageToAdd.createdAt || 0)) < 5000 // Within 5 seconds
          );

          if (isDuplicate) {
            console.log('[Chat] Skipping duplicate message');
            return old;
          }

          // Set animation ID based on the potentially modified messageToAdd
          if (messageToAdd.id) {
            const newMessageId =
              typeof messageToAdd.id === 'string' ? messageToAdd.id : String(messageToAdd.id);
            // Only animate non-user messages
            if (messageToAdd.senderId !== entityId) {
              animatedMessageIdRef.current = newMessageId;
            } else {
              animatedMessageIdRef.current = null; // Don't animate user messages
            }
          }

          return [...old, messageToAdd]; // Add the potentially modified message
        }
      );

      // Remove the redundant state update that was causing render loops
      // setInput(prev => prev + '');
    };

    const handleMessageComplete = () => {
      setInputDisabled(false);
    };

    // Add listener for message broadcasts
    console.log('[Chat] Adding messageBroadcast listener');
    const msgHandler = socketIOManager.evtMessageBroadcast.attach((data) => [
      data as unknown as ContentWithUser,
    ]);
    const completeHandler = socketIOManager.evtMessageComplete.attach(handleMessageComplete);

    msgHandler.attach(handleMessageBroadcasting);
    completeHandler.attach(handleMessageComplete);

    return () => {
      // When leaving this chat, leave the room but don't disconnect
      console.log(`[Chat] Leaving room ${roomId}`);
      socketIOManager.leaveRoom(roomId);
      msgHandler.detach();
      completeHandler.detach();
    };
  }, [roomId, agentId, entityId, queryClient, socketIOManager]);

  // Handle control messages
  useEffect(() => {
    // Function to handle control messages (enable/disable input)
    const handleControlMessage = (data: any) => {
      // Extract action and roomId with type safety
      const { action, roomId: messageRoomId } = data || {};
      const isInputControl = action === 'enable_input' || action === 'disable_input';

      // Check if this is a valid input control message for this room
      if (isInputControl && messageRoomId === roomId) {
        clientLogger.info(`[Chat] Received control message: ${action} for room ${messageRoomId}`);

        if (action === 'disable_input') {
          setInputDisabled(true);
          // setMessageProcessing(true); // REMOVE
        } else if (action === 'enable_input') {
          setInputDisabled(false);
          // setMessageProcessing(false); // REMOVE
        }
      }
    };

    // Subscribe to control messages
    socketIOManager.on('controlMessage', handleControlMessage);

    // Cleanup subscription on unmount
    return () => {
      socketIOManager.off('controlMessage', handleControlMessage);
    };
  }, [roomId]);

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

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if ((!input && selectedFiles.length === 0) || inputDisabled) return;

    const messageId = randomUUID();
    let messageText = input;
    let attachments: Media[] = [];

    // Handle file uploads if files are selected
    if (selectedFiles.length > 0) {
      try {
        console.log('[Chat] Uploading files before sending message...');

        // Set uploading state for all files
        setSelectedFiles((prev) => prev.map((f) => ({ ...f, isUploading: true })));

        // Upload all files concurrently
        const uploadPromises = selectedFiles.map(async (fileData) => {
          try {
            const uploadResult = await apiClient.uploadMedia(agentId, fileData.file);
            if (uploadResult.success) {
              return {
                id: `file-${messageId}-${fileData.id}`,
                url: uploadResult.data.url,
                source: 'file_upload',
                contentType: getContentTypeFromMimeType(fileData.file.type),
              };
            } else {
              throw new Error(`Upload failed for ${fileData.file.name}`);
            }
          } catch (error) {
            console.error(`Failed to upload ${fileData.file.name}:`, error);
            throw error;
          }
        });

        const uploadResults = await Promise.all(uploadPromises);
        attachments = uploadResults;
      } catch (error) {
        console.error('Failed to upload files:', error);
        // Reset uploading state on error
        setSelectedFiles((prev) =>
          prev.map((f) => ({ ...f, isUploading: false, error: 'Upload failed' }))
        );
        return;
      }
    }

    // Parse media from the input text to include in message data
    const mediaInfos = parseMediaFromText(messageText);

    // Create attachments array from parsed media for model processing
    const mediaAttachments = mediaInfos.map((media, index) => ({
      id: `media-${messageId}-${index}`,
      url: media.url,
      source: 'user_input',
      contentType: media.type === 'image' ? ContentType.IMAGE : ContentType.VIDEO,
    }));

    // Combine file attachments and media attachments
    const allAttachments = [...attachments, ...mediaAttachments];

    // If there's no text but there are attachments, provide a default message
    if (!messageText.trim() && allAttachments.length > 0) {
      const fileTypes = allAttachments.map((a) => {
        if (a.contentType === ContentType.IMAGE) {
          return 'image';
        } else if (a.contentType === ContentType.VIDEO) {
          return 'video';
        } else if (a.contentType === ContentType.AUDIO) {
          return 'audio';
        } else {
          return 'file';
        }
      });
      const uniqueTypes = [...new Set(fileTypes)];
      messageText = `Shared ${uniqueTypes.join(' and ')}${allAttachments.length > 1 ? 's' : ''}`;
    }

    // Always add the user's message immediately to the UI before sending it to the server
    const userMessage: ContentWithUser = {
      text: messageText,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: entityId,
      senderName: USER_NAME,
      roomId: roomId,
      source: CHAT_SOURCE,
      id: messageId, // Add a unique ID for React keys and duplicate detection
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
    };

    console.log('[Chat] Adding user message to UI:', userMessage);

    // Update the local message list first for immediate feedback
    queryClient.setQueryData(
      ['messages', agentId, roomId, worldId],
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

    // Send the message to the server/agent
    socketIOManager.sendMessage(
      messageText,
      roomId,
      CHAT_SOURCE,
      allAttachments.length > 0 ? allAttachments : undefined
    );
    setInputDisabled(true);

    // Clear files and input after successful send
    setSelectedFiles([]);
    setInput('');
    formRef.current?.reset();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validFiles = files.filter(
      (file) => file.type.startsWith('image/')
      // file.type.startsWith('video/') ||
      // file.type.startsWith('application/') ||
      // file.type.startsWith('text/') ||
      // file.type === 'application/pdf' ||
      // file.type === 'application/msword' ||
      // file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      // file.type === 'application/vnd.ms-excel' ||
      // file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      // file.type === 'application/vnd.ms-powerpoint' ||
      // file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );

    // Filter out files that are already selected (check by name, size, and lastModified)
    const uniqueFiles = validFiles.filter((newFile) => {
      return !selectedFiles.some(
        (existingFile) =>
          existingFile.file.name === newFile.name &&
          existingFile.file.size === newFile.size &&
          existingFile.file.lastModified === newFile.lastModified
      );
    });

    const newFiles: UploadingFile[] = uniqueFiles.map((file) => ({
      file,
      id: randomUUID(),
      isUploading: false,
    }));

    setSelectedFiles((prev) => [...prev, ...newFiles]);

    // Reset the input so the same files can be selected again
    if (e.target) {
      e.target.value = '';
    }
  };

  const removeFile = (fileId: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleDeleteMessage = (id: string) => {
    deleteMemoryMutation.mutate({ agentId, memoryId: id });
    queryClient.setQueryData(
      ['messages', agentId, roomId, worldId],
      (old: ContentWithUser[] = []) => old.filter((m) => m.id !== id)
    );
  };

  const handleClearChat = () => {
    if (window.confirm('Clear all messages?')) {
      clearMemoriesMutation.mutate({ agentId, roomId });
      queryClient.setQueryData(['messages', agentId, roomId, worldId], []);
    }
  };

  // Helper function to map MIME type to ContentType enum
  const getContentTypeFromMimeType = (mimeType: string): ContentType | undefined => {
    if (mimeType.startsWith('image/')) {
      return ContentType.IMAGE;
    } else if (mimeType.startsWith('video/')) {
      return ContentType.VIDEO;
    } else if (mimeType.startsWith('audio/')) {
      return ContentType.AUDIO;
    } else if (mimeType.includes('pdf') || mimeType.includes('document')) {
      return ContentType.DOCUMENT;
    }
    return undefined;
  };

  return (
    <div
      className={`flex flex-col w-full h-screen items-center ${showDetails ? 'col-span-3' : 'col-span-4'}`}
    >
      {/* Wrapper to constrain width and manage vertical layout */}
      <div className="flex flex-col w-full md:max-w-4xl h-full p-4">
        {/* Agent Header */}
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <Avatar className="size-10 border rounded-full">
              <AvatarImage
                src={
                  agentData?.settings?.avatar ? agentData?.settings?.avatar : '/elizaos-icon.png'
                }
              />
            </Avatar>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg">{agentData?.name || 'Agent'}</h2>
                {agentData?.status === AgentStatus.ACTIVE ? (
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
              {agentData?.bio && (
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {Array.isArray(agentData.bio) ? agentData.bio[0] : agentData.bio}
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleClearChat}>
              <Trash2 className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleDetails}
              className={cn('gap-1.5', showDetails && 'bg-secondary')}
            >
              <PanelRight className="size-4" />
            </Button>
          </div>
        </div>

        {/* Main Chat Area - takes remaining height */}
        <div
          className={cn('flex flex-col transition-all duration-300 w-full grow overflow-hidden ')}
        >
          {/* Chat Messages */}
          <ChatMessageList
            scrollRef={scrollRef}
            isAtBottom={isAtBottom}
            scrollToBottom={safeScrollToBottom}
            disableAutoScroll={disableAutoScroll}
            className="flex-grow scrollbar-hide overflow-y-auto" // Ensure scrolling within this list
          >
            {messages.map((message: ContentWithUser, index: number) => {
              const isUser = message.name === USER_NAME;
              const shouldAnimate =
                index === messages.length - 1 &&
                message.name !== USER_NAME &&
                message.id === animatedMessageIdRef.current;
              return (
                <div
                  key={`${message.id as string}-${message.createdAt}`}
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
                          src={
                            isUser
                              ? '/user-icon.png'
                              : agentData?.settings?.avatar
                                ? agentData?.settings?.avatar
                                : '/elizaos-icon.png'
                          }
                        />
                      </Avatar>
                    )}

                    <MemoizedMessageContent
                      message={message}
                      agentId={agentId}
                      shouldAnimate={shouldAnimate}
                      onDelete={handleDeleteMessage}
                    />
                  </ChatBubble>
                </div>
              );
            })}
          </ChatMessageList>

          {/* Chat Input */}
          <div className="px-4 pb-4 mt-auto flex-shrink-0">
            {/* Keep input at bottom */}
            {inputDisabled && (
              <div className="px-2 pb-2 text-sm text-muted-foreground flex items-center gap-2">
                <div className="flex gap-0.5 items-center justify-center">
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0s]" />
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
                </div>
                <span>{agentData.name} is thinking</span>
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
                    ? 'Input disabled while agent is processing...'
                    : 'Type your message here...'
                }
                className="min-h-12 resize-none rounded-md bg-card border-0 p-3 shadow-none focus-visible:ring-0"
                disabled={inputDisabled || agentData.status === 'inactive'}
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
                        <Image className="size-4" />
                        <span className="sr-only">Attach image for description</span>
                      </Button>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept="image/*"
                        multiple
                        className="hidden"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p>Attach an image for the AI to describe</p>
                  </TooltipContent>
                </Tooltip>
                <AudioRecorder
                  agentId={agentId}
                  onChange={(newInput: string) => setInput(newInput)}
                />
                <Button
                  disabled={inputDisabled || agentData.status === 'inactive' || selectedFiles.some((f) => f.isUploading)}
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
      {/* End of width constraining wrapper */}
    </div>
  );
}
