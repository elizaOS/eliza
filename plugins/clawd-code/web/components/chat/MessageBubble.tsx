"use client";

import { User, Bot, AlertCircle } from "lucide-react";
import { cn, extractTextContent } from "@/lib/utils";
import type { Message } from "@/lib/types";
import { MarkdownContent } from "./MarkdownContent";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isError = message.status === "error";
  const text = extractTextContent(message.content);

  return (
    <article
      className={cn(
        "flex gap-3 animate-fade-in",
        isUser && "flex-row-reverse"
      )}
      aria-label={isUser ? "You" : isError ? "Error from Claude" : "Claude"}
    >
      {/* Avatar — purely decorative, role conveyed by article label */}
      <div
        aria-hidden="true"
        className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
          isUser
            ? "bg-brand-600 text-white"
            : isError
            ? "bg-red-900 text-red-300"
            : "bg-surface-700 text-surface-300"
        )}
      >
        {isUser ? (
          <User className="w-4 h-4" aria-hidden="true" />
        ) : isError ? (
          <AlertCircle className="w-4 h-4" aria-hidden="true" />
        ) : (
          <Bot className="w-4 h-4" aria-hidden="true" />
        )}
      </div>

      {/* Content */}
      <div
        className={cn(
          "flex-1 min-w-0 max-w-2xl",
          isUser && "flex justify-end"
        )}
      >
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm",
            isUser
              ? "bg-brand-600 text-white rounded-tr-sm"
              : isError
              ? "bg-red-950 border border-red-800 text-red-200 rounded-tl-sm"
              : "bg-surface-800 text-surface-100 rounded-tl-sm"
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : (
            <MarkdownContent content={text} />
          )}
          {message.status === "streaming" && (
            <span
              aria-hidden="true"
              className="inline-block w-1.5 h-4 bg-current ml-0.5 animate-pulse-soft"
            />
          )}
        </div>
      </div>
    </article>
  );
}
