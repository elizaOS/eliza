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
import { Markdown } from '@/components/ui/chat/markdown';
import { AnimatedMarkdown } from '@/components/ui/chat/animated-markdown';
import { useAutoScroll } from '@/components/ui/chat/hooks/useAutoScroll';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SplitButton, type SplitButtonAction } from '@/components/ui/split-button';
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
  Edit,
  Eraser,
  History,
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
import { useSidebarState } from '@/hooks/use-sidebar-state';
import { usePanelWidthState } from '@/hooks/use-panel-width-state';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { MessageChannel } from '@/types';
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
  showGroupEditPanel: boolean;
  showProfileOverlay: boolean;
  input: string;
  inputDisabled: boolean;
  selectedGroupAgentId: UUID | null;
  currentDmChannelId: UUID | null;
  isCreatingDM: boolean;
  isMobile: boolean; // Add mobile state
}

// Message content component - exported for use in ChatMessageListComponent
export const MemoizedMessageContent = React.memo(MessageContent, (prevProps, nextProps) => {
  // Only re-render if the message content, animation state, or other key props change
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.text === nextProps.message.text &&
    prevProps.message.isLoading === nextProps.message.isLoading &&
    prevProps.shouldAnimate === nextProps.shouldAnimate &&
    prevProps.isUser === nextProps.isUser
  );
});

