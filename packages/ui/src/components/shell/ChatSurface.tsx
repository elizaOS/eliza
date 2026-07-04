/**
 * Presentational chat transcript + glass composer for the shell surfaces.
 *
 * Renders a scrollable list of `ShellMessage`s (via the shared ChatBubble /
 * TypingIndicator composites) plus an input row with optional mic and VISION
 * buttons. It owns only local draft + scroll state; message data, send, and
 * capabilities arrive as props (driven by useShellController). Tail-following
 * and the jump-to-latest control come from the one shared `useThreadAutoScroll`
 * engine, not a local scroll handler.
 */
import { ArrowDown } from "lucide-react";
import * as React from "react";

import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { ChatBubble } from "../composites/chat/chat-bubble";
import { TypingIndicator } from "../composites/chat/chat-typing-indicator";
import { Input } from "../ui/input";
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
  /** Capture the screen and show it to the agent (plugin-vision). Omit to hide
   * the VISION button on surfaces without a screen-capture capability. */
  onVision?: () => void;
  /** Reflects an in-flight vision capture (pulses the VISION button). */
  visionActive?: boolean;
}

export function ChatSurface({
  messages,
  onSend,
  canSend,
  greeting,
  recording = false,
  onToggleRecording,
  onVision,
  visionActive = false,
}: ChatSurfaceProps): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState("");
  const messageCount = messages.length;
  const trimmed = draft.trim();
  const canSendNow = canSend && trimmed.length > 0;
  // Follow the tail while at the bottom, leave a reader who scrolled up alone,
  // and expose a jump-to-latest control — the one shared thread-scroll engine.
  const lastMessage = messages.at(-1);
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({
      growthKey: `${messageCount}:${lastMessage?.id ?? ""}:${lastMessage?.content.length ?? 0}`,
    });

  const handleSend = React.useCallback(() => {
    if (!canSendNow) return;
    onSend(trimmed);
    setDraft("");
  }, [canSendNow, onSend, trimmed]);

  return (
    <div className="flex h-full flex-col" data-testid="shell-chat-surface">
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto py-2">
          {messages.length === 0 ? (
            <p className="text-sm text-muted">
              {greeting ??
                t("chatsurface.greeting", {
                  defaultValue: "Ask {{appName}} anything.",
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
                const isUser = message.role === "user";
                const isEmptyAssistant =
                  message.role === "assistant" && message.content === "";
                return (
                  <li
                    key={message.id}
                    className={cn(
                      "flex max-w-[80%]",
                      isUser ? "self-end justify-end" : "self-start",
                    )}
                  >
                    {isEmptyAssistant ? (
                      <TypingIndicator
                        variant="game-modal"
                        agentName={t("chatsurface.assistant", {
                          defaultValue: "{{appName}}",
                        })}
                      />
                    ) : (
                      <ChatBubble
                        tone={isUser ? "user" : "assistant"}
                        className="text-sm"
                      >
                        {message.content}
                      </ChatBubble>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {/* Jump-to-latest: shown only when the reader has scrolled up from the
            newest line, so new content is never silently missed. */}
        {!atBottom && messageCount > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label={t("chatsurface.jumpToLatest", {
              defaultValue: "Jump to latest",
            })}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-card/80 px-3 py-1.5 text-xs text-txt shadow-md backdrop-blur-sm transition-colors hover:bg-card"
            data-testid="chat-surface-jump-to-latest"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            {t("chatsurface.jumpToLatest", { defaultValue: "Jump to latest" })}
          </button>
        ) : null}
      </div>
      {/* Refractive-glass composer: a well-defined glass bar (no plain top
          border) holding the input and the matching mic + send buttons. */}
      <div className={cn("m-2", GLASS_COMPOSER_CLASS)}>
        <Input
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
            defaultValue: "Ask {{appName}}…",
          })}
          disabled={!canSend}
          aria-label={t("chatsurface.messageLabel", {
            defaultValue: "Message {{appName}}",
          })}
          className="min-w-0 flex-1 border-0 bg-transparent px-2 py-1.5 text-sm text-txt placeholder:text-txt/50   disabled:opacity-50"
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
        {onVision ? (
          <GlassIconButton
            icon="vision"
            label={t("chatsurface.vision", {
              defaultValue: "Show {{appName}} my screen",
            })}
            active={visionActive}
            disabled={!canSend || visionActive}
            onClick={onVision}
          />
        ) : null}
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
