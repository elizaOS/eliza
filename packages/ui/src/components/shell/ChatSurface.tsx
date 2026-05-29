import { Send } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/utils";
import type { ShellMessage } from "./shell-state";

export interface ChatSurfaceProps {
  messages: readonly ShellMessage[];
  onSend: (text: string) => void;
  canSend: boolean;
  greeting?: string;
  recording?: boolean;
  onToggleRecording?: () => void;
}

export function ChatSurface({
  messages,
  onSend,
  canSend,
  greeting,
  recording = false,
  onToggleRecording,
}: ChatSurfaceProps): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const messageCount = messages.length;
  const trimmed = draft.trim();
  const canSendNow = canSend && trimmed.length > 0;

  const handleSend = React.useCallback(() => {
    if (!canSendNow) return;
    onSend(trimmed);
    setDraft("");
  }, [canSendNow, onSend, trimmed]);

  React.useEffect(() => {
    void messageCount;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messageCount]);

  return (
    <div className="flex h-full flex-col" data-testid="shell-chat-surface">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
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
                    "max-w-[80%] rounded-sm px-3 py-2 text-sm",
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
      <div className="border-t border-border/30 p-2">
        <div className="mb-1 flex justify-center">
          <button
            type="button"
            aria-label={recording ? "Stop voice input" : "Start voice input"}
            aria-pressed={recording}
            disabled={!onToggleRecording}
            onClick={onToggleRecording}
            className={cn(
              "min-h-8 bg-transparent px-2 text-xs font-semibold transition-colors [text-shadow:0_2px_8px_rgba(0,0,0,0.55)]",
              onToggleRecording ? "cursor-pointer" : "opacity-60",
              recording ? "animate-pulse text-txt" : "text-muted",
              "focus-visible:outline-none focus-visible:underline",
            )}
          >
            {recording ? "Listening" : "Not listening"}
          </button>
        </div>
        <div className="flex items-center gap-2">
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
            aria-label="Send message"
            disabled={!canSendNow}
            onClick={handleSend}
            className="grid h-10 w-10 place-items-center rounded-full bg-accent text-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