export function MessageContent({
  message,
  agentForTts,
  shouldAnimate,
  onDelete,
  onRetry,
  isUser,
  getAgentInMessage,
  agentAvatarMap,
  chatType,
}: {
  message: UiMessage;
  agentForTts?: Agent | Partial<Agent> | null;
  shouldAnimate?: boolean;
  onDelete: (id: string) => void;
  onRetry?: (messageText: string) => void;
  isUser: boolean;
  getAgentInMessage?: (agentId: UUID) => Partial<Agent> | undefined;
  agentAvatarMap?: Record<UUID, string | null>;
  chatType?: ChannelType;
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
            {message.thought && (
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
                      <Markdown className="prose-sm max-w-none" variant="user">
                        {textWithoutUrls}
                      </Markdown>
                    ) : (
                      <AnimatedMarkdown
                        className="prose-sm max-w-none"
                        variant="agent"
                        shouldAnimate={shouldAnimate}
                        messageId={message.id}
                      >
                        {textWithoutUrls}
                      </AnimatedMarkdown>
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
            <RetryButton onClick={() => onRetry(message)} />
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

  // Use persistent sidebar state
  const { isVisible: showSidebar, setSidebarVisible, toggleSidebar } = useSidebarState();
  const {
    mainPanelSize,
    sidebarPanelSize,
    isFloatingMode: isFloatingModeFromWidth,
    setMainPanelSize,
    setSidebarPanelSize,
  } = usePanelWidthState();

  // Consolidate all chat UI state into a single object (excluding showSidebar which is now managed separately)
  const [chatState, setChatState] = useState<ChatUIState>({
    showGroupEditPanel: false,
    showProfileOverlay: false,
    input: '',
    inputDisabled: false,
    selectedGroupAgentId: null,
    currentDmChannelId: null,
    isCreatingDM: false,
    isMobile: false,
  });

  // Determine if we should use floating mode - either from width detection OR mobile
  const isFloatingMode = isFloatingModeFromWidth || chatState.isMobile;

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
  const inputDisabledRef = useRef<boolean>(false);

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

  const {
    scrollRef,
    contentRef,
    isAtBottom,
    scrollToBottom,
    disableAutoScroll,
    autoScrollEnabled,
  } = useAutoScroll({ smooth: true });
  const prevMessageCountRef = useRef(0);
  const safeScrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      setTimeout(() => scrollToBottom(), 0);
    }
  }, [scrollToBottom, scrollRef]);

  // Prevent repeated auto-creation of a DM channel when none exist
  const autoCreatedDmRef = useRef(false);
  const autoCreateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        // Mark as auto-created so the effect doesn't attempt a duplicate.
        autoCreatedDmRef.current = true;

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

          // --- Optimistically update the React-Query cache so UI refreshes instantly ---
          queryClient.setQueryData<MessageChannel[] | undefined>(
            ['dmChannels', targetAgentData.id, currentClientEntityId],
            (old) => old?.filter((ch) => ch.id !== channelToDelete.id)
          );

          // Force a refetch to stay in sync with the server
          queryClient.invalidateQueries({
            queryKey: ['dmChannels', targetAgentData.id, currentClientEntityId],
          });
          // Also keep the broader channels cache in sync
          queryClient.invalidateQueries({ queryKey: ['channels'] });

          toast({ title: 'Chat Deleted', description: `"${channelToDelete.name}" was deleted.` });

          const remainingChannels =
            (queryClient.getQueryData(['dmChannels', targetAgentData.id, currentClientEntityId]) as
              | MessageChannel[]
              | undefined) || [];

          if (remainingChannels.length > 0) {
            updateChatState({ currentDmChannelId: remainingChannels[0].id });
            clientLogger.info('[Chat] Switched to DM channel:', remainingChannels[0].id);
          } else {
            clientLogger.info(
              '[Chat] No DM channels left after deletion. Will create a fresh chat once.'
            );
            // Clear the current DM so the effect can handle creating exactly one new chat
            updateChatState({ currentDmChannelId: null });
            // Allow the auto-create logic to run again
            autoCreatedDmRef.current = false;
            await handleNewDmChannel(targetAgentData.id);
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
  }, [
    chatType,
    chatState.currentDmChannelId,
    targetAgentData,
    agentDmChannels,
    confirm,
    toast,
    updateChatState,
    handleNewDmChannel,
    queryClient,
    currentClientEntityId,
  ]);

  useEffect(() => {
    inputDisabledRef.current = chatState.inputDisabled;
  }, [chatState.inputDisabled]);

  // Effect to handle initial DM channel selection or creation
  useEffect(() => {
    if (chatType === ChannelType.DM && targetAgentData?.id) {
      // First, check if current channel belongs to the current agent
      // If not, clear it immediately (handles agent switching)
      const currentChannelBelongsToAgent =
        !chatState.currentDmChannelId ||
        agentDmChannels.some((c) => c.id === chatState.currentDmChannelId);

      if (!currentChannelBelongsToAgent && !isLoadingAgentDmChannels) {
        clientLogger.info(
          `[Chat] Current DM channel ${chatState.currentDmChannelId} doesn't belong to agent ${targetAgentData.id}, clearing it`
        );
        updateChatState({ currentDmChannelId: null });
        return; // Exit early, let the effect run again with cleared state
      }

      if (!isLoadingAgentDmChannels) {
        // If we now have channels, ensure one is selected
        if (agentDmChannels.length > 0) {
          const currentValid = agentDmChannels.some((c) => c.id === chatState.currentDmChannelId);
          if (!currentValid) {
            clientLogger.info(
              '[Chat] Selecting first available DM channel:',
              agentDmChannels[0].id
            );
            updateChatState({ currentDmChannelId: agentDmChannels[0].id });
            autoCreatedDmRef.current = false;
          }
        } else {
          if (
            agentDmChannels.length === 0 &&
            !initialDmChannelId &&
            !autoCreatedDmRef.current &&
            !chatState.isCreatingDM &&
            !createDmChannelMutation.isPending
          ) {
            // No channels at all and none expected via URL -> create exactly one
            clientLogger.info('[Chat] No existing DM channels found; auto-creating a fresh one.');
            autoCreatedDmRef.current = true;
            handleNewDmChannel(targetAgentData.id);
          }
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
  
  // Cleanup timeout on unmount or when agentDmChannels appears
  useEffect(() => {
    if (agentDmChannels.length > 0 && autoCreateTimeoutRef.current) {
      clearTimeout(autoCreateTimeoutRef.current);
      autoCreateTimeoutRef.current = null;
    }
    return () => {
      if (autoCreateTimeoutRef.current) {
        clearTimeout(autoCreateTimeoutRef.current);
        autoCreateTimeoutRef.current = null;
      }
    };
  }, [agentDmChannels]);

  // Auto-select single agent in group
  useEffect(() => {
    if (
      chatType === ChannelType.GROUP &&
      groupAgents.length === 1 &&
      !chatState.selectedGroupAgentId
    ) {
      updateChatState({
        selectedGroupAgentId: groupAgents[0].id as UUID,
      });
      if (!showSidebar) {
        setSidebarVisible(true);
      }
    }
  }, [
    chatType,
    groupAgents,
    chatState.selectedGroupAgentId,
    updateChatState,
    showSidebar,
    setSidebarVisible,
  ]);

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
    clearMessages,
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

  const updateChatTitle = async() => {
    const currentChatTitle = agentDmChannels.find((c) => c.id === finalChannelIdForHooks);
    const timestampChatNameRegex = /^Chat - [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}:\d{2}$/;
    const shouldUpdate: boolean = 
      !!currentChatTitle?.name && 
      timestampChatNameRegex.test(currentChatTitle.name) &&
      chatType === ChannelType.DM;

    if (!shouldUpdate) {
      return;
    }

    const data = await apiClient.getChannelSummary(finalChannelIdForHooks, contextId);

    console.log("$#$#$#$#$#$#$#$#$#$$#$#$#$#$$#$#$#$#$#$", data);
    const title = data?.data?.newTitle
    const participants = await apiClient.getChannelParticipants(chatState.currentDmChannelId);
    if (title && participants) {
      await apiClient.updateChannel(finalChannelIdForHooks, {
        name: title,
        participantCentralUserIds: participants.data
      })
    }
  }

  const { sendMessage, animatedMessageId } = useSocketChat({
    channelId: finalChannelIdForHooks,
    currentUserId: currentClientEntityId,
    contextId,
    chatType,
    allAgents,
    messages,
    onAddMessage: (message: UiMessage) => {
      addMessage(message);
      updateChatTitle();
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
      // Clear the local message list immediately for instant UI response
      clearMessages();
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
      // If a DM channel is already being (auto) created, abort to prevent duplicate creations.
      if (chatState.isCreatingDM || createDmChannelMutation.isPending) {
        clientLogger.info(
          '[Chat] DM channel creation already in progress; will wait for it to finish instead of creating another.'
        );
        // Early return so the user can try sending again once the channel is ready.
        return;
      }

      clientLogger.info('[Chat] No DM channel selected, creating one before sending message');
      try {
        // Mark as auto-created so the effect doesn't attempt a duplicate.
        autoCreatedDmRef.current = true;

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
      inputDisabledRef.current ||
      !channelIdToUse ||
      !finalServerIdForHooks ||
      !currentClientEntityId ||
      (chatType === ChannelType.DM && !targetAgentData?.id)
    )
      return;

    const tempMessageId = randomUUID() as UUID;
    let messageText = chatState.input.trim();
    const currentInputVal = chatState.input;
    updateChatState({ input: '', inputDisabled: true });
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
      // Re-enable input on error
      updateChatState({ inputDisabled: false });
    } finally {
      // Let the server control input state via control messages
      // Only focus the input, don't re-enable it
      inputRef.current?.focus();
    }
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!finalChannelIdForHooks || !messageId) return;
    const validMessageId = validateUuid(messageId);
    if (validMessageId) {
      // Immediately remove message from UI for optimistic update
      removeMessage(messageId);
      // Call server mutation to delete on backend
      deleteMessageCentral({ channelId: finalChannelIdForHooks, messageId: validMessageId });
    }
  };

  const handleRetryMessage = async (message: UiMessage) => {
    if (inputDisabledRef.current || (!message.text?.trim() && message.attachments?.length === 0)) {
      return;
    }
    updateChatState({ inputDisabled: true });
    const retryMessageId = randomUUID() as UUID;
    const finalTextContent =
      message.text?.trim() || `Shared ${message.attachments?.length} file(s).`;

    const optimisticUiMessage: UiMessage = {
      id: retryMessageId,
      text: message.text,
      name: USER_NAME,
      createdAt: Date.now(),
      senderId: currentClientEntityId,
      isAgent: false,
      isLoading: true,
      channelId: message.channelId,
      serverId: finalServerIdForHooks,
      source: chatType === ChannelType.DM ? CHAT_SOURCE : GROUP_CHAT_SOURCE,
      attachments: message.attachments,
    };

    addMessage(optimisticUiMessage);
    safeScrollToBottom();

    try {
      await sendMessage(
        finalTextContent,
        finalServerIdForHooks!,
        chatType === ChannelType.DM ? CHAT_SOURCE : GROUP_CHAT_SOURCE,
        message.attachments,
        retryMessageId,
        undefined,
        finalChannelIdForHooks!
      );
    } catch (error) {
      clientLogger.error('Error sending message or uploading files:', error);
      toast({
        title: 'Error Sending Message',
        description: error instanceof Error ? error.message : 'Could not send message.',
        variant: 'destructive',
      });
      updateMessage(retryMessageId, {
        isLoading: false,
        text: `${optimisticUiMessage.text || 'Attachment(s)'} (Failed to send)`,
      });
      updateChatState({ inputDisabled: false });
    }
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

  // Handle mobile detection and window resize
  useEffect(() => {
    const checkMobile = () => {
      const isMobile = window.innerWidth < 768;
      updateChatState({ isMobile });
      // Note: Don't auto-hide sidebar on mobile - let floating mode handle it
    };

    // Initial check
    checkMobile();

    // Add resize listener
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [updateChatState]);

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
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="relative flex-shrink-0">
              <Avatar className="size-4 sm:size-10 border rounded-full">
                <AvatarImage src={getAgentAvatar(targetAgentData)} />
              </Avatar>
              {targetAgentData?.status === AgentStatus.ACTIVE ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute bottom-0 right-0 size-2 sm:size-[10px] rounded-full border border-white bg-green-500" />
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Agent is active</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute bottom-0 right-0 size-2 sm:size-[10px] rounded-full border border-white bg-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Agent is inactive</p>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg truncate max-w-[80px] sm:max-w-none">
                  {targetAgentData?.name || 'Agent'}
                </h2>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 flex-shrink-0"
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
                  <span className="sm:hidden">
                    {/* Mobile: Show only first 30 characters */}
                    {((text) => (text.length > 30 ? `${text.substring(0, 30)}...` : text))(
                      Array.isArray(targetAgentData?.bio)
                        ? targetAgentData?.bio[0] || ''
                        : targetAgentData?.bio || ''
                    )}
                  </span>
                  <span className="hidden sm:inline">
                    {/* Desktop: Show full first bio entry or full bio */}
                    {Array.isArray(targetAgentData.bio)
                      ? targetAgentData.bio[0]
                      : targetAgentData.bio}
                  </span>
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-1 sm:gap-2 items-center flex-shrink-0">
            {chatType === ChannelType.DM && (
              <div className="flex items-center gap-1">
                {agentDmChannels.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-8 sm:max-w-[300px] sm:w-auto"
                      >
                        <History className="size-4 flex-shrink-0" />
                        <span className="hidden md:inline truncate text-xs sm:text-sm sm:ml-2">
                          {agentDmChannels.find((c) => c.id === chatState.currentDmChannelId)
                            ?.name || 'Select Chat'}
                        </span>
                        <Badge
                          variant="secondary"
                          className="hidden md:inline-flex ml-1 sm:ml-2 text-xs"
                        >
                          {agentDmChannels.length}
                        </Badge>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[280px] sm:w-[320px]">
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
                              <div className="flex flex-col min-w-0 flex-1">
                                <span
                                  className={cn(
                                    'text-sm truncate',
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
                                <Badge variant="default" className="text-xs flex-shrink-0 ml-2">
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

                {/* Chat Actions Split Button */}
                <SplitButton
                  mainAction={{
                    label: chatState.isCreatingDM ? (
                      'Creating...'
                    ) : (
                      <>
                        <span className="sm:hidden">New</span>
                        <span className="hidden sm:inline">New Chat</span>
                      </>
                    ),
                    onClick: () => handleNewDmChannel(targetAgentData?.id),
                    icon: chatState.isCreatingDM ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Plus className="size-4" />
                    ),
                    disabled: chatState.isCreatingDM || isLoadingAgentDmChannels,
                  }}
                  actions={[
                    {
                      label: 'Clear Messages',
                      onClick: handleClearChat,
                      icon: <Eraser className="size-4" />,
                      disabled: !messages || messages.length === 0,
                    },
                    {
                      label: 'Delete Chat',
                      onClick: handleDeleteCurrentDmChannel,
                      icon: <Trash2 className="size-4" />,
                      disabled: !chatState.currentDmChannelId,
                      variant: 'destructive',
                    },
                  ]}
                  variant="outline"
                  size="sm"
                  className="px-2 sm:px-3"
                />
              </div>
            )}

            <Separator orientation="vertical" className="h-8 hidden sm:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 sm:px-3 h-8 w-8 sm:w-auto ml-1 sm:ml-3"
                  onClick={toggleSidebar}
                >
                  {showSidebar ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRight className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{showSidebar ? 'Close SidePanel' : 'Open SidePanel'}</p>
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
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <h2 className="font-semibold text-lg truncate" title={groupDisplayName}>
                {groupDisplayName}
              </h2>
            </div>
            <div className="flex gap-1 sm:gap-2 items-center flex-shrink-0">
              {/* Group Actions Split Button */}
              <SplitButton
                mainAction={{
                  label: 'Edit Group',
                  onClick: () => updateChatState({ showGroupEditPanel: true }),
                  icon: <Edit className="size-4" />,
                }}
                actions={[
                  {
                    label: 'Clear Messages',
                    onClick: handleClearChat,
                    icon: <Eraser className="size-4" />,
                    disabled: !messages || messages.length === 0,
                  },
                  {
                    label: 'Delete Group',
                    onClick: () => {
                      if (!finalChannelIdForHooks || !finalServerIdForHooks) return;
                      confirm(
                        {
                          title: 'Delete Group',
                          description:
                            'Are you sure you want to delete this group? This action cannot be undone.',
                          confirmText: 'Delete',
                          variant: 'destructive',
                        },
                        async () => {
                          try {
                            await apiClient.deleteChannel(finalChannelIdForHooks);
                            toast({
                              title: 'Group Deleted',
                              description: 'The group has been successfully deleted.',
                            });
                            // Navigate back to home after deletion
                            window.location.href = '/';
                          } catch (error) {
                            clientLogger.error('[Chat] Error deleting group:', error);
                            toast({
                              title: 'Error',
                              description: 'Could not delete group.',
                              variant: 'destructive',
                            });
                          }
                        }
                      );
                    },
                    icon: <Trash2 className="size-4" />,
                    disabled: !finalChannelIdForHooks || !finalServerIdForHooks,
                    variant: 'destructive',
                  },
                ]}
                variant="outline"
                size="sm"
                className="px-2 sm:px-3"
              />
              <Button
                variant="ghost"
                size="sm"
                className="px-2 sm:px-3 h-8 w-8 sm:w-auto"
                onClick={toggleSidebar}
              >
                {showSidebar ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRight className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {groupAgents.length > 0 && (
            <div className="flex items-center gap-2 p-2 bg-card rounded-lg border overflow-x-auto">
              <span className="text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">
                Agents:
              </span>
              <div className="flex gap-2 min-w-0">
                <Button
                  variant={!chatState.selectedGroupAgentId ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => updateChatState({ selectedGroupAgentId: null })}
                  className="flex items-center gap-2 flex-shrink-0"
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
                      });
                      if (agent?.id && !showSidebar) {
                        setSidebarVisible(true);
                      }
                    }}
                    className="flex items-center gap-2 flex-shrink-0"
                  >
                    <Avatar className="size-5">
                      <AvatarImage src={getAgentAvatar(agent)} />
                    </Avatar>
                    <span className="truncate max-w-[100px] sm:max-w-none">{agent?.name}</span>
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
      <div className="h-full flex flex-col relative overflow-hidden">
        {/* Conditional layout based on floating mode */}
        {isFloatingMode ? (
          /* Single panel layout for floating mode */
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-shrink-0 p-2 sm:p-4 pb-0">{renderChatHeader()}</div>

            <div
              className={cn(
                'flex flex-col transition-all duration-300 w-full flex-1 min-h-0 overflow-hidden p-2 sm:p-4 pt-0'
              )}
            >
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatMessageListComponent
                  messages={messages}
                  isLoadingMessages={isLoadingMessages}
                  chatType={chatType}
                  currentClientEntityId={currentClientEntityId}
                  targetAgentData={targetAgentData}
                  allAgents={allAgents}
                  animatedMessageId={animatedMessageId}
                  scrollRef={scrollRef}
                  contentRef={contentRef}
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
        ) : (
          /* Resizable panel layout for desktop mode */
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full flex-1 overflow-hidden"
            onLayout={(sizes) => {
              if (sizes.length >= 2 && showSidebar && !chatState.isMobile) {
                setMainPanelSize(sizes[0]);
                setSidebarPanelSize(sizes[1]);
              }
            }}
          >
            <ResizablePanel
              defaultSize={showSidebar && !chatState.isMobile ? mainPanelSize : 100}
              minSize={chatState.isMobile ? 100 : 50}
            >
              <div className="relative h-full overflow-hidden">
                {/* Main chat content */}
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="flex-shrink-0 p-2 sm:p-4 pb-0">{renderChatHeader()}</div>

                  <div
                    className={cn(
                      'flex flex-col transition-all duration-300 w-full flex-1 min-h-0 overflow-hidden p-2 sm:p-4 pt-0'
                    )}
                  >
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <ChatMessageListComponent
                        messages={messages}
                        isLoadingMessages={isLoadingMessages}
                        chatType={chatType}
                        currentClientEntityId={currentClientEntityId}
                        targetAgentData={targetAgentData}
                        allAgents={allAgents}
                        animatedMessageId={animatedMessageId}
                        scrollRef={scrollRef}
                        contentRef={contentRef}
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
              let sidebarChannelId: UUID | undefined = undefined;

              if (chatType === ChannelType.DM) {
                sidebarAgentId = contextId; // This is agentId for DM
                sidebarAgentName = targetAgentData?.name || 'Agent';
                sidebarChannelId = chatState.currentDmChannelId || undefined;
              } else if (chatType === ChannelType.GROUP && chatState.selectedGroupAgentId) {
                sidebarAgentId = chatState.selectedGroupAgentId;
                const selectedAgent = allAgents.find(
                  (a) => a.id === chatState.selectedGroupAgentId
                );
                sidebarAgentName = selectedAgent?.name || 'Group Member';
                sidebarChannelId = contextId; // contextId is the channelId for GROUP
              } else if (chatType === ChannelType.GROUP && !chatState.selectedGroupAgentId) {
                sidebarAgentName = 'Group';
                sidebarChannelId = contextId; // contextId is the channelId for GROUP
              }

              return (
                showSidebar &&
                !chatState.isMobile && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={sidebarPanelSize} minSize={20} maxSize={50}>
                      <AgentSidebar
                        agentId={sidebarAgentId}
                        agentName={sidebarAgentName}
                        channelId={sidebarChannelId}
                      />
                    </ResizablePanel>
                  </>
                )
              );
            })()}
          </ResizablePanelGroup>
        )}

        {/* Floating sidebar overlay for narrow screens */}
        {(() => {
          let sidebarAgentId: UUID | undefined = undefined;
          let sidebarAgentName: string = 'Agent';
          let sidebarChannelId: UUID | undefined = undefined;

          if (chatType === ChannelType.DM) {
            sidebarAgentId = contextId; // This is agentId for DM
            sidebarAgentName = targetAgentData?.name || 'Agent';
            sidebarChannelId = chatState.currentDmChannelId || undefined;
          } else if (chatType === ChannelType.GROUP && chatState.selectedGroupAgentId) {
            sidebarAgentId = chatState.selectedGroupAgentId;
            const selectedAgent = allAgents.find((a) => a.id === chatState.selectedGroupAgentId);
            sidebarAgentName = selectedAgent?.name || 'Group Member';
            sidebarChannelId = contextId; // contextId is the channelId for GROUP
          } else if (chatType === ChannelType.GROUP && !chatState.selectedGroupAgentId) {
            sidebarAgentName = 'Group';
            sidebarChannelId = contextId; // contextId is the channelId for GROUP
          }

          return (
            showSidebar &&
            isFloatingMode && (
              <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm">
                <div className="absolute inset-0 bg-background shadow-lg">
                  <div className="h-full flex flex-col">
                    {/* Close button for floating sidebar */}
                    <div className="flex items-center justify-between p-4 border-b">
                      <h3 className="font-semibold text-lg">{sidebarAgentName}</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSidebarVisible(false)}
                        className="h-8 w-8 p-0"
                      >
                        <PanelRightClose className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <AgentSidebar
                        agentId={sidebarAgentId}
                        agentName={sidebarAgentName}
                        channelId={sidebarChannelId}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          );
        })()}
      </div>

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
