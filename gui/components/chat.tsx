"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState, FormEvent } from "react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, User, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { DefaultChatTransport } from "ai";

interface ChatProps {
  agentName?: string;
}

export function Chat({ agentName = "Eliza Agent" }: ChatProps) {
  const { messages, sendMessage, status, stop, clearError } = useChat({
    transport: new DefaultChatTransport({
      api: `/api/chat`,
    }),
    onError: (error) => {
      console.error("Chat error:", error);
    },
  });

  const [input, setInput] = useState("");
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollAreaRef.current) {
      const scrollElement = scrollAreaRef.current.querySelector(
        "[data-radix-scroll-area-viewport]"
      );
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  }, [messages]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!input.trim() || status !== "ready") return;

    const messageText = input;
    setInput("");

    await (sendMessage as (msg: unknown) => Promise<void>)({ text: messageText });
  };

  // Check if we're in a loading state
  const isLoading = status === "submitted" || status === "streaming";

  // Get the appropriate loading message
  const getLoadingMessage = () => {
    if (status === "submitted") return "Sending...";
    if (status === "streaming") return "Thinking...";
    return "";
  };

  return (
    <Card className="h-full w-full flex flex-col">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {agentName}
            </CardTitle>
            <CardDescription>
              Chat with your AI agent in real-time
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {(status === "ready" || status === undefined) && (
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                <span className="h-2 w-2 rounded-full bg-green-600 dark:bg-green-400" />
                Ready
              </span>
            )}
            {status === "submitted" && (
              <span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
                <span className="h-2 w-2 rounded-full bg-yellow-600 dark:bg-yellow-400 animate-pulse" />
                Sending
              </span>
            )}
            {status === "streaming" && (
              <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                <span className="h-2 w-2 rounded-full bg-blue-600 dark:bg-blue-400 animate-pulse" />
                Streaming
              </span>
            )}
            {status === "error" && (
              <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                <span className="h-2 w-2 rounded-full bg-red-600 dark:bg-red-400" />
                Error
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 p-0 flex flex-col">
        <ScrollArea className="flex-1 p-4" ref={scrollAreaRef}>
          <div className="space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground py-8">
                Start a conversation with {agentName}
              </div>
            )}

            {messages.map((message: UIMessage) => {
              return (
                <div
                  key={message.id}
                  className={cn(
                    "flex gap-3",
                    message.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "rounded-lg px-4 py-2 max-w-[80%] break-words",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {message.role === "assistant" && (
                        <Bot className="h-4 w-4 mt-0.5 shrink-0" />
                      )}
                      {message.role === "user" && (
                        <User className="h-4 w-4 mt-0.5 shrink-0" />
                      )}
                      <div className="whitespace-pre-wrap">
                        {(
                          (message.parts ?? []) as Array<{
                            type: string;
                            text?: string;
                          }>
                        ).map((part, idx) =>
                          part.type === "text" ? (
                            <span key={idx}>{part.text ?? ""}</span>
                          ) : null
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {isLoading && (
              <div className="flex gap-3 justify-start">
                <div className="rounded-lg px-4 py-2 bg-muted">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">{getLoadingMessage()}</span>
                  </div>
                </div>
              </div>
            )}

            {status === "error" && (
              <div className="rounded-lg px-4 py-2 bg-destructive/10 text-destructive">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">Error</div>
                    <div className="text-sm">
                      Something went wrong. Please try again.
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7"
                      onClick={() => clearError()}
                    >
                      Clear error
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <form onSubmit={handleSubmit} className="border-t p-4 flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            disabled={status !== "ready"}
            className="flex-1"
            autoFocus
          />
          {status === "streaming" ? (
            <Button type="button" onClick={() => stop()} variant="destructive">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={status !== "ready" || !input.trim()}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
