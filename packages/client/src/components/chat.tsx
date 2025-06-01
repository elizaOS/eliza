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
import { parseMediaFromText, removeMediaUrlsFromText, type MediaInfo } from '@/lib/media-utils';
import SocketIOManager from '@/lib/socketio-manager';
import { cn, getEntityId, moment, randomUUID } from '@/lib/utils';
import type { Agent, Content, Media, UUID } from '@elizaos/core';
import {
  AgentStatus,
  ContentType as CoreContentType,
  ChannelType as CoreChannelType,
  validateUuid,
} from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';

import {
  ChevronRight,
  PanelRight,
  Send,
  Trash2,
  X,
  Loader2,
  FileText,
  Image,
  Paperclip,
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
        {message.text && message.createdAt && !isNaN(message.createdAt) && (
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
  const { channelId: channelIdFromPath, agentId: agentIdFromPath } = useParams<{
    channelId?: string;
    agentId?: string;
  }>();
  const [searchParams] = useSearchParams();
  const agentIdFromQuery = searchParams.get('agentId');
  const serverIdFromQuery = searchParams.get('serverId');

  const { toast } = useToast();
  const currentClientEntityId = getEntityId();

  // Determine if we're in agent mode (URL: /chat/agentId) or channel mode (URL: /chat/channelId?agentId=X&serverId=Y)
  const isAgentMode = !agentIdFromQuery && agentIdFromPath; // agentId in path, no query params
  const targetAgentId = isAgentMode
    ? validateUuid(agentIdFromPath) || undefined
    : validateUuid(agentIdFromQuery) || undefined;

  // Use resolved IDs for hooks
  const channelId = channelIdFromPath ? validateUuid(channelIdFromPath) : undefined;
  const serverId = serverIdFromQuery ? validateUuid(serverIdFromQuery) : undefined;

  const { data: agentDataWrapper, isLoading: isLoadingAgentData } = useAgent(targetAgentId, {
    enabled: !!targetAgentId,
  });
  const targetAgentData = agentDataWrapper?.data;

  // Auto-create DM channel for agent mode
  const [dmChannelData, setDmChannelData] = useState<{ channelId: UUID; serverId: UUID } | null>(
    null
  );
  const [isCreatingDM, setIsCreatingDM] = useState(false);

  useEffect(() => {
    if (isAgentMode && targetAgentId && !dmChannelData && !isCreatingDM) {
      setIsCreatingDM(true);
      // Create DM channel automatically
      const createDMChannel = async () => {
        try {
          // Always use the default server (ID "0")
          const serverId = '0' as UUID;

          // Create DM channel
          const dmResponse = await fetch(
            `/api/messages/dm-channel?targetUserId=${targetAgentId}&currentUserId=${currentClientEntityId}&dmServerId=${serverId}`
          );
          const dmData = await dmResponse.json();

          if (dmData.success) {
            setDmChannelData({
              channelId: dmData.data.id,
              serverId: serverId,
            });
          } else {
            throw new Error('Failed to create DM channel');
          }
        } catch (error) {
          console.error('Error creating DM channel:', error);
          toast({
            title: 'Error',
            description: 'Failed to create chat channel',
            variant: 'destructive',
          });
        } finally {
          setIsCreatingDM(false);
        }
      };

      createDMChannel();
    }
  }, [isAgentMode, targetAgentId, dmChannelData, isCreatingDM, currentClientEntityId, toast]);

  // Determine final IDs to use
  const finalChannelId = isAgentMode ? dmChannelData?.channelId : channelId;
  const finalServerId = isAgentMode ? dmChannelData?.serverId : serverId;

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    addMessage,
    updateMessage,
    removeMessage,
  } = useCentralChannelMessages(finalChannelId || undefined, finalServerId || undefined);

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
    if (!finalChannelId || !currentClientEntityId) return;
    socketIOManager.initialize(currentClientEntityId);
    socketIOManager.joinChannel(finalChannelId);
    clientLogger.info(
      `[DMPage] Joined DM channel ${finalChannelId} as user ${currentClientEntityId}`
    );

    const handleMessageBroadcasting = (data: MessageBroadcastData) => {
      clientLogger.info('[DMPage] Received raw messageBroadcast data:', JSON.stringify(data));
      const msgChannelId = data.channelId || data.roomId;
      if (msgChannelId !== finalChannelId) return;
      const isCurrentUser = data.senderId === currentClientEntityId;
      const isTargetAgent = data.senderId === targetAgentId;
      if (!isCurrentUser && isTargetAgent) setInputDisabled(false);

      // Check if this is a message we sent (by checking for clientMessageId)
      const clientMessageId = (data as any).clientMessageId;
      if (clientMessageId && isCurrentUser) {
        // Update the optimistic message with the server version
        updateMessage(clientMessageId, {
          id: data.id || randomUUID(),
          isLoading: false,
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt),
          text: data.text, // Update text in case it was modified server-side
          attachments: data.attachments, // Update attachments with server URLs
        });
      } else {
        // Add new message from server
        const newUiMsg: UiMessage = {
          id: data.id || randomUUID(),
          text: data.text,
          name: data.senderName,
          senderId: data.senderId as UUID,
          isAgent: isTargetAgent,
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.parse(data.createdAt),
          channelId: (data.channelId || data.roomId) as UUID,
          serverId: data.serverId as UUID | undefined,
          source: data.source,
          attachments: data.attachments,
          thought: data.thought,
          actions: data.actions,
          isLoading: false,
        };
        clientLogger.info('[DMPage] Adding new UiMessage:', JSON.stringify(newUiMsg));
        addMessage(newUiMsg);

        if (isTargetAgent && newUiMsg.id) animatedMessageIdRef.current = newUiMsg.id;
        else animatedMessageIdRef.current = null;
      }
    };
    const handleMessageComplete = (data: MessageCompleteData) => {
      const completeChannelId = data.channelId || data.roomId;
      if (completeChannelId === finalChannelId) setInputDisabled(false);
    };
    const handleControlMessage = (data: ControlMessageData) => {
      const ctrlChannelId = data.channelId || data.roomId;
      if (ctrlChannelId === finalChannelId) {
        if (data.action === 'disable_input') setInputDisabled(true);
        else if (data.action === 'enable_input') setInputDisabled(false);
      }
    };

    const msgSub = socketIOManager.evtMessageBroadcast.attach(
      (d: MessageBroadcastData) => (d.channelId || d.roomId) === finalChannelId,
      handleMessageBroadcasting
    );
    const completeSub = socketIOManager.evtMessageComplete.attach(
      (d: MessageCompleteData) => (d.channelId || d.roomId) === finalChannelId,
      handleMessageComplete
    );
    const controlSub = socketIOManager.evtControlMessage.attach(
      (d: ControlMessageData) => (d.channelId || d.roomId) === finalChannelId,
      handleControlMessage
    );

    return () => {
      if (finalChannelId) socketIOManager.leaveChannel(finalChannelId);
      msgSub?.detach();
      completeSub?.detach();
      controlSub?.detach();
    };
  }, [finalChannelId, currentClientEntityId, socketIOManager, targetAgentId, addMessage, updateMessage]);

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
      !finalChannelId ||
      !finalServerId ||
      !currentClientEntityId ||
      !targetAgentData?.id
    )
      return;

    setInputDisabled(true);
    const tempMessageId = randomUUID() as UUID;
    let messageText = input.trim();
    let processedUiAttachments: Media[] = []; // To hold attachments prepared for optimistic update and API

    // Store current input and clear UI immediately
    const currentInputVal = input;
    setInput('');
    const currentSelectedFiles = [...selectedFiles]; // Copy for processing
    setSelectedFiles([]); // Clear selected files from UI
    formRef.current?.reset();

    // 1. Optimistically display user message with local file URLs (if any)
    const optimisticUiMessage: UiMessage = {
      id: tempMessageId,
      text: messageText,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: currentClientEntityId,
      isAgent: false,
      isLoading: true, // Will be true until server ACK or agent response
      channelId: finalChannelId,
      serverId: finalServerId,
      source: CHAT_SOURCE,
      attachments: currentSelectedFiles // Use local file objects for immediate display
        .map((sf) => ({
          id: sf.id,
          url: URL.createObjectURL(sf.file), // Temporary local URL for display
          title: sf.file.name,
          contentType: getContentTypeFromMimeType(sf.file.type),
          isUploading: true, // Indicate this is still pending proper upload
        }))
        .filter((att) => att.contentType !== undefined) as Media[],
    };

    if (messageText || currentSelectedFiles.length > 0) {
      addMessage(optimisticUiMessage);
    }
    safeScrollToBottom();

    try {
      // 2. Handle actual file uploads
      if (currentSelectedFiles.length > 0) {
        const uploadPromises = currentSelectedFiles.map(async (fileData) => {
          try {
            // Update this specific file's state in UI if you have per-file loading indicators
            const uploadResult = await apiClient.uploadAgentMedia(
              targetAgentData.id!, // Assuming DM, so targetAgentData.id is uploader context
              fileData.file
            );
            if (uploadResult.success) {
              return {
                id: fileData.id, // Keep original temp ID for now
                url: uploadResult.data.url, // This will be the server URL (e.g., /media/uploads/...)
                title: fileData.file.name,
                source: 'file_upload',
                contentType: getContentTypeFromMimeType(fileData.file.type),
              } as Media;
            } else {
              throw new Error(`Upload failed for ${fileData.file.name}`);
            }
          } catch (uploadError) {
            clientLogger.error(`Failed to upload ${fileData.file.name}:`, uploadError);
            // Update optimistic message to show failure for this attachment if possible
            // Or show a toast notification for the specific file failure.
            toast({ title: `Upload Failed: ${fileData.file.name}`, variant: 'destructive' });
            return {
              // Return a structure indicating failure or skip this attachment
              id: fileData.id,
              title: fileData.file.name,
              error: 'Upload failed',
            } as Partial<Media> & { error: string };
          }
        });
        const settledUploads = await Promise.allSettled(uploadPromises);

        processedUiAttachments = settledUploads
          .filter(
            (result) =>
              result.status === 'fulfilled' && result.value && !(result.value as any).error
          )
          .map((result) => (result as PromiseFulfilledResult<Media>).value);

        const failedUploads = settledUploads.filter(
          (result) =>
            result.status === 'rejected' ||
            (result.status === 'fulfilled' && (result.value as any).error)
        );

        if (failedUploads.length > 0) {
          // Handle display of failed uploads or remove them from optimistic message
          updateMessage(tempMessageId, {
            attachments: optimisticUiMessage.attachments?.filter(
              (att) =>
                !failedUploads.some((fu) => {
                  const failedAtt = fu.status === 'fulfilled' ? fu.value : null;
                  return failedAtt && (failedAtt as any).id === att.id;
                })
            ),
          });
        }
        // If no text was initially present, but files were uploaded, create a summary text.
        if (!messageText.trim() && processedUiAttachments.length > 0) {
          messageText = `Shared ${processedUiAttachments.length} file(s).`;
        }
      }

      // 3. Parse media URLs from text input
      const mediaInfosFromText = parseMediaFromText(currentInputVal); // Use original input for URL parsing
      const textMediaAttachments: Media[] = mediaInfosFromText.map(
        (media: MediaInfo, index: number): Media => ({
          id: `textmedia-${tempMessageId}-${index}`,
          url: media.url,
          title: media.type === 'image' ? 'Image' : media.type === 'video' ? 'Video' : 'Media Link',
          source: 'user_input_url',
          contentType:
            media.type === 'image'
              ? CoreContentType.IMAGE
              : media.type === 'video'
                ? CoreContentType.VIDEO
                : undefined,
        })
      );

      const finalAttachments = [...processedUiAttachments, ...textMediaAttachments];
      const finalTextContent =
        messageText || (finalAttachments.length > 0 ? `Shared content.` : '');

      if (!finalTextContent.trim() && finalAttachments.length === 0) {
        clientLogger.warn('Attempted to send an empty message after processing.');
        setInputDisabled(false);
        removeMessage(tempMessageId);
        return;
      }

      // 4. Send the final message via WebSocket
      await socketIOManager.sendMessage(
        finalTextContent,
        finalChannelId!,
        finalServerId!,
        CHAT_SOURCE,
        finalAttachments.length > 0 ? finalAttachments : undefined,
        tempMessageId // Pass the tempMessageId to track the optimistic message
      );

      // Note: We don't update the optimistic message here anymore.
      // The message will be updated when we receive the server broadcast with clientMessageId
    } catch (error) {
      clientLogger.error('Error sending message or uploading files:', error);
      toast({
        title: 'Error Sending Message',
        description: error instanceof Error ? error.message : 'Could not send message.',
        variant: 'destructive',
      });
      updateMessage(tempMessageId, {
        isLoading: false,
        text: `${optimisticUiMessage.text || 'Attachment(s)'} (Failed to send)`,
      });
    } finally {
      setInputDisabled(false);
      // selectedFiles should be empty now if all uploads were attempted
      inputRef.current?.focus();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // Prioritizing the more robust filtering from the second part of the conflict
    const validFiles = files.filter(
      (file) =>
        file.type.startsWith('image/') ||
        file.type.startsWith('video/') ||
        file.type.startsWith('audio/') || // Added audio
        file.type === 'application/pdf' ||
        file.type === 'application/msword' ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        file.type === 'application/vnd.ms-excel' ||
        file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.type === 'application/vnd.ms-powerpoint' ||
        file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        file.type.startsWith('text/')
    );

    const uniqueFiles = validFiles.filter((newFile) => {
      return !selectedFiles.some(
        (existingFile) =>
          existingFile.file.name === newFile.name &&
          existingFile.file.size === newFile.size &&
          existingFile.file.lastModified === newFile.lastModified
      );
    });

    const newUploadingFiles: UploadingFile[] = uniqueFiles.map((file) => ({
      file,
      id: randomUUID(),
      isUploading: false, // Start as not uploading
    }));

    setSelectedFiles((prev) => {
      const combined = [...prev, ...newUploadingFiles];
      return Array.from(
        new Map(combined.map((f) => [`${f.file.name}-${f.file.size}`, f])).values()
      );
    });
    if (e.target) e.target.value = ''; // Clear file input
  };

  const removeFile = (fileId: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!finalChannelId) return;
    deleteMessageCentral({ channelId: finalChannelId, messageId: messageId as UUID });
  };

  const handleClearChat = () => {
    if (!finalChannelId) return;
    if (window.confirm('Clear all messages in this chat?')) {
      clearMessagesCentral(finalChannelId);
    }
  };

  if (isLoadingAgentData || (!targetAgentData && targetAgentId)) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading agent details...</p>
      </div>
    );
  }
  if (!finalChannelId || !finalServerId || !targetAgentData) {
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
            scrollToBottom={scrollToBottom}
            disableAutoScroll={disableAutoScroll}
            className="flex-1 w-full"
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
                <div className="flex gap-0.5 items-center justify-center">
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0s]" />
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
                  <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
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
                disabled={inputDisabled || targetAgentData?.status === 'inactive'}
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
                        accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.rtf,..."
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
                  disabled={
                    inputDisabled ||
                    targetAgentData?.status === 'inactive' ||
                    selectedFiles.some((f) => f.isUploading)
                  }
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
