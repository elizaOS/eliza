import * as React from "react";

import { cn } from "../../lib/utils";
import type { ShellMessage } from "./shell-state";

export interface ChatSurfaceProps {
  messages: readonly ShellMessage[];
  onSend: (text: string) => void;
  canSend: boolean;
  greeting?: string;
  /** When defined, the mic button is interactive and reflects this state. */
  recording?: boolean;
  /** Toggle voice capture. Enables the mic button when provided. */
  onToggleRecording?: () => void;
}

/**
 * Chat surface: scrollable bubble stack + input row.
 *
 * Text submits through `onSend`. When `onToggleRecording` is provided the mic
 * button drives voice capture (push-to-talk style); `recording` paints the
 * active state.
 */
export function ChatSurface({
  messages,
  onSend,
  canSend,
  greeting,
  recording = false,
  onToggleRecording,
}: ChatSurfaceProps): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const trimmed = draft.trim();
  const canSendNow = canSend && trimmed.length > 0;

  const handleSend = React.useCallback(() => {
    if (!canSendNow) return;
    onSend(trimmed);
    setDraft("");
  }, [canSendNow, onSend, trimmed]);

  return (
    <div className="flex h-full flex-col" data-testid="shell-chat-surface">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">
            {greeting ?? "Ask Eliza anything."}
          </p>
        ) : (
          <ul
            aria-live="polite"
            aria-atomic="false"
            aria-label="Conversation"
            className="flex flex-col gap-2"
          >
            {messages.map((message) => {
              const isEmptyAssistant =
                message.role === "assistant" && message.content === "";
              return (
                <li
                  key={message.id}
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                    message.role === "user"
                      ? "self-end bg-accent/20 text-txt"
                      : "self-start bg-card/60 text-txt",
                  )}
                >
                  {isEmptyAssistant ? (
                    <span
                      role="status"
                      aria-label="Eliza is typing"
                      className="inline-flex gap-0.5"
                    >
                      <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted" />
                      <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted [animation-delay:120ms]" />
                      <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted [animation-delay:240ms]" />
                    </span>
                  ) : (
                    message.content
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/30 p-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask Eliza…"
          disabled={!canSend}
          aria-label="Message Eliza"
          className="flex-1 rounded-full border border-border/40 bg-bg/60 px-3 py-2 text-sm text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50"
        />
        <button
          type="button"
          aria-label={recording ? "Stop voice input" : "Start voice input"}
          aria-pressed={recording}
          disabled={!onToggleRecording}
          onClick={onToggleRecording}
          className={cn(
            "grid h-10 w-10 place-items-center rounded-full",
            onToggleRecording ? "cursor-pointer" : "opacity-60",
            recording
              ? "bg-warn/30 text-txt animate-pulse"
              : "bg-card/60 text-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          )}
        >
          {/* Inline mic glyph — keep dependency-free */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="22" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Send message"
          disabled={!canSendNow}
          onClick={handleSend}
          className="grid h-10 w-10 place-items-center rounded-full bg-accent text-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="13 6 19 12 13 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
