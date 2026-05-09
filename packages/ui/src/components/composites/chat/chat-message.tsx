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
} from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { ChatBubble } from "./chat-bubble";
import { ChatMessageActions } from "./chat-message-actions";
import { normalizeChatSourceKey, renderChatReactionEmoji } from "./chat-source";
import type {
  ChatMessageData,
  ChatMessageLabels,
  ChatMessageReaction,
} from "./chat-types";

export interface ChatMessageProps {
  agentName?: string;
  children?: React.ReactNode;
  isGrouped?: boolean;
  labels?: ChatMessageLabels;
  message: ChatMessageData;
  onCopy?: (text: string) => void;
  onDelete?: (messageId: string) => void;
  onEdit?: (messageId: string, text: string) => Promise<boolean> | boolean;
  onSpeak?: (messageId: string, text: string) => void;
  replyTarget?: ChatMessageData | null;
  userMessagesOnRight?: boolean;
}

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
            className="inline-flex items-center gap-1 rounded-full border border-border/28 bg-bg/70 px-2 py-1 text-xs-tight font-medium text-txt-strong shadow-[0_10px_18px_-16px_rgba(15,23,42,0.45)]"
          >
            <ReactionEmoji emoji={reaction.emoji} />
            {reaction.count > 1 ? <span>{reaction.count}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isGrouped = false,
  agentName = "Agent",
  children,
  labels = {},
  onCopy,
  onSpeak,
  onEdit,
  onDelete,
  replyTarget = null,
  userMessagesOnRight = true,
}: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [supportsHover, setSupportsHover] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)").matches
      : true,
  );
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(message.text);
  const [savingEdit, setSavingEdit] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const senderDisplayName = isUser ? resolveSenderDisplayName(message) : null;
  const senderHandle = isUser
    ? resolveSenderHandle(message, senderDisplayName)
    : null;
  const senderPrimaryLabel = senderDisplayName ?? senderHandle ?? "User";
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

  const handleTapReveal = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (supportsHover || isEditing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, a, textarea, input")) {
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
    if (!isEditing) {
      setDraftText(message.text);
      return;
    }
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [isEditing, message.text]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const syncSupportsHover = () => {
      setSupportsHover(mediaQuery.matches);
      if (mediaQuery.matches) {
        setShowActions(false);
      }
    };
    syncSupportsHover();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncSupportsHover);
      return () => mediaQuery.removeEventListener("change", syncSupportsHover);
    }

    mediaQuery.addListener(syncSupportsHover);
    return () => mediaQuery.removeListener(syncSupportsHover);
  }, []);

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
      } ${isGrouped ? "mt-0.5" : "mt-1.5"}`}
      data-testid="chat-message"
      data-role={message.role}
      onMouseEnter={supportsHover ? () => setShowActions(true) : undefined}
      onMouseLeave={supportsHover ? () => setShowActions(false) : undefined}
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
              "text-xs font-semibold text-accent",
              isRightAligned ? "text-right" : "text-left",
            )}
          >
            You
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
              <div className="truncate text-xs font-semibold text-txt-strong">
                {senderPrimaryLabel}
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
          className={`relative group py-1 text-[15px] leading-[1.7] whitespace-pre-wrap break-words`}
          style={{ fontFamily: "var(--font-chat)" }}
        >
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
                className="min-h-[110px] w-full rounded-xl border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] px-3 py-2.5 text-[15px] leading-[1.7] text-txt outline-none shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_14px_20px_-20px_rgba(15,23,42,0.1)] focus-visible:border-accent/28 focus-visible:ring-2 focus-visible:ring-accent/12"
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
                  className="h-8 rounded-lg px-3 text-xs"
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
                  className="h-8 rounded-lg px-3 text-xs disabled:border-border/20 disabled:bg-bg-accent disabled:text-muted-strong"
                >
                  {savingEdit
                    ? (labels.saving ?? "Saving...")
                    : (labels.saveAndResend ?? "Save and resend")}
                </Button>
              </div>
            </div>
          ) : (
            (children ?? message.text)
          )}

          {!isUser && message.interrupted ? (
            <div className="mt-2 border-t border-danger/30 pt-2">
              <span className="inline-flex rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
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
});
