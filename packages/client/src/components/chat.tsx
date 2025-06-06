import { Separator } from '@/components/ui/separator';
import CopyButton from '@/components/copy-button';
import DeleteButton from '@/components/delete-button';
import RetryButton from '@/components/retry-button';
import MediaContent from '@/components/media-content';
import ProfileOverlay from '@/components/profile-overlay';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ConfirmationDialog from '@/components/confirmation-dialog';
import { useConfirmation } from '@/hooks/use-confirmation';
import { ChatBubbleMessage, ChatBubbleTimestamp } from '@/components/ui/chat/chat-bubble';
import ChatTtsButton from '@/components/ui/chat/chat-tts-button';
import { useAutoScroll } from '@/components/ui/chat/hooks/useAutoScroll';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CHAT_SOURCE, GROUP_CHAT_SOURCE, USER_NAME } from '@/constants';
import { useFileUpload } from '@/hooks/use-file-upload';
import {
  useAgent,
  useAgentsWithDetails,
  useChannelDetails,
  useChannelMessages,
  useChannelParticipants,
  useClearChannelMessages,
  useDeleteChannelMessage,
  type UiMessage,
} from '@/hooks/use-query-hooks';
import { useSocketChat } from '@/hooks/use-socket-chat';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import clientLogger from '@/lib/logger';
import { parseMediaFromText, removeMediaUrlsFromText, type MediaInfo } from '@/lib/media-utils';
import {
  cn,
  generateGroupName,
  getAgentAvatar,
  getEntityId,
  moment,
  randomUUID,
} from '@/lib/utils';
import type { Agent, Media, UUID } from '@elizaos/core';
import {
  AgentStatus,
  ChannelType,
  ContentType as CoreContentType,
  validateUuid,
} from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Info,
  Loader2,
  MessageSquarePlus,
  PanelRight,
  PanelRightClose,
  Plus,
  Trash2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AIWriter from 'react-aiwriter';
import { AgentSidebar } from './agent-sidebar';
import { ChatInputArea } from './ChatInputArea';
import { ChatMessageListComponent } from './ChatMessageListComponent';
import GroupPanel from './group-panel';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCreateDmChannel, useDmChannelsForAgent } from '@/hooks/use-dm-channels';
import relativeTime from 'dayjs/plugin/relativeTime';
moment.extend(relativeTime);

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

interface UnifiedChatViewProps {
  chatType: ChannelType.DM | ChannelType.GROUP;
  contextId: UUID; // agentId for DM, channelId for GROUP
  serverId?: UUID; // Required for GROUP, optional for DM
  initialDmChannelId?: UUID; // New prop for specific DM channel from URL
}

// Consolidated chat state type
interface ChatUIState {
  showSidebar: boolean;
  showGroupEditPanel: boolean;
  showProfileOverlay: boolean;
  input: string;
  inputDisabled: boolean;
  selectedGroupAgentId: UUID | null;
  currentDmChannelId: UUID | null;
  isCreatingDM: boolean;
}

// Message content component - exported for use in ChatMessageListComponent
export const MemoizedMessageContent = React.memo(MessageContent);

