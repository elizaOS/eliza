import { Button } from '@/components/ui/button';
import {
  ChatBubble,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from '@/components/ui/chat/chat-bubble';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { ChatMessageList } from '@/components/ui/chat/chat-message-list';
import { USER_NAME } from '@/constants';
import { useAgent, useMessages } from '@/hooks/use-query-hooks';
import { cn, getEntityId, moment } from '@/lib/utils';
import SocketIOManager from '@/lib/socketio-manager';
import { WorldManager } from '@/lib/world-manager';
import type { IAttachment } from '@/types';
import type { Content, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, MenuIcon, Paperclip, Send, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import AIWriter from 'react-aiwriter';
import { AgentActionViewer } from './action-viewer';
import { AudioRecorder } from './audio-recorder';
import CopyButton from './copy-button';
import { LogViewer } from './log-viewer';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { Badge } from './ui/badge';
import ChatTtsButton from './ui/chat/chat-tts-button';
import { useAutoScroll } from './ui/chat/hooks/useAutoScroll';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { v4 as uuidv4 } from 'uuid';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';

const SOURCE_NAME = 'client_chat';

type ExtraContentFields = {
  name: string;
  createdAt: number;
  isLoading?: boolean;
};

type ContentWithUser = Content & ExtraContentFields;

function MessageContent({
  message,
  agentId,
  isLastMessage,
}: {
  message: ContentWithUser;
  agentId: UUID;
  isLastMessage: boolean;
}) {
  return (
    <div className="flex flex-col">
      <ChatBubbleMessage
        isLoading={message.isLoading}
        {...(message.name === USER_NAME ? { variant: 'sent' } : {})}
      >
        {message.name === USER_NAME ? (
          message.text
        ) : isLastMessage && message.name !== USER_NAME ? (
          <AIWriter>{message.text}</AIWriter>
        ) : (
          message.text
        )}
        {/* Attachments */}
        <div>
          {message.attachments?.map((attachment: IAttachment) => (
            <div className="flex flex-col gap-1 mt-2" key={`${attachment.url}-${attachment.title}`}>
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
        </div>
      </ChatBubbleMessage>
      <div className="flex items-center gap-4 justify-between w-full mt-1">
        {message.text && !message.isLoading ? (
          <div className="flex items-center gap-1">
            <CopyButton text={message.text} />
            <ChatTtsButton agentId={agentId} text={message.text} />
          </div>
        ) : null}
        <div
          className={cn([
            message.isLoading ? 'mt-2' : '',
            'flex items-center justify-between gap-4 select-none',
          ])}
        >
          {message.thought ? <Badge variant="outline">{message.thought}</Badge> : null}
          {message.plan ? <Badge variant="outline">{message.plan}</Badge> : null}
          {message.createdAt ? (
            <ChatBubbleTimestamp timestamp={moment(message.createdAt).format('LT')} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { agentId, roomId: roomIdFromParams } = useParams();
  const navigate = useNavigate();
  const socketIOManager = useMemo(() => SocketIOManager.getInstance(), []);

  // Redirect if no agent ID is found
  useEffect(() => {
    if (!agentId) {
      navigate('/agents', { replace: true });
    }
  }, [agentId, navigate]);

  // Determine if the room ID is a conceptual room
  const isConceptualRoom = useMemo(() => {
    return roomIdFromParams && roomIdFromParams.length >= 36;
  }, [roomIdFromParams]);

  // Store both IDs, using different state variables for clarity
  const [conceptualRoomId] = useState<string | undefined>(
    isConceptualRoom ? roomIdFromParams : undefined
  );

  const [roomId] = useState<string | undefined>(
    !isConceptualRoom && roomIdFromParams ? roomIdFromParams : agentId
  );

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [input, setInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [detailsTab, setDetailsTab] = useState<'actions' | 'logs'>('actions');
  const [messages, setMessages] = useState<ContentWithUser[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialScrollRef = useRef<boolean>(false);

  // Only try to use the hooks that require UUID when we have a valid agentId
  const validAgentId =
    typeof agentId === 'string' && agentId.length >= 36 ? (agentId as UUID) : null;
  const validRoomId =
    typeof roomId === 'string' && roomId.length >= 36 ? (roomId as UUID) : validAgentId;

  const agentData = validAgentId ? useAgent(validAgentId)?.data?.data : undefined;
  const entityId = getEntityId();

  // Only log when we have valid IDs to prevent console spam
  useEffect(() => {
    if (agentId) {
      console.log(`[Chat] Initializing chat with agent ${agentId} and room ${roomId || 'default'}`);
    }
  }, [agentId, roomId]);

  // Use useMessages to get messages for this room if we have valid IDs
  const { data: fetchedMessages = [] } =
    validAgentId && validRoomId ? useMessages(validAgentId, validRoomId) : { data: [] };

  // Update state messages when fetched messages change
  useEffect(() => {
    // Only update if we have messages and they're different from current state
    if (fetchedMessages && fetchedMessages.length > 0) {
      setMessages((prevMessages) => {
        // Deep compare to prevent unnecessary updates
        if (
          prevMessages.length === fetchedMessages.length &&
          JSON.stringify(prevMessages) === JSON.stringify(fetchedMessages)
        ) {
          return prevMessages;
        }
        return fetchedMessages as ContentWithUser[];
      });
    }
  }, [fetchedMessages]);

  // Setup WebSocket connection
  useEffect(() => {
    if (!agentId) {
      return; // Don't attempt connection without agentId
    }

    console.log(
      `Setting up socket connection for ${isConceptualRoom ? 'conceptual room' : 'direct room'}`
    );

    setIsConnecting(true);

    // Connect to the room - use the correct connect method parameters
    socketIOManager.connectToRoom(roomId || agentId);
    setIsConnected(true);
    setIsConnecting(false);

    return () => {
      // Disconnect when component unmounts - use the correct disconnect method
      if (roomId) {
        socketIOManager.disconnectFromRoom(roomId);
      } else if (agentId) {
        socketIOManager.disconnectFromRoom(agentId);
      }
    };
  }, [agentId, roomId, isConceptualRoom, socketIOManager]);

  // Scroll to bottom function
  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messagesEndRef]);

  // Setup message listener with direct event emitter approach
  useEffect(() => {
    if (!socketIOManager || !agentId) return;

    // Handle both types of events we might receive
    const handleMessageEvent = (data: {
      id?: string;
      messageId?: string;
      text?: string;
      message?: string;
      entityId?: string;
      senderId?: string;
      userName?: string;
      createdAt?: number;
      timestamp?: number;
      file?: string;
    }) => {
      console.log('Received message event:', data);

      // Create a common message format regardless of event source
      const messageData = {
        id: data.id || data.messageId || `msg-${Date.now()}`,
        text: data.text || data.message || '',
        sender: data.entityId || data.senderId || '',
        userName: data.userName || 'User',
        createdAt: data.createdAt || data.timestamp || Date.now(),
        file: data.file,
      };

      // Create UI message
      const newMessage: ContentWithUser = {
        id: messageData.id,
        text: messageData.text,
        sender: messageData.sender,
        name: messageData.userName,
        createdAt: messageData.createdAt,
        isLoading: false,
        files: messageData.file ? [messageData.file] : [],
      };

      // Add to messages if not already present
      setMessages((prevMessages) => {
        if (prevMessages.some((m) => m.id === newMessage.id)) {
          return prevMessages;
        }
        return [...prevMessages, newMessage];
      });

      // Auto-scroll to bottom
      setTimeout(scrollToBottom, 100);
    };

    // Subscribe directly to socket events using EventEmitter
    socketIOManager.on('messageBroadcast', handleMessageEvent);

    return () => {
      socketIOManager.off('messageBroadcast', handleMessageEvent);
    };
  }, [agentId, socketIOManager, scrollToBottom]);

  // Helper function to safely get agent/room ID for functions that require UUID
  const getSafeUUID = (id?: string) => {
    if (typeof id === 'string' && id.length >= 36) {
      return id as UUID;
    }
    return undefined;
  };

  // Use the helper function when passing IDs to components
  const safeAgentId = getSafeUUID(agentId);
  const safeRoomId = getSafeUUID(roomId);

  // Initial scroll when messages are loaded
  useEffect(() => {
    if (!initialScrollRef.current && messages.length > 0) {
      scrollToBottom();
      initialScrollRef.current = true;
    }
  }, [messages.length]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      handleSendMessage();
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() && !selectedFile) return;

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create new message for UI display
    const newMessage: ContentWithUser = {
      id: messageId,
      text: input,
      sender: entityId,
      name: 'You',
      createdAt: Date.now(),
      isLoading: false,
      files: selectedFile ? [selectedFile.name] : [],
    };

    // Save the message text before clearing the input
    const messageText = input;

    // Update messages state immediately for UI responsiveness
    setMessages((prev) => [...prev, newMessage]);

    // Clear input field
    setInput('');
    setSelectedFile(null);

    try {
      let filePath = null;

      // Handle file upload if needed
      if (selectedFile) {
        const formData = new FormData();
        formData.append('file', selectedFile);

        try {
          const response = await axios.post(
            `${import.meta.env.VITE_API_URL || ''}/api/upload`,
            formData,
            {
              headers: {
                'Content-Type': 'multipart/form-data',
              },
            }
          );

          if (response.data.success) {
            filePath = response.data.data;
            console.log('File uploaded successfully:', filePath);
          } else {
            console.error('File upload failed', response.data);
            setConnectionError('File upload failed');
          }
        } catch (uploadError) {
          console.error('Error uploading file:', uploadError);
          setConnectionError('Error uploading file');
        }
      }

      // Get the target room ID - make sure we have a valid value
      const targetRoomId = roomId || agentId || '';
      if (!targetRoomId) {
        console.error('No valid room ID for sending message');
        setConnectionError('Error: No valid room to send message to');
        return;
      }

      console.log(`Sending message to room ${targetRoomId}: ${messageText.substring(0, 50)}`);

      // First check if socket is connected
      if (!socketIOManager.isConnected()) {
        console.log('Socket not connected, attempting to connect...');
        try {
          const connected = await socketIOManager.connect();
          if (!connected) {
            console.error('Failed to establish connection');
            setConnectionError('Failed to establish connection');
            return;
          }
        } catch (connError) {
          console.error('Connection error:', connError);
          setConnectionError('Failed to establish connection');
          return;
        }
      }

      // Attempt to send the message using the broadcast method
      const success = await socketIOManager.handleBroadcastMessage(
        entityId,
        'You',
        messageText,
        targetRoomId,
        'user'
      );

      if (!success) {
        console.error('Failed to send message');
        setConnectionError('Failed to send message - connection issue');
      } else {
        // Clear any previous error since we succeeded
        setConnectionError(null);
      }

      // Scroll to bottom
      setTimeout(scrollToBottom, 100);
    } catch (error) {
      console.error('Error sending message:', error);
      setConnectionError('Error sending message');
    }
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

  const toggleDetails = () => {
    setShowDetails(!showDetails);
  };

  const { scrollRef, isAtBottom, disableAutoScroll } = useAutoScroll({
    smooth: true,
  });

  const getMessageVariant = (id: string) => {
    return id ? 'received' : 'sent';
  };

  return (
    <div className="flex flex-col w-full h-screen p-4">
      {/* Agent Header */}
      <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 border rounded-full">
            <AvatarImage
              src={agentData?.settings?.avatar ? agentData?.settings?.avatar : '/elizaos-icon.png'}
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

        <Button
          variant="outline"
          size="sm"
          onClick={toggleDetails}
          className={cn('gap-1.5', showDetails && 'bg-secondary')}
        >
          <MenuIcon className="size-4" />
        </Button>
      </div>

      <div className="flex flex-row w-full overflow-y-auto grow gap-4">
        {/* Main Chat Area */}
        <div
          className={cn(
            'flex flex-col transition-all duration-300',
            showDetails ? 'w-3/5' : 'w-full'
          )}
        >
          {/* Chat Messages */}
          <ChatMessageList
            scrollRef={scrollRef}
            isAtBottom={isAtBottom}
            scrollToBottom={scrollToBottom}
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
                    variant={getMessageVariant(isUser ? entityId : safeAgentId || '')}
                    className={`flex flex-row items-center gap-2 ${
                      isUser ? 'flex-row-reverse' : ''
                    }`}
                  >
                    <Avatar className="size-8 border rounded-full select-none">
                      <AvatarImage
                        src={
                          isUser
                            ? '/user-icon.png'
                            : agentData?.settings?.avatar
                              ? agentData?.settings?.avatar
                              : '/elizaos-icon.png'
                        }
                      />

                      {isUser && <AvatarFallback>U</AvatarFallback>}
                    </Avatar>
                    <MessageContent
                      message={message}
                      agentId={safeAgentId || ('' as UUID)}
                      isLastMessage={index === messages.length - 1}
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
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
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
                {safeAgentId && (
                  <AudioRecorder
                    agentId={safeAgentId}
                    onChange={(newInput: string) => setInput(newInput)}
                  />
                )}
                <Button type="submit" size="sm" className="ml-auto gap-1.5 h-[30px]">
                  <Send className="size-3.5" />
                </Button>
              </div>
            </form>
          </div>
        </div>

        {/* Details Column */}
        {showDetails && (
          <div className="w-2/5 border rounded-lg overflow-hidden pb-4 bg-background flex flex-col h-full">
            <Tabs
              defaultValue="actions"
              value={detailsTab}
              onValueChange={(v) => setDetailsTab(v as 'actions' | 'logs')}
              className="flex flex-col h-full"
            >
              <div className="border-b px-4 py-2">
                <TabsList className="grid grid-cols-2">
                  <TabsTrigger value="actions" className="flex items-center gap-1.5">
                    <Activity className="h-4 w-4" />
                    <span>Agent Actions</span>
                  </TabsTrigger>
                  <TabsTrigger value="logs" className="flex items-center gap-1.5">
                    <Terminal className="h-4 w-4" />
                    <span>Logs</span>
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="actions" className="overflow-y-scroll">
                {safeAgentId && <AgentActionViewer agentId={safeAgentId} roomId={safeRoomId} />}
              </TabsContent>
              <TabsContent value="logs">
                <LogViewer agentName={agentData?.name} level="all" hideTitle />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
