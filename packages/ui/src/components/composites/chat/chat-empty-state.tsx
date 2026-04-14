import type * as React from "react";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import type { ChatVariant } from "./chat-types";

export interface ChatEmptyStateProps {
  action?: React.ReactNode;
  agentName: string;
  className?: string;
  hint?: React.ReactNode;
  labels?: {
    chatIconLabel?: string;
    sendMessageTo?: string;
    startConversation?: string;
    toBeginChatting?: string;
  };
  onSuggestionClick?: (suggestion: string) => void;
  suggestions?: string[];
  variant?: ChatVariant;
}

export function ChatEmptyState({
  action,
  agentName,
  className,
  hint,
  labels = {},
  onSuggestionClick,
  suggestions = ["Hello!", "How are you?", "Tell me a joke", "Help me with..."],
  variant = "default",
}: ChatEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center p-6 text-center",
        variant === "game-modal" &&
          "min-h-full justify-end gap-4 px-2 py-4 text-left",
        className,
      )}
    >
      {variant === "default" ? (
        <>
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-subtle">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent"
              aria-label={labels.chatIconLabel ?? "Chat icon"}
            >
              <title>{labels.chatIconLabel ?? "Chat"}</title>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-semibold text-txt-strong">
            {labels.startConversation ?? "Start a Conversation"}
          </h3>
          <p className="mb-6 max-w-sm font-[var(--font-chat)] text-sm text-muted">
            {labels.sendMessageTo ?? "Send a message to"} {agentName}{" "}
            {labels.toBeginChatting ?? "to begin chatting."}
          </p>
        </>
      ) : null}

      {action ? <div className="mb-4 flex justify-center">{action}</div> : null}
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant={variant === "game-modal" ? "surface" : "outline"}
            size="sm"
            className={cn(
              "h-7 rounded-full px-3 py-1.5 text-xs transition-colors",
              variant === "default" &&
                "border-border bg-bg text-muted hover:border-accent hover:text-accent",
            )}
            onClick={() => onSuggestionClick?.(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
      {hint ? (
        <div className="mt-4 max-w-sm text-xs-tight uppercase tracking-[0.16em] text-muted/74">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
