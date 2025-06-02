import AgentDetailsPanel from '@/components/AgentDetailsPanel';
import CopyButton from '@/components/copy-button';
import DeleteButton from '@/components/delete-button';
import MediaContent from '@/components/media-content';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import clientLogger from '@/lib/logger';
import { parseMediaFromText, removeMediaUrlsFromText, type MediaInfo } from '@/lib/media-utils';
import { cn, getEntityId, moment, randomUUID, getAgentAvatar, generateGroupName } from '@/lib/utils';
import type { Agent, Media, UUID } from '@elizaos/core';
import { AgentStatus, ContentType as CoreContentType, validateUuid } from '@elizaos/core';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@radix-ui/react-collapsible';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Loader2, PanelRight, PanelRightClose, Trash2, MessageSquarePlus, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AIWriter from 'react-aiwriter';
import { ChatInputArea } from './ChatInputArea';
import { ChatMessageListComponent } from './ChatMessageListComponent';
import GroupPanel from './group-panel';
import { AgentSidebar } from './agent-sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import relativeTime from 'dayjs/plugin/relativeTime';
moment.extend(relativeTime);

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

interface UnifiedChatViewProps {
  chatType: 'DM' | 'GROUP';
  contextId: UUID; // agentId for DM, channelId for GROUP
  serverId?: UUID; // Required for GROUP, optional for DM
}

// Message content component - exported for use in ChatMessageListComponent
export const MemoizedMessageContent = React.memo(MessageContent);

