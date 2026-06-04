import * as React from "react";

import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { GlassIconButton } from "./glass-composer";
import { GLASS_COMPOSER_CLASS } from "./glass-composer.helpers";
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
  const { t } = useTranslation();
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">
            {greeting ??
              t("chatsurface.greeting", {
                defaultValue: "Ask Eliza anything.",
              })}
          </p>
        ) : (
          <ul
            aria-live="polite"
            aria-atomic="false"
            aria-label={t("chatsurface.conversation", {
              defaultValue: "Conversation",
            })}
            className="flex flex-col gap-2"
          >
            {messages.map((message) => {
              const isEmptyAssistant =
                message.role === "assistant" && message.content === "";
              return (
                <li
                  key={message.id}
                  className={cn(
                    "max-w-[80%] rounded-xs px-3 py-2 text-sm",
                    message.role === "user"
                      ? "self-end bg-accent/20 text-txt"
                      : "self-start bg-card/60 text-txt",
                  )}
                >
                  {isEmptyAssistant ? (
                    <span
                      role="status"
                      aria-label={t("chatsurface.typing", {
                        defaultValue: "Eliza is typing",
                      })}
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
      {/* Refractive-glass composer: a well-defined glass bar (no plain top
          border) holding the input and the matching mic + send buttons. */}
      <div className={cn("m-2", GLASS_COMPOSER_CLASS)}>
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
          placeholder={t("chatsurface.inputPlaceholder", {
            defaultValue: "Ask Eliza…",
          })}
          disabled={!canSend}
          aria-label={t("chatsurface.messageLabel", {
            defaultValue: "Message Eliza",
          })}
          className="min-w-0 flex-1 border-0 bg-transparent px-2 py-1.5 text-sm text-txt placeholder:text-txt/50 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50"
        />
        <GlassIconButton
          icon="mic"
          label={
            recording
              ? t("chatsurface.stopVoice", {
                  defaultValue: "Stop voice input",
                })
              : t("chatsurface.startVoice", {
                  defaultValue: "Start voice input",
                })
          }
          active={recording}
          disabled={!onToggleRecording}
          onClick={onToggleRecording}
        />
        <GlassIconButton
          icon="send"
          label={t("chatsurface.send", { defaultValue: "Send message" })}
          disabled={!canSendNow}
          onClick={handleSend}
        />
      </div>
    </div>
  );
}
