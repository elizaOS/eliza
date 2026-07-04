/**
 * A single chat turn row: avatar/name grouping, the message bubble, source and
 * voice-speaker badges, inline edit, hover action rail, and the accept/dismiss
 * controls for proactive suggestion bubbles (#8792). Memoized with a custom
 * equality check so streamed-token re-renders stay cheap; the mount-time
 * entrance animation is deliberately excluded from that check (see
 * `enterOnMount`). Presentation only — actions are delegated to callbacks.
 */
import { Sparkles, X } from "lucide-react";
import type * as React from "react";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type TouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { TOUCH_TAP_MOVE_SLOP as TAP_REVEAL_MOVE_CANCEL_PX } from "../../../gestures";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { ChatBubble } from "./chat-bubble";
import { ChatMessageActions } from "./chat-message-actions";
import { ChatVoiceSpeakerBadge } from "./chat-source";
import {
  normalizeChatSourceKey,
  renderChatReactionEmoji,
  resolveChatVoiceSpeakerLabel,
} from "./chat-source.helpers";
import type {
  ChatMessageData,
  ChatMessageLabels,
  ChatMessageReaction,
} from "./chat-types";

export interface ChatMessageProps {
  agentName?: string;
  children?: React.ReactNode;
  /**
   * Play a one-shot fade+lift entrance when this row mounts. Set only for a
   * freshly-arrived turn (see ChatTranscript) so reloaded history never animates.
   * Deliberately NOT part of arePropsEqual: the row keeps its mount-time value,
   * so streamed-token re-renders neither restart nor cancel the animation.
   */
  enterOnMount?: boolean;
  isGrouped?: boolean;
  labels?: ChatMessageLabels;
  message: ChatMessageData;
  onCopy?: (text: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => Promise<boolean> | boolean;
  onSpeak?: (messageId: string, text: string) => void;
  /**
   * Dismiss a proactive suggestion (#8792). Distinct from `onDelete` so the
   * suggestion's one-tap dismiss works without enabling delete on every
   * ordinary message. Only rendered on suggestion bubbles.
   */
  onDismissSuggestion?: (messageId: string) => void;
  /** Accept ("Do it") a proactive suggestion (#8792) — sends the implied action. */
  onAcceptSuggestion?: (message: ChatMessageData) => void;
  replyTarget?: ChatMessageData | null;
  renderContent?: (message: ChatMessageData) => React.ReactNode;
  userMessagesOnRight?: boolean;
}

const HOVER_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";
// Tap-to-reveal move slop (the shared TOUCH_TAP_MOVE_SLOP): finger travel past
// this between touchstart and touchend means the gesture was a transcript
// scroll, not a tap, so it must not toggle the action rail.
const hoverSupportListeners = new Set<() => void>();
let hoverMediaQuery: MediaQueryList | null = null;
let hoverMediaQueryUnsubscribe: (() => void) | null = null;

function getHoverMediaQuery(): MediaQueryList | null {
  if (hoverMediaQuery) return hoverMediaQuery;
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  hoverMediaQuery = window.matchMedia(HOVER_MEDIA_QUERY);
  return hoverMediaQuery;
}

function readSupportsHover(): boolean {
  return getHoverMediaQuery()?.matches ?? true;
}

function subscribeSupportsHover(listener: () => void): () => void {
  hoverSupportListeners.add(listener);
  const mediaQuery = getHoverMediaQuery();
  if (mediaQuery && hoverSupportListeners.size === 1) {
    const notify = () => {
      for (const current of hoverSupportListeners) current();
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", notify);
      hoverMediaQueryUnsubscribe = () =>
        mediaQuery.removeEventListener("change", notify);
    } else {
      mediaQuery.addListener(notify);
      hoverMediaQueryUnsubscribe = () => mediaQuery.removeListener(notify);
    }
  }

  return () => {
    hoverSupportListeners.delete(listener);
    if (hoverSupportListeners.size === 0) {
      hoverMediaQueryUnsubscribe?.();
      hoverMediaQueryUnsubscribe = null;
    }
  };
}

function useSupportsHover(): boolean {
  return useSyncExternalStore(
    subscribeSupportsHover,
    readSupportsHover,
    () => true,
  );
}

/**
 * The DOM id a rendered chat message carries, so keyword-search jump-to-message
 * can scroll a result into view. Shared with the message-search UI.
 */
export function getChatMessageAnchorId(messageId: string): string {
  return `chat-message-${messageId}`;
}

function normalizeSenderHandle(handle?: string): string | null {
  if (typeof handle !== "string") return null;
  const trimmed = handle.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function resolveSenderDisplayName(message: ChatMessageData): string | null {
  const from = typeof message.from === "string" ? message.from.trim() : "";
  if (from) return from;
  const voiceLabel = resolveChatVoiceSpeakerLabel(message.voiceSpeaker);
  if (voiceLabel) return voiceLabel;
  return normalizeSenderHandle(message.fromUserName);
}

function resolveSenderHandle(
  message: ChatMessageData,
  displayName: string | null,
): string | null {
  const handle = normalizeSenderHandle(message.fromUserName);
  if (!handle) return null;
  if (
    displayName?.replace(/^@/, "").toLowerCase() ===
    handle.slice(1).toLowerCase()
  ) {
    return null;
  }
  return handle;
}

function resolveReplySenderDisplayName(
  message: ChatMessageData,
  replyTarget?: ChatMessageData | null,
): string | null {
  if (replyTarget) {
    const targetDisplayName = resolveSenderDisplayName(replyTarget);
    if (targetDisplayName) return targetDisplayName;
  }

  const replyToSenderName =
    typeof message.replyToSenderName === "string"
      ? message.replyToSenderName.trim()
      : "";
  if (replyToSenderName) return replyToSenderName;

  return normalizeSenderHandle(message.replyToSenderUserName);
}

function formatPossessiveLabel(label: string): string {
  return /s$/i.test(label) ? `${label}'` : `${label}'s`;
}

function normalizeMessageReactions(
  reactions: ChatMessageReaction[] | undefined,
): ChatMessageReaction[] {
  if (!Array.isArray(reactions)) {
    return [];
  }
  return reactions.filter(
    (reaction) =>
      typeof reaction?.emoji === "string" &&
      reaction.emoji.trim().length > 0 &&
      typeof reaction.count === "number" &&
      Number.isFinite(reaction.count) &&
      reaction.count > 0,
  );
}

function ReactionEmoji({ emoji }: { emoji: string }) {
  const rendered = renderChatReactionEmoji(emoji);
  if (rendered) {
    return rendered;
  }
  return <span className="text-[15px] leading-none">{emoji}</span>;
}

function ReactionStrip({
  alignRight,
  reactions,
}: {
  alignRight: boolean;
  reactions: ChatMessageReaction[];
}) {
  if (reactions.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-1.5",
        alignRight ? "justify-end" : "justify-start",
      )}
    >
      {reactions.map((reaction) => {
        const title =
          Array.isArray(reaction.users) && reaction.users.length > 0
            ? reaction.users.join(", ")
            : undefined;
        return (
          <span
            key={`${reaction.emoji}:${reaction.count}`}
            data-testid="chat-reaction-badge"
            title={title}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-bg px-2 py-1 text-xs-tight font-medium text-txt-strong "
          >
            <ReactionEmoji emoji={reaction.emoji} />
            {reaction.count > 1 ? <span>{reaction.count}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function arePropsEqual(
  prev: ChatMessageProps,
  next: ChatMessageProps,
): boolean {
  // The transcript re-renders the full list on every streamed token. Without
  // a per-row comparator React.memo's shallow check trips on the inline
  // `message`/`replyTarget` references that are rebuilt on every parent
  // render even when nothing about a given row changed.
  if (prev.message === next.message) {
    return (
      prev.isGrouped === next.isGrouped &&
      prev.agentName === next.agentName &&
      prev.labels === next.labels &&
      prev.onCopy === next.onCopy &&
      prev.onDelete === next.onDelete &&
      prev.onDismissSuggestion === next.onDismissSuggestion &&
      prev.onAcceptSuggestion === next.onAcceptSuggestion &&
      prev.onEdit === next.onEdit &&
      prev.onSpeak === next.onSpeak &&
      prev.replyTarget?.id === next.replyTarget?.id &&
      prev.renderContent === next.renderContent &&
      prev.userMessagesOnRight === next.userMessagesOnRight &&
      prev.children === next.children
    );
  }

  const a = prev.message;
  const b = next.message;
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.text !== b.text ||
    a.source !== b.source ||
    a.interrupted !== b.interrupted ||
    a.from !== b.from ||
    a.fromUserName !== b.fromUserName ||
    a.avatarUrl !== b.avatarUrl ||
    a.replyToMessageId !== b.replyToMessageId ||
    a.replyToSenderName !== b.replyToSenderName ||
    a.replyToSenderUserName !== b.replyToSenderUserName ||
    a.reactions !== b.reactions ||
    a.voiceSpeaker !== b.voiceSpeaker
  ) {
    return false;
  }

  return (
    prev.isGrouped === next.isGrouped &&
    prev.agentName === next.agentName &&
    prev.labels === next.labels &&
    prev.onCopy === next.onCopy &&
    prev.onDelete === next.onDelete &&
    prev.onEdit === next.onEdit &&
    prev.onSpeak === next.onSpeak &&
    prev.replyTarget?.id === next.replyTarget?.id &&
    prev.renderContent === next.renderContent &&
    prev.userMessagesOnRight === next.userMessagesOnRight &&
    prev.children === next.children
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isGrouped = false,
  agentName = "Agent",
  children,
  enterOnMount = false,
  labels = {},
  onCopy,
  onSpeak,
  onEdit,
  onDelete,
  onDismissSuggestion,
  onAcceptSuggestion,
  replyTarget = null,
  renderContent,
  userMessagesOnRight = true,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showActions, setShowActions] = useState(false);
  const supportsHover = useSupportsHover();
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(message.text);
  const [savingEdit, setSavingEdit] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const isUser = message.role === "user";
  const isRightAligned = isUser ? userMessagesOnRight : !userMessagesOnRight;
  const canEdit =
    isUser &&
    typeof onEdit === "function" &&
    message.source !== "local_command" &&
    !message.id.startsWith("temp-");
  const canPlay = Boolean(
    !isUser && typeof onSpeak === "function" && message.text.trim(),
  );
  const normalizedSource = normalizeChatSourceKey(message.source) ?? undefined;
  // Proactive interaction comments (#8792) are agent-initiated *suggestions*, not
  // replies — render them with a distinct, one-tap-dismissible affordance.
  const isSuggestion = !isUser && normalizedSource === "proactive-interaction";
  const senderDisplayName = isUser ? resolveSenderDisplayName(message) : null;
  const senderHandle = isUser
    ? resolveSenderHandle(message, senderDisplayName)
    : null;
  const senderPrimaryLabel = senderDisplayName ?? senderHandle ?? "User";
  const voiceSpeakerLabel = isUser
    ? resolveChatVoiceSpeakerLabel(message.voiceSpeaker)
    : null;
  // Hide the inline mic pill when its label is already the displayed sender
  // header — keeps the bubble compact for the common case of a single OWNER.
  const showVoiceSpeakerBadge =
    isUser &&
    !isGrouped &&
    Boolean(message.voiceSpeaker) &&
    Boolean(voiceSpeakerLabel) &&
    voiceSpeakerLabel !== senderDisplayName;
  const replyTargetId =
    typeof message.replyToMessageId === "string"
      ? message.replyToMessageId.trim()
      : "";
  const replySenderLabel = resolveReplySenderDisplayName(message, replyTarget);
  const replyReferenceLabel = replySenderLabel
    ? `Reply to ${formatPossessiveLabel(replySenderLabel)} message`
    : "Reply to an earlier message";
  const showReplyReference = Boolean(
    !isEditing && replyTargetId && normalizedSource,
  );
  const showSenderHeader =
    isUser && !isGrouped && Boolean(senderDisplayName || senderHandle);
  const visibleReactions = normalizeMessageReactions(message.reactions);

  const handleCopy = useCallback(() => {
    onCopy?.(message.text);
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [message.text, onCopy]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const handleStartEditing = useCallback(() => {
    if (!canEdit || savingEdit) return;
    setDraftText(message.text);
    setIsEditing(true);
  }, [canEdit, message.text, savingEdit]);

  const handleCancelEditing = useCallback(() => {
    if (savingEdit) return;
    setDraftText(message.text);
    setIsEditing(false);
  }, [message.text, savingEdit]);

  const handleSaveEdit = useCallback(async () => {
    if (!onEdit) return;
    const nextText = draftText.trim();
    if (!nextText) return;
    if (nextText === message.text.trim()) {
      setDraftText(message.text);
      setIsEditing(false);
      return;
    }

    setSavingEdit(true);
    try {
      const saved = await onEdit(message.id, nextText);
      if (saved !== false) {
        setIsEditing(false);
      }
    } finally {
      setSavingEdit(false);
    }
  }, [draftText, message.id, message.text, onEdit]);

  const handleTapStart = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    tapStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);

  const handleTapReveal = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const tapStart = tapStartRef.current;
      tapStartRef.current = null;
      if (supportsHover || isEditing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, textarea, input")) {
        return;
      }
      // Scroll, not tap: finger travel past the slop means the touch was a
      // transcript flick, so it must not toggle the rail on whichever message
      // it happened to start on (mirrors the shell ThreadLine).
      const touch = event.changedTouches[0];
      if (
        tapStart &&
        touch &&
        (Math.abs(touch.clientX - tapStart.x) > TAP_REVEAL_MOVE_CANCEL_PX ||
          Math.abs(touch.clientY - tapStart.y) > TAP_REVEAL_MOVE_CANCEL_PX)
      ) {
        return;
      }
      // Never hijack a text selection: a tap that ends a highlight drag must
      // not also toggle the rail (the bubble text stays selectable to copy).
      const selection =
        typeof window !== "undefined" ? window.getSelection() : null;
      if (selection && !selection.isCollapsed) {
        return;
      }
      setShowActions((prev) => !prev);
    },
    [isEditing, supportsHover],
  );

  const handleEditKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCancelEditing();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handleSaveEdit();
      }
    },
    [handleCancelEditing, handleSaveEdit],
  );

  useEffect(() => {
    if (!isEditing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [isEditing]);

  useEffect(() => {
    if (supportsHover && showActions) setShowActions(false);
  }, [showActions, supportsHover]);

  useEffect(() => {
    if (supportsHover || !showActions || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        setShowActions(false);
        return;
      }
      if (!articleRef.current?.contains(target)) {
        setShowActions(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showActions, supportsHover]);

  const actionsVisible = showActions;

  const handleReplyReferenceClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!replyTargetId || typeof document === "undefined") return;
      const target = document.getElementById(
        getChatMessageAnchorId(replyTargetId),
      );
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [replyTargetId],
  );

  return (
    <article
      ref={articleRef}
      id={getChatMessageAnchorId(message.id)}
      className={`flex items-start gap-2 sm:gap-3 ${
        isRightAligned ? "justify-end" : "justify-start"
      } ${isGrouped ? "mt-0.5" : "mt-1.5"} ${
        enterOnMount
          ? "motion-safe:animate-[chat-turn-in_320ms_cubic-bezier(0.22,1,0.36,1)]"
          : ""
      }`}
      data-testid="chat-message"
      data-role={message.role}
      onMouseEnter={supportsHover ? () => setShowActions(true) : undefined}
      onMouseLeave={supportsHover ? () => setShowActions(false) : undefined}
      onTouchStart={handleTapStart}
      onTouchEnd={handleTapReveal}
      aria-label={`${
        isUser && showSenderHeader
          ? senderPrimaryLabel
          : isUser
            ? userMessagesOnRight
              ? "Your"
              : senderPrimaryLabel
            : agentName
      } message`}
    >
      <div
        className={`max-w-[88%] min-w-0 sm:max-w-[80%] ${
          isRightAligned ? "mr-1" : "ml-1"
        }`}
      >
        {!isUser && !isGrouped ? (
          <div
            className={cn(
              "text-xs font-semibold text-accent",
              isRightAligned ? "text-right" : "text-left",
            )}
          >
            {agentName}
          </div>
        ) : null}
        {isUser && !isGrouped && !showSenderHeader ? (
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold text-accent",
              isRightAligned ? "justify-end" : "justify-start",
            )}
          >
            <span>You</span>
            {showVoiceSpeakerBadge ? (
              <ChatVoiceSpeakerBadge
                speaker={message.voiceSpeaker}
                data-testid={`chat-message-voice-speaker-${message.id}`}
              />
            ) : null}
          </div>
        ) : null}
        {showSenderHeader ? (
          <div
            className={cn(
              "flex items-center gap-2",
              isRightAligned ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "min-w-0",
                isRightAligned ? "text-right" : "text-left",
              )}
            >
              <div className="flex items-center gap-1.5">
                <div className="truncate text-xs font-semibold text-txt-strong">
                  {senderPrimaryLabel}
                </div>
                {showVoiceSpeakerBadge ? (
                  <ChatVoiceSpeakerBadge
                    speaker={message.voiceSpeaker}
                    data-testid={`chat-message-voice-speaker-${message.id}`}
                  />
                ) : null}
              </div>
              {senderHandle ? (
                <div className="truncate text-xs-tight text-muted">
                  {senderHandle}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <ChatBubble
          tone={isUser ? "user" : "assistant"}
          source={normalizedSource}
          className={cn(
            "relative group py-1 text-[15px] leading-[1.7] whitespace-pre-wrap break-words",
            // Suggestion treatment: subtle accent tint + dashed accent border so
            // a proactive offer reads as a suggestion, not a normal reply.
            isSuggestion &&
              "border border-dashed border-accent/45 bg-accent/[0.06]",
          )}
          style={{ fontFamily: "var(--font-chat)" }}
          data-proactive-suggestion={isSuggestion ? "true" : undefined}
        >
          {isSuggestion && !isEditing ? (
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 text-xs-tight font-medium text-accent/85">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {labels.suggestion ?? "Suggestion"}
              </span>
              <div className="flex items-center gap-1">
                {onAcceptSuggestion ? (
                  <Button
                    variant="surface"
                    size="sm"
                    onClick={() => onAcceptSuggestion(message)}
                    className="h-6 rounded-sm px-2 text-xs-tight text-accent"
                    title={labels.acceptSuggestion ?? "Do it"}
                    aria-label={labels.acceptSuggestion ?? "Do it"}
                  >
                    {labels.acceptSuggestion ?? "Do it"}
                  </Button>
                ) : null}
                {onDismissSuggestion ? (
                  <Button
                    variant="surface"
                    size="icon"
                    onClick={() => onDismissSuggestion(message.id)}
                    className="h-6 w-6 rounded-sm text-muted"
                    title={labels.dismiss ?? "Dismiss suggestion"}
                    aria-label={labels.dismiss ?? "Dismiss suggestion"}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {showReplyReference ? (
            <a
              href={`#${getChatMessageAnchorId(replyTargetId)}`}
              onClick={handleReplyReferenceClick}
              className="mb-2 block text-xs font-medium text-muted underline decoration-border/60 underline-offset-2 transition-colors hover:text-txt-strong"
            >
              {replyReferenceLabel}
            </a>
          ) : null}
          {isEditing ? (
            <div className="space-y-3">
              <Textarea
                ref={editTextareaRef}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onKeyDown={handleEditKeyDown}
                className="min-h-[110px] w-full rounded-sm border border-border bg-card px-3 py-2.5 text-[15px] leading-[1.7] text-txt outline-none   "
                style={{ fontFamily: "var(--font-chat)" }}
                aria-label={labels.edit ?? "Edit message"}
                disabled={savingEdit}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="surface"
                  size="sm"
                  onClick={handleCancelEditing}
                  disabled={savingEdit}
                  className="h-8 rounded-sm px-3 text-xs"
                >
                  {labels.cancel ?? "Cancel"}
                </Button>
                <Button
                  variant="surfaceAccent"
                  size="sm"
                  onClick={() => void handleSaveEdit()}
                  disabled={
                    savingEdit ||
                    !draftText.trim() ||
                    draftText.trim() === message.text.trim()
                  }
                  className="h-8 rounded-sm px-3 text-xs disabled:border-border/20 disabled:bg-bg-accent disabled:text-muted-strong"
                >
                  {savingEdit
                    ? (labels.saving ?? "Saving...")
                    : (labels.saveAndResend ?? "Save and resend")}
                </Button>
              </div>
            </div>
          ) : (
            (renderContent?.(message) ?? children ?? message.text)
          )}

          {!isUser && message.interrupted ? (
            <div className="mt-2 border-t border-danger/30 pt-2">
              <span className="inline-flex rounded-sm border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                {labels.responseInterrupted ?? "Response interrupted"}
              </span>
            </div>
          ) : null}

          {!isEditing ? (
            <div
              className={cn(
                "absolute top-0 flex items-center gap-1 transition-opacity duration-200",
                // Below the `sm` breakpoint (narrow phones) anchor the
                // action rail to the bubble's top-right corner so it can
                // never overflow the viewport. From `sm` up the rail
                // floats outside the bubble (left of right-aligned user
                // bubbles, right of left-aligned bot bubbles) where there
                // is enough horizontal room.
                isRightAligned
                  ? "right-1 sm:right-auto sm:left-0 sm:-translate-x-full"
                  : "right-1 sm:right-0 sm:translate-x-full",
                actionsVisible
                  ? "opacity-100"
                  : "pointer-events-none opacity-0",
              )}
            >
              <ChatMessageActions
                canDelete={Boolean(onDelete)}
                canEdit={canEdit}
                canPlay={canPlay}
                copied={copied}
                labels={labels}
                onCopy={handleCopy}
                onDelete={() => onDelete?.(message.id)}
                onEdit={handleStartEditing}
                onPlay={() => onSpeak?.(message.id, message.text)}
              />
            </div>
          ) : null}
        </ChatBubble>
        <ReactionStrip
          alignRight={isRightAligned}
          reactions={visibleReactions}
        />
      </div>
    </article>
  );
}, arePropsEqual);