export function MessageContent({
  message,
  agentForTts,
  shouldAnimate,
  onDelete,
  isUser,
  getAgentInMessage,
  agentAvatarMap,
}: {
  message: UiMessage;
  agentForTts?: Agent | Partial<Agent> | null;
  shouldAnimate?: boolean;
  onDelete: (id: string) => void;
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

export default function chat({ chatType, contextId, serverId }: UnifiedChatViewProps) {
  const [showSidebar, setShowSidebar] = useState(false);
  const [input, setInput] = useState('');
  const [inputDisabled, setInputDisabled] = useState<boolean>(false);
  const [selectedGroupAgentId, setSelectedGroupAgentId] = useState<UUID | null>(null);
  const [showGroupEditPanel, setShowGroupEditPanel] = useState(false);

  // State for Requirement #1: Multiple DM Channels with a single agent
  const [agentDmChannels, setAgentDmChannels] = useState<{ id: UUID, name: string, createdAt?: number, lastActivity?: number }[]>([]);
  const [currentDmChannelIdForAgent, setCurrentDmChannelIdForAgent] = useState<UUID | null>(null);
  const [isLoadingAgentDmChannels, setIsLoadingAgentDmChannels] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const currentClientEntityId = getEntityId();

  // For DM, we need agent data. For GROUP, we need channel data
  const { data: agentDataResponse, isLoading: isLoadingAgent } = useAgent(
    chatType === 'DM' ? contextId : undefined,
    { enabled: chatType === 'DM' }
  );

  // Convert AgentWithStatus to Agent, ensuring required fields have defaults
  const targetAgentData: Agent | undefined = agentDataResponse?.data
    ? ({
      ...agentDataResponse.data,
      createdAt: agentDataResponse.data.createdAt || Date.now(),
      updatedAt: agentDataResponse.data.updatedAt || Date.now(),
    } as Agent)
    : undefined;

  // Group chat specific data
  const { data: channelDetailsData } = useChannelDetails(
    chatType === 'GROUP' ? contextId : undefined
  );
  const { data: participantsData } = useChannelParticipants(
    chatType === 'GROUP' ? contextId : undefined
  );
  const participants = participantsData?.data;

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

  // DM channel management
  const [dmChannelData, setDmChannelData] = useState<{ channelId: UUID; serverId: UUID } | null>(
    null
  );
  const [isCreatingDM, setIsCreatingDM] = useState(false);

  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll, autoScrollEnabled } = useAutoScroll({ smooth: true });
  const prevMessageCountRef = useRef(0);
  const safeScrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      setTimeout(() => scrollToBottom(), 0);
    }
  }, [scrollToBottom, scrollRef]);

  // Define handlers before useEffect that might call them
  const handleSelectDmRoom = (channelIdToSelect: UUID) => {
    const selectedChannel = agentDmChannels.find(channel => channel.id === channelIdToSelect);
    if (selectedChannel) {
      clientLogger.info(`[Chat] DM Channel selected: ${selectedChannel.name} (Channel ID: ${selectedChannel.id})`);
      setCurrentDmChannelIdForAgent(selectedChannel.id);
      setInput('');
      setTimeout(() => safeScrollToBottom(), 150);
      // TODO: Update URL if using /chat/:agentId/:channelId
    }
  };

  const handleNewDmChannel = async (agentIdForNewChannel: UUID | undefined) => {
    if (!agentIdForNewChannel || chatType !== 'DM') return;
    clientLogger.info(`[Chat] Creating new DM channel with agent ${agentIdForNewChannel}`);
    setIsCreatingDM(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const newChannelSimulated = {
        id: randomUUID() as UUID,
        name: `New Chat - ${moment().format('HH:mm')}`,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };
      setAgentDmChannels(prevChannels => [newChannelSimulated, ...prevChannels].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)));
      setCurrentDmChannelIdForAgent(newChannelSimulated.id);
      setInput('');
      toast({ title: 'New Chat Created', description: `Switched to "${newChannelSimulated.name}"` });
      setTimeout(() => safeScrollToBottom(), 150);
    } catch (error) {
      clientLogger.error('[Chat] Error creating new DM channel:', error);
      toast({ title: 'Error', description: 'Could not create new chat.', variant: 'destructive' });
    } finally {
      setIsCreatingDM(false);
    }
  };

  const handleDeleteCurrentDmChannel = async () => {
    if (chatType !== 'DM' || !currentDmChannelIdForAgent || !targetAgentData?.id) return;
    const channelToDelete = agentDmChannels.find(ch => ch.id === currentDmChannelIdForAgent);
    if (!channelToDelete) return;
    const confirm = window.confirm(`Are you sure you want to delete the chat "${channelToDelete.name}" with ${targetAgentData.name}? This action cannot be undone.`);
    if (!confirm) return;
    clientLogger.info(`[Chat] Deleting DM channel ${currentDmChannelIdForAgent}`);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      toast({ title: 'Chat Deleted', description: `"${channelToDelete.name}" was deleted.` });
      const remainingChannels = agentDmChannels.filter(ch => ch.id !== currentDmChannelIdForAgent);
      setAgentDmChannels(remainingChannels.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)));
      if (remainingChannels.length > 0) {
        setCurrentDmChannelIdForAgent(remainingChannels[0].id);
        clientLogger.info('[Chat] Switched to DM channel:', remainingChannels[0].id);
      } else {
        clientLogger.info('[Chat] No DM channels left after deletion, creating a new one.');
        handleNewDmChannel(targetAgentData.id);
      }
    } catch (error) {
      clientLogger.error('[Chat] Error deleting DM channel:', error);
      toast({ title: 'Error', description: 'Could not delete chat.', variant: 'destructive' });
    }
  };

  // Req #1: Effect to fetch/simulate DM channels for the current agent
  useEffect(() => {
    if (chatType === 'DM' && targetAgentData?.id) {
      setIsLoadingAgentDmChannels(true);
      clientLogger.info(`[Chat] Fetching/simulating DM channels for agent ${targetAgentData.id}`);
      const simulateApiCall = setTimeout(() => {
        const fetchedChannelsFromApi = [
          { id: randomUUID() as UUID, name: 'Initial Chat', createdAt: Date.now() - 3600000, lastActivity: Date.now() - 10000 },
          { id: randomUUID() as UUID, name: 'Project Discussion', createdAt: Date.now() - 7200000, lastActivity: Date.now() - 20000 },
          { id: randomUUID() as UUID, name: 'Follow-up', createdAt: Date.now() - 10800000, lastActivity: Date.now() - 30000 },
        ].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
        setAgentDmChannels(fetchedChannelsFromApi);
        if (fetchedChannelsFromApi.length > 0) {
          setCurrentDmChannelIdForAgent(fetchedChannelsFromApi[0].id);
        } else {
          handleNewDmChannel(targetAgentData.id);
        }
        setIsLoadingAgentDmChannels(false);
      }, 500);
      return () => clearTimeout(simulateApiCall);
    } else {
      setAgentDmChannels([]);
      setCurrentDmChannelIdForAgent(null);
    }
  }, [chatType, targetAgentData?.id]);

  const finalChannelIdForHooks: UUID | undefined = useMemo(() => {
    return chatType === 'DM'
      ? (currentDmChannelIdForAgent || undefined)
      : (contextId || undefined);
  }, [chatType, currentDmChannelIdForAgent, contextId]);

  const finalServerIdForHooks: UUID | undefined = useMemo(() => {
    return chatType === 'DM'
      ? DEFAULT_SERVER_ID
      : (serverId || undefined);
  }, [chatType, serverId]);

  const {
    data: messages = [], isLoading: isLoadingMessages, addMessage, updateMessage, removeMessage
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
        clientLogger.debug(
          '[chat] New messages, but autoScroll is disabled (user scrolled up).'
        );
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
    onInputDisabledChange: setInputDisabled,
  });

  const {
    selectedFiles, handleFileChange, removeFile, createBlobUrls, uploadFiles, cleanupBlobUrls, clearFiles, getContentTypeFromMimeType
  } = useFileUpload({
    agentId: targetAgentData?.id,
    channelId: finalChannelIdForHooks,
    chatType,
  });

  useEffect(() => {
    clientLogger.info('[chat] Mounted/Updated', { chatType, contextId, serverId });
    return () => {
      clientLogger.info('[chat] Unmounted');
    };
  }, [chatType, contextId, serverId]);

  // RESTORED HANDLERS //
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if ((!input.trim() && selectedFiles.length === 0) || inputDisabled || !finalChannelIdForHooks || !finalServerIdForHooks || !currentClientEntityId || (chatType === 'DM' && !targetAgentData?.id)) return;

    setInputDisabled(true);
    const tempMessageId = randomUUID() as UUID;
    let messageText = input.trim();
    const currentInputVal = input;
    setInput('');
    const currentSelectedFiles = [...selectedFiles];
    clearFiles();
    formRef.current?.reset();
    const optimisticAttachments = createBlobUrls(currentSelectedFiles);
    const optimisticUiMessage: UiMessage = {
      id: tempMessageId, text: messageText, name: USER_NAME, createdAt: Date.now(), senderId: currentClientEntityId, isAgent: false, isLoading: true,
      channelId: finalChannelIdForHooks,
      serverId: finalServerIdForHooks,
      source: chatType === 'DM' ? CHAT_SOURCE : GROUP_CHAT_SOURCE, attachments: optimisticAttachments,
    };
    if (messageText || currentSelectedFiles.length > 0) addMessage(optimisticUiMessage);
    safeScrollToBottom();
    try {
      let processedUiAttachments: Media[] = [];
      if (currentSelectedFiles.length > 0) {
        const { uploaded, failed, blobUrls } = await uploadFiles(currentSelectedFiles);
        processedUiAttachments = uploaded;
        if (failed.length > 0) updateMessage(tempMessageId, { attachments: optimisticUiMessage.attachments?.filter(att => !failed.some(f => f.file.id === att.id)) });
        cleanupBlobUrls(blobUrls);
        if (!messageText.trim() && processedUiAttachments.length > 0) messageText = `Shared ${processedUiAttachments.length} file(s).`;
      }
      const mediaInfosFromText = parseMediaFromText(currentInputVal);
      const textMediaAttachments: Media[] = mediaInfosFromText.map((media: MediaInfo, index: number): Media => ({ id: `textmedia-${tempMessageId}-${index}`, url: media.url, title: media.type === 'image' ? 'Image' : media.type === 'video' ? 'Video' : 'Media Link', source: 'user_input_url', contentType: media.type === 'image' ? CoreContentType.IMAGE : media.type === 'video' ? CoreContentType.VIDEO : undefined }));
      const finalAttachments = [...processedUiAttachments, ...textMediaAttachments];
      const finalTextContent = messageText || (finalAttachments.length > 0 ? `Shared content.` : '');
      if (!finalTextContent.trim() && finalAttachments.length === 0) {
        setInputDisabled(false); removeMessage(tempMessageId); return;
      }
      await sendMessage(finalTextContent, finalServerIdForHooks, chatType === 'DM' ? CHAT_SOURCE : GROUP_CHAT_SOURCE, finalAttachments.length > 0 ? finalAttachments : undefined, tempMessageId);
    } catch (error) {
      clientLogger.error('Error sending message or uploading files:', error);
      toast({ title: 'Error Sending Message', description: error instanceof Error ? error.message : 'Could not send message.', variant: 'destructive' });
      updateMessage(tempMessageId, { isLoading: false, text: `${optimisticUiMessage.text || 'Attachment(s)'} (Failed to send)` });
    } finally {
      setInputDisabled(false); inputRef.current?.focus();
    }
  };

  const handleDeleteMessage = (messageId: string) => {
    if (!finalChannelIdForHooks || !messageId) return;
    const validMessageId = validateUuid(messageId);
    if (validMessageId) {
      deleteMessageCentral({ channelId: finalChannelIdForHooks, messageId: validMessageId });
    }
  };

  const handleClearChat = () => {
    if (chatType !== 'GROUP' || !finalChannelIdForHooks) return;
    if (window.confirm(`Clear all messages in this group chat?`)) {
      clearMessagesCentral(finalChannelIdForHooks);
    }
  };
  // END RESTORED HANDLERS //

  if (chatType === 'DM' && (isLoadingAgent || (!targetAgentData && contextId) || isLoadingAgentDmChannels)) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!finalChannelIdForHooks || !finalServerIdForHooks || (chatType === 'DM' && !targetAgentData)) {
    return (
      <div className="flex flex-1 justify-center items-center">
        <p>Loading chat context...</p>
      </div>
    );
  }

  // Chat header
  const renderChatHeader = () => {
    if (chatType === 'DM' && targetAgentData) {
      return (
        <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
          <div className="flex items-center gap-3">
            <Avatar className="size-10 border rounded-full">
              <AvatarImage src={getAgentAvatar(targetAgentData)} />
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
          <div className="flex gap-2 items-center">
            {chatType === 'DM' && (
              <div className="flex items-center gap-1">
                {agentDmChannels.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <MessageSquarePlus className="size-4 mr-2" />
                        {agentDmChannels.find(c => c.id === currentDmChannelIdForAgent)?.name || 'Select Chat'} ({agentDmChannels.length})
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Chat Sessions with {targetAgentData.name}</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {agentDmChannels.map((channel) => (
                        <DropdownMenuItem
                          key={channel.id}
                          onClick={() => handleSelectDmRoom(channel.id)}
                          disabled={channel.id === currentDmChannelIdForAgent}
                        >
                          {channel.name} ({moment(channel.lastActivity || channel.createdAt).fromNow()})
                          {channel.id === currentDmChannelIdForAgent && <span className="text-xs text-muted-foreground ml-2">(Current)</span>}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="outline" size="sm" onClick={() => handleNewDmChannel(targetAgentData?.id)} disabled={isCreatingDM || isLoadingAgentDmChannels}>
                  {isCreatingDM ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
                  New Chat
                </Button>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={chatType === 'DM' ? handleDeleteCurrentDmChannel : handleClearChat}
              disabled={!messages || messages.length === 0 || (chatType === 'DM' && !currentDmChannelIdForAgent)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      );
    } else if (chatType === 'GROUP') {
      // Get agents in this group from participants
      const groupAgents =
        participants
          ?.filter((p) => allAgents.some((a) => a.id === p))
          .map((pId) => allAgents.find((a) => a.id === pId))
          .filter(Boolean) as Partial<Agent>[] || [];

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
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowGroupEditPanel(true)}>
                Edit Group
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearChat}
                disabled={!messages || messages.length === 0}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

          {groupAgents.length > 0 && (
            <div className="flex items-center gap-2 p-2 bg-card rounded-lg border overflow-x-auto">
              <span className="text-sm text-muted-foreground whitespace-nowrap">Agents:</span>
              <div className="flex gap-2">
                <Button
                  variant={!selectedGroupAgentId ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setSelectedGroupAgentId(null)}
                  className="flex items-center gap-2"
                >
                  <span>All</span>
                </Button>
                {groupAgents.map((agent) => (
                  <Button
                    key={agent?.id}
                    variant={selectedGroupAgentId === agent?.id ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSelectedGroupAgentId(agent?.id || null)}
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
        <ResizablePanel defaultSize={showSidebar ? 70 : 100} minSize={50}>
          <div className="relative h-full">
            {/* Sidebar toggle button */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 z-10"
              onClick={() => setShowSidebar(!showSidebar)}
            >
              {showSidebar ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRight className="h-4 w-4" />
              )}
            </Button>

            {/* Main chat content */}
            <div className="h-full flex flex-col p-4">
              {renderChatHeader()}

              <div
                className={cn(
                  'flex flex-col transition-all duration-300 w-full grow overflow-hidden '
                )}
              >
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
                  selectedGroupAgentId={selectedGroupAgentId}
                />

                <ChatInputArea
                  input={input}
                  setInput={setInput}
                  inputDisabled={inputDisabled}
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
        </ResizablePanel>

        {/* ---------- right panel / sidebar ---------- */}
        {(() => {
          let sidebarAgentId: UUID | undefined = undefined;
          let sidebarAgentName: string = 'Agent';

          if (chatType === 'DM') {
            sidebarAgentId = contextId; // This is agentId for DM
            sidebarAgentName = targetAgentData?.name || 'Agent';
          } else if (chatType === 'GROUP' && selectedGroupAgentId) {
            sidebarAgentId = selectedGroupAgentId;
            const selectedAgent = allAgents.find(a => a.id === selectedGroupAgentId);
            sidebarAgentName = selectedAgent?.name || 'Group Member';
          } else if (chatType === 'GROUP' && !selectedGroupAgentId) {
            // In group chat, if no specific agent is selected, sidebar might be disabled or show group info
            // For now, AgentSidebar will show "Select an agent" as per its internal logic if agentId is undefined.
            sidebarAgentName = 'Group'; // Or some generic name
          }

          // The old AgentDetailsPanel logic is now intended to be within AgentSidebar's "Details" tab
          // The ResizablePanel for AgentDetailsPanel is removed if AgentSidebar is the primary right panel.

          // If showSidebar is true, AgentSidebar will be visible due to the ResizablePanelGroup structure
          // However, the current structure has AgentSidebar *outside* the conditional showSidebar block for AgentDetailsPanel
          // This means AgentSidebar might always be taking space.
          // Let's assume AgentSidebar is the *only* component in the right-most ResizablePanel when showSidebar is true.

          return (
            showSidebar && (
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

      {showGroupEditPanel && chatType === 'GROUP' && (
        <GroupPanel
          agents={allAgents}
          onClose={() => setShowGroupEditPanel(false)}
          channelId={contextId}
        />
      )}
    </>
  );
}
