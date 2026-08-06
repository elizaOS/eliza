"use client";

import { useState, useRef, useCallback } from "react";
import { Send, Square, Paperclip } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { streamChat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_LENGTH } from "@/lib/constants";

interface ChatInputProps {
  conversationId: string;
}

export function ChatInput({ conversationId }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { conversations, settings, addMessage, updateMessage } = useChatStore();
  const conversation = conversations.find((c) => c.id === conversationId);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    setIsStreaming(true);

    // Add user message
    addMessage(conversationId, {
      role: "user",
      content: text,
      status: "complete",
    });

    // Add placeholder assistant message
    const assistantId = addMessage(conversationId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });

    const controller = new AbortController();
    abortRef.current = controller;

    const messages = [
      ...(conversation?.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user" as const, content: text },
    ];

    let fullText = "";

    try {
      for await (const chunk of streamChat(messages, settings.model, controller.signal, {
        provider: settings.provider,
        apiKey: settings.providerKeys[settings.provider],
      })) {
        if (chunk.type === "text" && chunk.content) {
          fullText += chunk.content;
          updateMessage(conversationId, assistantId, {
            content: fullText,
            status: "streaming",
          });
        } else if (chunk.type === "done") {
          break;
        } else if (chunk.type === "error") {
          updateMessage(conversationId, assistantId, {
            content: chunk.error ?? "An error occurred",
            status: "error",
          });
          return;
        }
      }

      updateMessage(conversationId, assistantId, { status: "complete" });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        updateMessage(conversationId, assistantId, {
          content: "Request failed. Please try again.",
          status: "error",
        });
      } else {
        updateMessage(conversationId, assistantId, { status: "complete" });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [
    input,
    isStreaming,
    conversationId,
    conversation,
    settings.model,
    settings.provider,
    settings.providerKeys,
    addMessage,
    updateMessage,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-surface-800 bg-surface-900/50 backdrop-blur-sm px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl border bg-surface-800 px-3 py-2",
            "border-surface-700 focus-within:border-brand-500 transition-colors"
          )}
        >
          <button
            className="p-1 text-surface-500 hover:text-surface-300 transition-colors flex-shrink-0 mb-0.5"
            aria-label="Attach file"
          >
            <Paperclip className="w-4 h-4" aria-hidden="true" />
          </button>

          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value.slice(0, MAX_MESSAGE_LENGTH));
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message Claude Code..."
            rows={1}
            aria-label="Message"
            className={cn(
              "flex-1 resize-none bg-transparent text-sm text-surface-100",
              "placeholder:text-surface-500 focus:outline-none",
              "min-h-[24px] max-h-[200px] py-0.5"
            )}
          />

          {isStreaming ? (
            <button
              onClick={handleStop}
              aria-label="Stop generation"
              className="p-1.5 rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 transition-colors flex-shrink-0"
            >
              <Square className="w-4 h-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!input.trim()}
              aria-label="Send message"
              aria-disabled={!input.trim()}
              className={cn(
                "p-1.5 rounded-lg transition-colors flex-shrink-0",
                input.trim()
                  ? "bg-brand-600 text-white hover:bg-brand-700"
                  : "bg-surface-700 text-surface-500 cursor-not-allowed"
              )}
            >
              <Send className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="text-xs text-surface-600 text-center mt-2">
          Claude can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