export function MessageContent({
  message,
  agentForTts,
  shouldAnimate,
  onDelete,
  onRetry,
  isUser,
  getAgentInMessage,
  agentAvatarMap,
}: {
  message: UiMessage;
  agentForTts?: Agent | Partial<Agent> | null;
  shouldAnimate?: boolean;
  onDelete: (id: string) => void;
  onRetry?: (messageText: string) => void;
  isUser: boolean;
  getAgentInMessage?: (agentId: UUID) => Partial<Agent> | undefined;
  agentAvatarMap?: Record<UUID, string | null>;
}) {
  const agentData =
    !isUser && getAgentInMessage ? getAgentInMessage(message.senderId) : agentForTts;

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
                  {(agentData as Agent)?.name || 'Agent'}'s Thought Process
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

            const mediaInfos = parseMediaFromText(message.text);
            const attachmentUrls = new Set(
              message.attachments?.map((att) => att.url).filter(Boolean) || []
            );
            const uniqueMediaInfos = mediaInfos.filter((media) => !attachmentUrls.has(media.url));
            const textWithoutUrls = removeMediaUrlsFromText(message.text, mediaInfos);

            return (
              <div className="space-y-3">
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

        {message.attachments
          ?.filter((attachment) => attachment.url && attachment.url.trim() !== '')
          .map((attachment: Media) => (
            <MediaContent
              key={`${attachment.url}-${attachment.title}`}
              url={attachment.url}
              title={attachment.title || 'Attachment'}
            />
          ))}

        {(message.text || message.attachments?.length) && message.createdAt && (
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
          {isUser && message.text && !message.isLoading && onRetry && (
            <RetryButton onClick={() => onRetry(message.text!)} />
          )}
          <DeleteButton onClick={() => onDelete(message.id as string)} />
        </div>
        <div>
          {message.actions && message.actions.length > 0 && (
            <Badge variant="outline" className="text-sm">
              {Array.isArray(message.actions) ? message.actions.join(', ') : message.actions}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Chat({
  chatType,
  contextId,
  serverId,
  initialDmChannelId,
}: UnifiedChatViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Consolidate all chat UI state into a single object
  const [chatState, setChatState] = useState<ChatUIState>({
    showSidebar: false,
    showGroupEditPanel: false,
    showProfileOverlay: false,
    input: '',
    inputDisabled: false,
    selectedGroupAgentId: null,
    currentDmChannelId: null,
    isCreatingDM: false,
  });

  // Confirmation dialogs
  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();

  // Helper to update chat state
  const updateChatState = useCallback((updates: Partial<ChatUIState>) => {
    setChatState((prev) => ({ ...prev, ...updates }));
  }, []);

  const currentClientEntityId = getEntityId();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // For DM, we need agent data. For GROUP, we need channel data
  const { data: agentDataResponse, isLoading: isLoadingAgent } = useAgent(
    chatType === ChannelType.DM ? contextId : undefined,
    { enabled: chatType === ChannelType.DM }
  );

  // Convert AgentWithStatus to Agent, ensuring required fields have defaults
  const targetAgentData: Agent | undefined = agentDataResponse?.data
    ? ({
        ...agentDataResponse.data,
        createdAt: agentDataResponse.data.createdAt || Date.now(),
        updatedAt: agentDataResponse.data.updatedAt || Date.now(),
      } as Agent)
    : undefined;

  // Use the new hooks for DM channel management
  const { data: agentDmChannels = [], isLoading: isLoadingAgentDmChannels } = useDmChannelsForAgent(
    chatType === ChannelType.DM ? contextId : undefined
  );
  const createDmChannelMutation = useCreateDmChannel();

  // Group chat specific data
  const { data: channelDetailsData } = useChannelDetails(
    chatType === ChannelType.GROUP ? contextId : undefined
  );
  const { data: participantsData } = useChannelParticipants(
    chatType === ChannelType.GROUP ? contextId : undefined
  );
  const participants = participantsData?.data;

  const { data: agentsResponse } = useAgentsWithDetails();
  const allAgents = agentsResponse?.agents || [];

  // Get agents in the current group
  const groupAgents = useMemo(() => {
    if (chatType !== ChannelType.GROUP || !participants) return [];
    return participants
      .map((pId) => allAgents.find((a) => a.id === pId))
      .filter(Boolean) as Agent[];
  }, [chatType, participants, allAgents]);

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

  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll, autoScrollEnabled } =
    useAutoScroll({ smooth: true });
  const prevMessageCountRef = useRef(0);
  const safeScrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      setTimeout(() => scrollToBottom(), 0);
    }
  }, [scrollToBottom, scrollRef]);

  // Handle DM channel creation
  const handleNewDmChannel = useCallback(
    async (agentIdForNewChannel: UUID | undefined) => {
      if (!agentIdForNewChannel || chatType !== 'DM') return;
      const newChatName = `Chat - ${moment().format('MMM D, HH:mm:ss')}`;
      clientLogger.info(
        `[Chat] Creating new distinct DM channel with agent ${agentIdForNewChannel}, name: "${newChatName}"`
      );
      updateChatState({ isCreatingDM: true });
      try {
        const newChannel = await createDmChannelMutation.mutateAsync({
          agentId: agentIdForNewChannel,
          channelName: newChatName, // Provide a unique name
        });
        updateChatState({ currentDmChannelId: newChannel.id, input: '' });
        setTimeout(() => safeScrollToBottom(), 150);
      } catch (error) {
        clientLogger.error('[Chat] Error creating new distinct DM channel:', error);
        // Toast is handled by the mutation hook
      } finally {
        updateChatState({ isCreatingDM: false });
      }
    },
    [chatType, createDmChannelMutation, updateChatState, safeScrollToBottom]
  );

  // Handle DM channel selection
  const handleSelectDmRoom = useCallback(
    (channelIdToSelect: UUID) => {
      const selectedChannel = agentDmChannels.find((channel) => channel.id === channelIdToSelect);
      if (selectedChannel) {
        clientLogger.info(
          `[Chat] DM Channel selected: ${selectedChannel.name} (Channel ID: ${selectedChannel.id})`
        );
        updateChatState({ currentDmChannelId: selectedChannel.id, input: '' });
        setTimeout(() => safeScrollToBottom(), 150);
      }
    },
    [agentDmChannels, updateChatState, safeScrollToBottom]
  );

  // Handle DM channel deletion
  const handleDeleteCurrentDmChannel = useCallback(() => {
    if (chatType !== ChannelType.DM || !chatState.currentDmChannelId || !targetAgentData?.id)
      return;
    const channelToDelete = agentDmChannels.find((ch) => ch.id === chatState.currentDmChannelId);
    if (!channelToDelete) return;

    confirm(
      {
        title: 'Delete Chat',
        description: `Are you sure you want to delete the chat "${channelToDelete.name}" with ${targetAgentData.name}? This action cannot be undone.`,
        confirmText: 'Delete',
        variant: 'destructive',
      },
      async () => {
        clientLogger.info(`[Chat] Deleting DM channel ${channelToDelete.id}`);
        try {
          await apiClient.deleteChannel(channelToDelete.id);
          toast({ title: 'Chat Deleted', description: `"${channelToDelete.name}" was deleted.` });
          const remainingChannels = agentDmChannels.filter(
            (ch) => ch.id !== channelToDelete.id
          );
          if (remainingChannels.length > 0) {
            updateChatState({ currentDmChannelId: remainingChannels[0].id });
            clientLogger.info('[Chat] Switched to DM channel:', remainingChannels[0].id);
          } else {
            clientLogger.info('[Chat] No DM channels left after deletion, creating an initial one.');
            handleNewDmChannel(targetAgentData.id);
          }
        } catch (error) {
          clientLogger.error('[Chat] Error deleting DM channel:', error);
          toast({
            title: 'Error',
            description: 'Could not delete chat. The server might not support this action yet.',
            variant: 'destructive',
          });
        }
      }
    );
  }, [chatType, chatState.currentDmChannelId, targetAgentData, agentDmChannels, confirm, toast, updateChatState, handleNewDmChannel]);

  // Effect to handle initial DM channel selection or creation
  useEffect(() => {
    if (chatType === ChannelType.DM && targetAgentData?.id) {
      if (
        !isLoadingAgentDmChannels &&
        !createDmChannelMutation.isPending &&
        !chatState.isCreatingDM
      ) {
        // Prioritize initialDmChannelId from props if it's valid and belongs to the current agent's DMs
        if (initialDmChannelId && agentDmChannels.some((c) => c.id === initialDmChannelId)) {
          if (chatState.currentDmChannelId !== initialDmChannelId) {
            clientLogger.info(
              `[Chat] Aligning with DM channel from URL/prop: ${initialDmChannelId}`
            );
            updateChatState({ currentDmChannelId: initialDmChannelId });
          }
        } else if (agentDmChannels.length > 0) {
          const currentChannelIsValid = agentDmChannels.some(
            (c) => c.id === chatState.currentDmChannelId
          );
          if (!chatState.currentDmChannelId || !currentChannelIsValid) {
            clientLogger.info('[Chat] Selecting most recent DM channel:', agentDmChannels[0].id);
            updateChatState({ currentDmChannelId: agentDmChannels[0].id });
          }
        } else {
          clientLogger.info(
            '[Chat] No DM channels found for agent, creating initial distinct DM channel'
          );
          handleNewDmChannel(targetAgentData.id); // This will navigate and set currentDmChannelId
        }
      }
    } else if (chatType !== ChannelType.DM && chatState.currentDmChannelId !== null) {
      // Only reset if necessary
      updateChatState({ currentDmChannelId: null });
    }
  }, [
    chatType,
    targetAgentData?.id,
    agentDmChannels,
    isLoadingAgentDmChannels,
    createDmChannelMutation.isPending,
    chatState.isCreatingDM,
    chatState.currentDmChannelId,
    initialDmChannelId,
    updateChatState,
    handleNewDmChannel,
  ]);

  // Auto-select single agent in group
  useEffect(() => {
    if (
      chatType === ChannelType.GROUP &&
      groupAgents.length === 1 &&
      !chatState.selectedGroupAgentId
    ) {
      updateChatState({
        selectedGroupAgentId: groupAgents[0].id as UUID,
        showSidebar: true,
      });
    }
  }, [chatType, groupAgents, chatState.selectedGroupAgentId, updateChatState]);

  // Get the final channel ID for hooks
  const finalChannelIdForHooks: UUID | undefined =
    chatType === ChannelType.DM
      ? chatState.currentDmChannelId || undefined
      : contextId || undefined;

  const finalServerIdForHooks: UUID | undefined = useMemo(() => {
    return chatType === ChannelType.DM ? DEFAULT_SERVER_ID : serverId || undefined;
  }, [chatType, serverId]);

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    addMessage,
    updateMessage,
    removeMessage,
  } = useChannelMessages(finalChannelIdForHooks, finalServerIdForHooks);

  const { mutate: deleteMessageCentral } = useDeleteChannelMessage();
  const { mutate: clearMessagesCentral } = useClearChannelMessages();

  // Auto-scroll handling
  useEffect(() => {
    const isInitialLoadWithMessages = prevMessageCountRef.current === 0 && messages.length > 0;
    const hasNewMessages =
      messages.length !== prevMessageCountRef.current && prevMessageCountRef.current !== 0;

    if (isInitialLoadWithMessages) {
      clientLogger.debug('[chat] Initial messages loaded, scrolling to bottom.', {
        count: messages.length,
      });
      safeScrollToBottom();
    } else if (hasNewMessages) {
      if (autoScrollEnabled) {
        clientLogger.debug('[chat] New messages and autoScroll enabled, scrolling.');
        safeScrollToBottom();
      } else {
        clientLogger.debug('[chat] New messages, but autoScroll is disabled (user scrolled up).');
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages, autoScrollEnabled, safeScrollToBottom, finalChannelIdForHooks]);

  const { sendMessage, animatedMessageId } = useSocketChat({
    channelId: finalChannelIdForHooks,
    currentUserId: currentClientEntityId,
    contextId,
    chatType,
    allAgents,
    messages,
    onAddMessage: (message: UiMessage) => {
      addMessage(message);
      if (message.isAgent) safeScrollToBottom();
    },
    onUpdateMessage: (messageId: string, updates: Partial<UiMessage>) => {
      updateMessage(messageId, updates);
      if (!updates.isLoading && updates.isLoading !== undefined) safeScrollToBottom();
    },
    onDeleteMessage: (messageId: string) => {
      removeMessage(messageId);
    },
    onClearMessages: () => {
      // Clear the local message list to prevent UI flicker during refetch
      setMessages([]);
      // Invalidate the query to trigger a refetch
      queryClient.invalidateQueries({
        queryKey: ['channelMessages', finalChannelIdForHooks, finalServerIdForHooks],
      });
    },
    onInputDisabledChange: (disabled: boolean) => updateChatState({ inputDisabled: disabled }),
  });

  const {
    selectedFiles,
    handleFileChange,
    removeFile,
    createBlobUrls,
    uploadFiles,
    cleanupBlobUrls,
    clearFiles,
  } = useFileUpload({
    agentId: targetAgentData?.id,
    channelId: finalChannelIdForHooks,
    chatType,
  });

  // Handlers
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // For DM chats, ensure we have a channel before sending
    let channelIdToUse = finalChannelIdForHooks;
    if (chatType === ChannelType.DM && !channelIdToUse && targetAgentData?.id) {
      clientLogger.info('[Chat] No DM channel selected, creating one before sending message');
      try {
        const newChannel = await createDmChannelMutation.mutateAsync({
          agentId: targetAgentData.id,
          channelName: `Chat - ${moment().format('MMM D, HH:mm')}`,
        });
        updateChatState({ currentDmChannelId: newChannel.id });
        channelIdToUse = newChannel.id;
        // Wait a moment for state to propagate
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        clientLogger.error('[Chat] Failed to create DM channel before sending message:', error);
        toast({
          title: 'Error',
          description: 'Failed to create chat channel. Please try again.',
          variant: 'destructive',
        });
        updateChatState({ inputDisabled: false });
        return;
      }
    }

    if (
      (!chatState.input.trim() && selectedFiles.length === 0) ||
      chatState.inputDisabled ||
      !channelIdToUse ||
      !finalServerIdForHooks ||
      !currentClientEntityId ||
      (chatType === ChannelType.DM && !targetAgentData?.id)
    )
      return;

    updateChatState({ inputDisabled: true });
    const tempMessageId = randomUUID() as UUID;
    let messageText = chatState.input.trim();
    const currentInputVal = chatState.input;
    updateChatState({ input: '' });
    const currentSelectedFiles = [...selectedFiles];
    clearFiles();
    formRef.current?.reset();
    const optimisticAttachments = createBlobUrls(currentSelectedFiles);
    const optimisticUiMessage: UiMessage = {
      id: tempMessageId,
      text: messageText,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: currentClientEntityId,
      isAgent: false,
      isLoading: true,
      channelId: channelIdToUse,
      serverId: finalServerIdForHooks,
      source: chatType === ChannelType.DM ? CHAT_SOURCE : GROUP_CHAT_SOURCE,
      attachments: optimisticAttachments,
    };
    if (messageText || currentSelectedFiles.length > 0) addMessage(optimisticUiMessage);
    safeScrollToBottom();
    try {
      let processedUiAttachments: Media[] = [];
      if (currentSelectedFiles.length > 0) {
        const { uploaded, failed, blobUrls } = await uploadFiles(currentSelectedFiles);
        processedUiAttachments = uploaded;
        if (failed.length > 0)
          updateMessage(tempMessageId, {
            attachments: optimisticUiMessage.attachments?.filter(
              (att) => !failed.some((f) => f.file.id === att.id)
            ),
          });
        cleanupBlobUrls(blobUrls);
        if (!messageText.trim() && processedUiAttachments.length > 0)
          messageText = `Shared ${processedUiAttachments.length} file(s).`;
      }
      const mediaInfosFromText = parseMediaFromText(currentInputVal);
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
        updateChatState({ inputDisabled: false });
        removeMessage(tempMessageId);
        return;
      }
      await sendMessage(
        finalTextContent,
        finalServerIdForHooks,
        chatType === ChannelType.DM ? CHAT_SOURCE : GROUP_CHAT_SOURCE,
        finalAttachments.length > 0 ? finalAttachments : undefined,
        tempMessageId,
        undefined,
        channelIdToUse
      );
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
      updateChatState({ inputDisabled: false });
      inputRef.current?.focus();
    }
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!finalChannelIdForHooks || !messageId) return;
    const validMessageId = validateUuid(messageId);
    if (validMessageId) {
      deleteMessageCentral({ channelId: finalChannelIdForHooks, messageId: validMessageId });
    }
  };

  const handleRetryMessage = (messageText: string) => {
    if (!messageText.trim() || chatState.inputDisabled) return;
    // Set the input to the message text and submit it
    updateChatState({ input: messageText });
    // Focus the input after a brief delay to ensure state has updated
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        // Trigger form submission
        if (formRef.current) {
          formRef.current.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    }, 10);
  };

  const handleClearChat = () => {
    if (!finalChannelIdForHooks) return;
    const confirmMessage =
      chatType === ChannelType.DM
        ? `Clear all messages in this chat with ${targetAgentData?.name}?`
        : 'Clear all messages in this group chat?';

    confirm(
      {
        title: 'Clear Chat',
        description: `${confirmMessage} This action cannot be undone.`,
        confirmText: 'Clear',
        variant: 'destructive',
      },
      () => {
        clearMessagesCentral(finalChannelIdForHooks);
      }
    );
  };

  if (
    chatType === ChannelType.DM &&
    (isLoadingAgent || (!targetAgentData && contextId) || isLoadingAgentDmChannels)
  ) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (
    !finalChannelIdForHooks ||
    !finalServerIdForHooks ||
    (chatType === ChannelType.DM && !targetAgentData)
  ) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading chat context...</p>
      </div>
    );
  }

  // Chat header
  const renderChatHeader = () => {
    if (chatType === ChannelType.DM && targetAgentData) {
      return (
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Avatar className="size-10 border rounded-full">
                <AvatarImage src={getAgentAvatar(targetAgentData)} />
              </Avatar>
              {targetAgentData?.status === AgentStatus.ACTIVE ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border border-white bg-green-500" />
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Agent is active</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border border-white bg-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Agent is inactive</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg">{targetAgentData?.name || 'Agent'}</h2>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => updateChatState({ showProfileOverlay: true })}
                    >
                      <Info className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>View agent profile</p>
                  </TooltipContent>
                </Tooltip>
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
          <div className="flex gap-2 items-center">
            {chatType === ChannelType.DM && (
              <div className="flex items-center gap-1">
                {agentDmChannels.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="max-w-[300px]">
                        <MessageSquarePlus className="size-4 mr-2 flex-shrink-0" />
                        <span className="truncate">
                          {agentDmChannels.find((c) => c.id === chatState.currentDmChannelId)
                            ?.name || 'Select Chat'}
                        </span>
                        <Badge variant="secondary" className="ml-2">
                          {agentDmChannels.length}
                        </Badge>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[320px]">
                      <DropdownMenuLabel className="font-medium">
                        Chat History with {targetAgentData.name}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <div className="max-h-[300px] overflow-y-auto">
                        {agentDmChannels.map((channel) => (
                          <DropdownMenuItem
                            key={channel.id}
                            onClick={() => handleSelectDmRoom(channel.id)}
                            className={cn(
                              'cursor-pointer',
                              channel.id === chatState.currentDmChannelId && 'bg-muted'
                            )}
                          >
                            <div className="flex items-center justify-between w-full">
                              <div className="flex flex-col">
                                <span
                                  className={cn(
                                    'text-sm',
                                    channel.id === chatState.currentDmChannelId && 'font-medium'
                                  )}
                                >
                                  {channel.name}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {moment(
                                    channel.metadata?.createdAt ||
                                      channel.updatedAt ||
                                      channel.createdAt
                                  ).fromNow()}
                                </span>
                              </div>
                              {channel.id === chatState.currentDmChannelId && (
                                <Badge variant="default" className="text-xs">
                                  Current
                                </Badge>
                              )}
                            </div>
                          </DropdownMenuItem>
                        ))}
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleNewDmChannel(targetAgentData?.id)}
                  disabled={chatState.isCreatingDM || isLoadingAgentDmChannels}
                  title="Start a new distinct conversation with this agent"
                >
                  {chatState.isCreatingDM ? (
                    <Loader2 className="size-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="size-4 mr-2" />
                  )}
                  New Chat
                </Button>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={chatType === ChannelType.DM ? handleDeleteCurrentDmChannel : handleClearChat}
              disabled={
                !messages ||
                messages.length === 0 ||
                (chatType === ChannelType.DM && !chatState.currentDmChannelId)
              }
              title={
                chatType === ChannelType.DM ? 'Delete current chat session' : 'Clear all messages'
              }
              className="xl:px-3"
            >
              <Trash2 className="size-4" />
              <span className="hidden xl:inline xl:ml-2">
                {chatType === ChannelType.DM ? 'Delete' : 'Clear'}
              </span>
            </Button>
            <Separator orientation="vertical" className="h-8" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="xl:px-3 xl:h-8 h-8 w-8 xl:w-auto ml-3"
                  onClick={() => updateChatState({ showSidebar: !chatState.showSidebar })}
                >
                  {chatState.showSidebar ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{chatState.showSidebar ? 'Close SidePanel' : 'Open SidePanel'}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      );
    } else if (chatType === ChannelType.GROUP) {
      const groupDisplayName = generateGroupName(
        channelDetailsData?.data || undefined,
        groupAgents,
        currentClientEntityId
      );

      return (
        <div className="flex flex-col gap-3 mb-4">
          <div className="flex items-center justify-between p-3 bg-card rounded-lg border">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-lg" title={groupDisplayName}>
                {groupDisplayName}
              </h2>
            </div>
            <div className="flex gap-2 items-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateChatState({ showGroupEditPanel: true })}
              >
                Edit Group
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearChat}
                disabled={!messages || messages.length === 0}
                className="xl:px-3"
              >
                <Trash2 className="size-4" />
                <span className="hidden xl:inline xl:ml-2">Clear</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="xl:px-3 xl:h-8 h-8 w-8 xl:w-auto"
                onClick={() => updateChatState({ showSidebar: !chatState.showSidebar })}
              >
                {chatState.showSidebar ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRight className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {groupAgents.length > 0 && (
            <div className="flex items-center gap-2 p-2 bg-card rounded-lg border overflow-x-auto">
              <span className="text-sm text-muted-foreground whitespace-nowrap">Agents:</span>
              <div className="flex gap-2">
                <Button
                  variant={!chatState.selectedGroupAgentId ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => updateChatState({ selectedGroupAgentId: null })}
                  className="flex items-center gap-2"
                >
                  <span>All</span>
                </Button>
                {groupAgents.map((agent) => (
                  <Button
                    key={agent?.id}
                    variant={chatState.selectedGroupAgentId === agent?.id ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => {
                      updateChatState({
                        selectedGroupAgentId: agent?.id || null,
                        showSidebar: agent?.id ? true : chatState.showSidebar,
                      });
                    }}
                    className="flex items-center gap-2"
                  >
                    <Avatar className="size-5">
                      <AvatarImage src={getAgentAvatar(agent)} />
                    </Avatar>
                    <span>{agent?.name}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={chatState.showSidebar ? 70 : 100} minSize={50}>
          <div className="relative h-full">
            {/* Main chat content */}
            <div className="h-full flex flex-col p-4">
              {renderChatHeader()}

              <div
                className={cn(
                  'flex flex-col transition-all duration-300 w-full grow overflow-hidden '
                )}
              >
                <div className="flex-1 min-h-0">
                  <ChatMessageListComponent
                    messages={messages}
                    isLoadingMessages={isLoadingMessages}
                    chatType={chatType}
                    currentClientEntityId={currentClientEntityId}
                    targetAgentData={targetAgentData}
                    allAgents={allAgents}
                    animatedMessageId={animatedMessageId}
                    scrollRef={scrollRef}
                    isAtBottom={isAtBottom}
                    scrollToBottom={scrollToBottom}
                    disableAutoScroll={disableAutoScroll}
                    finalChannelId={finalChannelIdForHooks}
                    getAgentInMessage={getAgentInMessage}
                    agentAvatarMap={agentAvatarMap}
                    onDeleteMessage={handleDeleteMessage}
                    onRetryMessage={handleRetryMessage}
                    selectedGroupAgentId={chatState.selectedGroupAgentId}
                  />
                </div>

                <div className="flex-shrink-0">
                  <ChatInputArea
                    input={chatState.input}
                    setInput={(value) => updateChatState({ input: value })}
                    inputDisabled={chatState.inputDisabled}
                    selectedFiles={selectedFiles}
                    removeFile={removeFile}
                    handleFileChange={handleFileChange}
                    handleSendMessage={handleSendMessage}
                    handleKeyDown={handleKeyDown}
                    chatType={chatType}
                    targetAgentData={targetAgentData}
                    formRef={formRef}
                    inputRef={inputRef}
                    fileInputRef={fileInputRef}
                  />
                </div>
              </div>
            </div>
          </div>
        </ResizablePanel>

        {/* Right panel / sidebar */}
        {(() => {
          let sidebarAgentId: UUID | undefined = undefined;
          let sidebarAgentName: string = 'Agent';

          if (chatType === ChannelType.DM) {
            sidebarAgentId = contextId; // This is agentId for DM
            sidebarAgentName = targetAgentData?.name || 'Agent';
          } else if (chatType === ChannelType.GROUP && chatState.selectedGroupAgentId) {
            sidebarAgentId = chatState.selectedGroupAgentId;
            const selectedAgent = allAgents.find((a) => a.id === chatState.selectedGroupAgentId);
            sidebarAgentName = selectedAgent?.name || 'Group Member';
          } else if (chatType === ChannelType.GROUP && !chatState.selectedGroupAgentId) {
            sidebarAgentName = 'Group';
          }

          return (
            chatState.showSidebar && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
                  <AgentSidebar agentId={sidebarAgentId} agentName={sidebarAgentName} />
                </ResizablePanel>
              </>
            )
          );
        })()}
      </ResizablePanelGroup>

      {chatState.showGroupEditPanel && chatType === ChannelType.GROUP && (
        <GroupPanel
          onClose={() => updateChatState({ showGroupEditPanel: false })}
          channelId={contextId}
        />
      )}

      {chatState.showProfileOverlay && chatType === ChannelType.DM && targetAgentData?.id && (
        <ProfileOverlay
          isOpen={chatState.showProfileOverlay}
          onClose={() => updateChatState({ showProfileOverlay: false })}
          agentId={targetAgentData.id}
        />
      )}

      {/* Confirmation Dialogs */}
      <ConfirmationDialog
        open={isOpen}
        onOpenChange={onOpenChange}
        title={options?.title || ''}
        description={options?.description || ''}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        variant={options?.variant}
        onConfirm={onConfirm}
      />
    </>
  );
}
