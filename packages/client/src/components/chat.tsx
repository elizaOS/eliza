import { Button } from "@/components/ui/button";
import {
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { Skeleton } from "@/components/ui/skeleton";
import { USER_NAME } from "@/constants";
import { useAgent, useMessages } from "@/hooks/use-query-hooks";
import { toast } from "@/hooks/use-toast";
import SocketIOManager from "@/lib/socketio-manager";
import { cn, formatAgentName, getEntityId, moment } from "@/lib/utils";
import { WorldManager } from "@/lib/world-manager";
import type { IAttachment } from "@/types";
import type { Content, UUID } from "@elizaos/core";
import { type Agent, AgentStatus } from "@elizaos/core";
import { useQueryClient } from "@tanstack/react-query";
import { Hash, Paperclip, Send } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import AIWriter from "react-aiwriter";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { type Socket, io } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";
import { AudioRecorder } from "./audio-recorder";
import CopyButton from "./copy-button";
import { LogViewer } from "./log-viewer";
import { Badge } from "./ui/badge";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { useAutoScroll } from "./ui/chat/hooks/useAutoScroll";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { validateUuid, stringToUuid } from "@elizaos/core";

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
        {...(message.name === USER_NAME ? { variant: "sent" } : {})}
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
            <div
              className="flex flex-col gap-1 mt-2"
              key={`${attachment.url}-${attachment.title}`}
            >
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
            message.isLoading ? "mt-2" : "",
            "flex items-center justify-between gap-4 select-none",
          ])}
        >
          {message.thought ? (
            <Badge variant="outline">{message.thought}</Badge>
          ) : null}
          {message.plan ? (
            <Badge variant="outline">{message.plan}</Badge>
          ) : null}
          {message.createdAt ? (
            <ChatBubbleTimestamp
              timestamp={moment(message.createdAt).format("LT")}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function Chat() {
  const { agentId } = useParams() as { agentId: string };
  const [searchParams] = useSearchParams();
  const roomIdParam = searchParams.get("roomId");
  const userChatId = "10000000-0000-0000-0000-000000000000";
  const userMessageColor = useId();
  const { data: agentData, isPending } = useAgent(agentId as UUID);
  const agent = agentData?.data;
  const agentName = agent?.name;
  const agentAvatar = agent?.settings?.avatar;
  const agentInitials = agentName ? formatAgentName(agentName) : undefined;
  const agentIsActive = agent?.status === AgentStatus.ACTIVE;
  const [isTyping, setIsTyping] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [submittedMessage, setSubmittedMessage] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isError, setIsError] = useState<{
    response: { message: string };
  } | null>(null);
  const navigate = useNavigate();
  const lastMessageTimestamp = useRef<number | null>(null);
  const ws = useRef<Socket | null>(null);
  const sessionRef = useRef<string | null>(null);

  // Get valid room ID
  const roomId = roomIdParam
    ? validateUuid(roomIdParam) || stringToUuid(roomIdParam)
    : stringToUuid(agentId);

  const queryClient = useQueryClient();
  const worldId = WorldManager.getWorldId();
  const entityId = getEntityId();

  const socketIOManager = SocketIOManager.getInstance();

  // socket client setup
  useEffect(() => {
    if (!agentName || !agentIsActive) return;

    // Create WebSocket connection with explicit server URL
    const wsClient = io("http://localhost:3000", {
      path: "/socket.io",
      transports: ["websocket"],
    });

    ws.current = wsClient;

    // Join the room
    wsClient.emit("join", {
      id: roomId,
      entityId: agentId,
      roomId: roomId,
    });

    setIsConnecting(true);

    // Connection opened
    wsClient.on("connect", () => {
      setIsConnected(true);
      setIsConnecting(false);
    });

    // Connection closed
    wsClient.on("disconnect", () => {
      setIsConnected(false);
    });

    // Listen for messages from the agent or other room members
    wsClient.on("messageBroadcast", (message) => {
      // Don't add messages sent by this user to avoid duplication
      if (message.sender?.id === userChatId) return;

      const newMessage = {
        id: message.id || uuidv4(),
        content: message.content,
        timestamp: message.timestamp || Date.now(),
        sender: message.sender || { id: agentId, name: agentName },
        session: message.session,
      };

      setMessages((prevMessages) => [...prevMessages, newMessage]);

      // Scroll to the bottom when new messages are received
      scrollToBottom();
    });

    // Listen for typing notifications
    wsClient.on("typing", (data) => {
      if (data.sender.id !== userChatId) {
        setIsTyping(true);
        setTimeout(() => setIsTyping(false), 2000);
      }
    });

    return () => {
      wsClient.off("messageBroadcast");
      wsClient.off("typing");
      wsClient.off("connect");
      wsClient.off("disconnect");
      wsClient.disconnect();
    };
  }, [agentName, agentId, agentIsActive, roomId]);

  const getMessageVariant = (id: UUID) =>
    id !== entityId ? "received" : "sent";

  const {
    scrollRef: autoScrollRef,
    isAtBottom: autoScrollIsAtBottom,
    scrollToBottom,
    disableAutoScroll,
  } = useAutoScroll({
    smooth: true,
  });

  useEffect(() => {
    scrollToBottom();
  }, [messages.length]);

  useEffect(() => {
    scrollToBottom();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleSendMessage = () => {
    if (inputMessage.trim() === "" || !ws.current) return;

    // If still connecting, show an error
    if (isConnecting) {
      toast({
        title: "Error",
        description: "Still connecting to the agent...",
        variant: "destructive",
      });
      return;
    }

    // Create a message object with a unique ID
    const message = {
      id: uuidv4(),
      content: inputMessage,
      timestamp: Date.now(),
      sender: {
        id: userChatId,
        name: "You",
      },
      roomId,
      session: sessionRef.current,
    };

    // Add the message to the UI
    setMessages((prevMessages) => [...prevMessages, message]);

    // Send the message through WebSocket
    ws.current.emit("message", message);

    // Clear the input field
    setInputMessage("");
    setSubmittedMessage(true);

    // Scroll to the bottom
    scrollToBottom();
  };

  const renderMessages = () => {
    return messages.map((message, index) => (
      <div key={message.id} className="flex flex-col">
        <div
          className={`flex items-start gap-2 ${
            message.sender?.id === userChatId ? "justify-end" : "justify-start"
          }`}
        >
          {message.sender?.id !== userChatId && (
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
              {message.sender?.id === agentId && agentAvatar ? (
                <img
                  src={agentAvatar}
                  alt={agentName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-xs">
                  {message.sender?.name?.substring(0, 2).toUpperCase()}
                </span>
              )}
            </div>
          )}

          <div
            className={`max-w-[80%] rounded-lg p-3 ${
              message.sender?.id === userChatId
                ? "bg-primary text-primary-foreground ml-auto"
                : "bg-muted"
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-medium">
                {message.sender?.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(message.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p>{message.content}</p>
          </div>
        </div>
      </div>
    ));
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <ChatHeader
        agent={agent}
        isPending={isPending}
        isConnected={isConnected}
        isGroup={!!roomId}
        room={roomId}
      />

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4"
        onScroll={() => {
          if (
            scrollRef.current &&
            scrollRef.current.scrollTop ===
              scrollRef.current.scrollHeight - scrollRef.current.clientHeight
          ) {
            setIsAtBottom(true);
          } else {
            setIsAtBottom(false);
          }
        }}
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {renderMessages()}
          {isTyping && (
            <div className="flex items-center gap-2">
              <div className="size-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                {agentAvatar ? (
                  <img
                    src={agentAvatar}
                    alt="Agent Avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs">{agentInitials}</span>
                )}
              </div>
              <div className="rounded-2xl rounded-tl-none bg-muted p-3">
                <div className="flex gap-1">
                  <div className="size-1.5 animate-typing-dot rounded-full bg-current opacity-60" />
                  <div className="size-1.5 animate-typing-dot animation-delay-150 rounded-full bg-current opacity-60" />
                  <div className="size-1.5 animate-typing-dot animation-delay-300 rounded-full bg-current opacity-60" />
                </div>
              </div>
            </div>
          )}
          <div ref={messageEndRef} />
        </div>
      </div>

      <div className="border-t bg-background p-4">
        <div className="mx-auto max-w-3xl">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
          >
            <div className="relative flex-1">
              <Textarea
                ref={inputRef}
                placeholder={`Message ${agentName}`}
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!agentIsActive}
                className="min-h-20 resize-none py-3 pr-16 scrollbar-thin"
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-1">
                {showAudio && (
                  <AudioRecorder
                    agentId={agentId as UUID}
                    onChange={(newInput: string) => setInputMessage(newInput)}
                  />
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      type="button"
                      disabled={true}
                    >
                      <Paperclip className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach file</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Button
              size="icon"
              variant="default"
              disabled={!agentIsActive || !inputMessage.trim()}
            >
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      </div>

      {showLogs && (
        <div className="absolute inset-0 bg-background">
          <LogViewer agentName={agentName || ""} />
          <Button
            className="absolute right-4 top-4"
            onClick={() => setShowLogs(false)}
          >
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

interface ChatHeaderProps {
  agent: Agent | undefined;
  isPending: boolean;
  isConnected: boolean;
  isGroup?: boolean;
  room?: string | null;
}

function ChatHeader({
  agent,
  isPending,
  isConnected,
  isGroup,
  room,
}: ChatHeaderProps) {
  return (
    <div className="z-10 flex items-center justify-between border-b bg-background px-6 py-2">
      <div className="flex items-center space-x-4">
        {isPending ? (
          <Skeleton className="h-10 w-10 rounded-full" />
        ) : (
          <>
            {isGroup ? (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Hash className="h-5 w-5 text-muted-foreground" />
              </div>
            ) : (
              <div className="relative h-10 w-10">
                <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-muted">
                  {agent?.settings?.avatar ? (
                    <img
                      src={agent.settings.avatar}
                      alt={agent.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="text-sm">
                      {agent?.name && formatAgentName(agent.name)}
                    </div>
                  )}
                </div>
                <div
                  className={cn(
                    "absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background",
                    isConnected ? "bg-green-500" : "bg-orange-500"
                  )}
                />
              </div>
            )}
          </>
        )}
        <div className="space-y-1">
          {isPending ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            <p className="text-sm font-medium leading-none">
              {isGroup ? room : agent?.name}
            </p>
          )}
          <div className="flex items-center">
            {isPending ? (
              <Skeleton className="h-3 w-32" />
            ) : (
              <p className="text-xs text-muted-foreground">
                {isConnected ? "Connected" : "Connecting..."}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center space-x-2">
        {/* Add group chat actions here if needed */}
      </div>
    </div>
  );
}
