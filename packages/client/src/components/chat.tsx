import { Button } from "@/components/ui/button";
import {
  ChatBubble,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
} from "@/components/ui/chat/chat-bubble";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { ChatMessageList } from "@/components/ui/chat/chat-message-list";
import { USER_NAME } from "@/constants";
import { useAgent, useMessages } from "@/hooks/use-query-hooks";
import { cn, getEntityId, moment } from "@/lib/utils";
import SocketIOManager from "@/lib/socketio-manager";
import { WorldManager } from "@/lib/world-manager";
import type { IAttachment } from "@/types";
import type { Content, UUID } from "@elizaos/core";
import { AgentStatus } from "@elizaos/core";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Database, PanelRight, Paperclip, Send, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import AIWriter from "react-aiwriter";
import { AgentActionViewer } from "./action-viewer";
import { AudioRecorder } from "./audio-recorder";
import CopyButton from "./copy-button";
import { LogViewer } from "./log-viewer";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import ChatTtsButton from "./ui/chat/chat-tts-button";
import { useAutoScroll } from "./ui/chat/hooks/useAutoScroll";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { AgentMemoryViewer } from "./memory-viewer";

const SOURCE_NAME = "client_chat";

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
        {message.name === USER_NAME ? 
          message.text :
          (isLastMessage && message.name !== USER_NAME) ? 
            <AIWriter>{message.text}</AIWriter> : 
            message.text
        }
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

export default function Page({ agentId }: { agentId: UUID }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [input, setInput] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [detailsTab, setDetailsTab] = useState<"actions" | "logs" | "memories">("actions");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const worldId = WorldManager.getWorldId();

  const agentData = useAgent(agentId)?.data?.data;
  const entityId = getEntityId();
  const roomId = agentId;

  const { data: messages = [] } = useMessages(agentId, roomId);

  const socketIOManager = SocketIOManager.getInstance();

  useEffect(() => {
    socketIOManager.connect(agentId, roomId);
    socketIOManager.connect(entityId, roomId);

    const handleMessageBroadcasting = (data: ContentWithUser) => {
      queryClient.setQueryData(
        ["messages", agentId, roomId, worldId],
        (old: ContentWithUser[] = []) => [
          ...old,
          { ...data, name: data.senderName },
        ]
      );
    };
    socketIOManager.on("messageBroadcast", handleMessageBroadcasting);

    return () => {
      socketIOManager.disconnectAll();
      socketIOManager.off("messageBroadcast", handleMessageBroadcasting);
    };
  }, [roomId]);

  const getMessageVariant = (id: UUID) =>
    id !== entityId ? "received" : "sent";

  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } =
    useAutoScroll({
      smooth: true,
    });

  useEffect(() => {
    scrollToBottom();
  }, [messages!.length]);

  useEffect(() => {
    scrollToBottom();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      handleSendMessage(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  const handleSendMessage = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input) return;

    socketIOManager.handleBroadcastMessage(
      entityId,
      USER_NAME,
      input,
      roomId,
      SOURCE_NAME
    );

    setSelectedFile(null);
    setInput("");
    formRef.current?.reset();
  };

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file?.type.startsWith("image/")) {
      setSelectedFile(file);
    }
  };

  const toggleDetails = () => {
    setShowDetails(!showDetails);
  };

  return (
    <div className="flex flex-col w-full h-screen p-4">
      {/* Agent Header */}
      <div className="flex items-center justify-between mb-4 p-3 bg-card rounded-lg border">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 border rounded-full">
            <AvatarImage
              src={
                agentData?.settings?.avatar
                  ? agentData?.settings?.avatar
                  : "/elizaos-icon.png"
              }
            />
          </Avatar>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg">
                {agentData?.name || "Agent"}
              </h2>
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
                {Array.isArray(agentData.bio)
                  ? agentData.bio[0]
                  : agentData.bio}
              </p>
            )}
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={toggleDetails}
          className={cn("gap-1.5", showDetails && "bg-secondary")}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>

      <div className="flex flex-row w-full overflow-y-auto grow gap-4">
        {/* Main Chat Area */}
        <div
          className={cn(
            "flex flex-col transition-all duration-300",
            showDetails ? "w-3/5" : "w-full"
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
                  className={`flex flex-column gap-1 p-1 ${
                    isUser ? "justify-end" : ""
                  }`}
                >
                  <ChatBubble
                    variant={getMessageVariant(isUser ? entityId : agentId)}
                    className={`flex flex-row items-center gap-2 ${
                      isUser ? "flex-row-reverse" : ""
                    }`}
                  >
                    <Avatar className="size-8 border rounded-full select-none">
                      <AvatarImage
                        src={
                          isUser
                            ? "/user-icon.png"
                            : agentData?.settings?.avatar
                            ? agentData?.settings?.avatar
                            : "/elizaos-icon.png"
                        }
                      />

                      {isUser && <AvatarFallback>U</AvatarFallback>}
                    </Avatar>
                    <MessageContent message={message} agentId={agentId} isLastMessage={index === messages.length - 1}/>
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
                <AudioRecorder
                  agentId={agentId}
                  onChange={(newInput: string) => setInput(newInput)}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="ml-auto gap-1.5 h-[30px]"
                >
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
              onValueChange={(v) => setDetailsTab(v as "actions" | "logs" | "memories")}
              className="flex flex-col h-full"
            >
              <div className="border-b px-4 py-2">
                <TabsList className="grid grid-cols-3">
                  <TabsTrigger
                    value="actions"
                    className="flex items-center gap-1.5"
                  >
                    <Activity className="h-4 w-4" />
                    <span>Agent Actions</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="logs"
                    className="flex items-center gap-1.5"
                  >
                    <Terminal className="h-4 w-4" />
                    <span>Logs</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="memories"
                    className="flex items-center gap-1.5"
                  >
                    <Database className="h-4 w-4" />
                    <span>Memories</span>
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="actions" className="overflow-y-scroll">
                <AgentActionViewer agentId={agentId} roomId={roomId} />
              </TabsContent>
              <TabsContent value="logs">
                <LogViewer agentName={agentData?.name} level="all" hideTitle />
              </TabsContent>
              <TabsContent value="memories">
                <AgentMemoryViewer agentId={agentId} />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
