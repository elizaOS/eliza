/**
 * THE single chat turn row for every surface (#12188 Phase 3). Two chromes:
 * `panel` — avatar/name grouping, theme-token bubble, hover action rail,
 * touch tap-reveal (ChatView + detached windows via ChatTranscript) — and
 * `glass` — the continuous overlay's floating dark-glass row: motion
 * entrance/exit, press-and-hold copy, click-to-reveal action row beneath the
 * bubble, Retry pill on recoverable failures, and the suggestion affordance in
 * glass trim. Reveal/edit/copy state, eligibility rules, and the suggestion
 * detection are shared; only the chrome branches.
 *
 * Memoized with a custom equality check so streamed-token re-renders stay
 * cheap; volatile per-row values (turn status, reasoning suppression) flow
 * through `renderContext` — compared field-wise — so the `renderContent`
 * closure can stay referentially stable. The mount-time entrance animation is
 * deliberately excluded from that check (see `enterOnMount`).
 * Presentation only — actions are delegated to callbacks.
 */
import { RotateCcw, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
import {
  COPY_HOLD_MS,
  TOUCH_TAP_MOVE_SLOP as TAP_REVEAL_MOVE_CANCEL_PX,
  usePointerPressAndHold,
} from "../../../gestures";
import { cn } from "../../../lib/utils";
import { findChoiceRegions } from "../../chat/message-choice-parser";
import { findFollowupsRegions } from "../../chat/message-followups-parser";
import { findFormRegions } from "../../chat/message-form-parser";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { ChatBubble, GLASS_EASE } from "./chat-bubble";
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
  ChatMessageRenderContext,
} from "./chat-types";

export type ChatMessageAppearance = "panel" | "glass";

export interface ChatMessageProps {
  agentName?: string;
  /** Chrome: theme-token `panel` (default) or the overlay's floating `glass`. */
  appearance?: ChatMessageAppearance;
  children?: React.ReactNode;
  /**
   * Play a one-shot fade+lift entrance when this row mounts (panel only — the
   * glass chrome animates through motion/AnimatePresence). Set only for a
   * freshly-arrived turn (see ChatTranscript) so reloaded history never
   * animates. Deliberately NOT part of arePropsEqual: the row keeps its
   * mount-time value, so streamed-token re-renders neither restart nor cancel
   * the animation.
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
   * Press-and-hold copy (glass): the only extraction shortcut on touch, where
   * there is no hover rail. A still hold past COPY_HOLD_MS fires this (the
   * overlay adds its haptic inside); real finger travel cancels so it never
   * fights the thread's touch-pan-y scroll.
   */
  onLongPressCopy?: (text: string) => void;
  /**
   * Retry a recoverable failed assistant turn (glass) — re-sends the preceding
   * user turn. Rendered as an always-visible pill (not gated behind the reveal
   * row) so a stalled turn isn't a dead end.
   */
  onRetry?: (messageId: string) => void;
  /** True while THIS message's audio is playing (glass Play ↔ Stop). */
  playing?: boolean;
  /** Collapse glass motion to quick fades (OS reduce-motion). */
  reduceMotion?: boolean;
  /**
   * Dismiss a proactive suggestion (#8792). Distinct from `onDelete` so the
   * suggestion's one-tap dismiss works without enabling delete on every
   * ordinary message. Only rendered on suggestion bubbles.
   */
  onDismissSuggestion?: (messageId: string) => void;
  /** Accept ("Do it") a proactive suggestion (#8792) — sends the implied action. */
  onAcceptSuggestion?: (message: ChatMessageData) => void;
  /**
   * Reply to this message: set the shared composer's reply target so the next
   * turn carries `replyToMessageId` (→ REPLY_CONTEXT). Wired by the surface;
   * the row only surfaces the affordance on a real (persisted) turn.
   */
  onReply?: (message: ChatMessageData) => void;
  replyTarget?: ChatMessageData | null;
  renderContent?: (
    message: ChatMessageData,
    ctx?: ChatMessageRenderContext,
  ) => React.ReactNode;
  /** Volatile per-row values forwarded to `renderContent` (see chat-types). */
  renderContext?: ChatMessageRenderContext;
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

/** Single-line, length-capped preview of a message for the "Replying to" pill. */
const REPLY_PILL_SNIPPET_MAX = 140;
function replyPillSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > REPLY_PILL_SNIPPET_MAX
    ? `${collapsed.slice(0, REPLY_PILL_SNIPPET_MAX)}…`
    : collapsed;
}

/**
 * Build the composer reply target from a rendered row. The surface passes its
 * `agentName` so an assistant turn is labeled by the agent rather than the
 * user's sender fields (which assistant rows don't carry). Display-only: the
 * server resolves the real replied-to message from `messageId`.
 */
export function buildReplyTargetFromMessage(
  message: ChatMessageData,
  agentName: string,
): { messageId: string; senderName: string; snippet: string } {
  const senderName =
    message.role === "user"
      ? (resolveSenderDisplayName(message) ??
        normalizeSenderHandle(message.fromUserName) ??
        "You")
      : agentName;
  return {
    messageId: message.id,
    senderName,
    snippet: replyPillSnippet(message.text ?? ""),
  };
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

function isNestedInteractiveTarget(
  currentTarget: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(
    'button,a,input,textarea,select,[role="button"]',
  );
  return !!interactive && interactive !== currentTarget;
}

/**
 * True when an assistant turn's content carries an inline interactive widget
 * (a `[CHOICE:…]` / `[FORM:…]` / `[FOLLOWUPS:…]` block — e.g. every first-run
 * onboarding turn). Such a glass bubble must NOT be wrapped in the
 * tap-to-reveal `role="button"` container: WebKit exposes an ARIA button as an
 * ATOMIC AX leaf (its aria-label becomes the node's name and all descendants
 * are dropped), so the wrapper silently removes the choice buttons + text from
 * the native accessibility tree — invisible to VoiceOver AND to XCUITest. The
 * parser helpers reset their own regex lastIndex, so repeated calls are safe.
 */
function messageHasInteractiveWidget(content: string): boolean {
  return (
    findChoiceRegions(content).length > 0 ||
    findFormRegions(content).length > 0 ||
    findFollowupsRegions(content).length > 0
  );
}

/** A transient "copied" confirmation: returns the flag plus a trigger that
 * shows it for `durationMs` (re-triggering restarts the window). */
function useCopiedFlash(durationMs: number): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);
  return [copied, flash];
}

function arePropsEqual(
  prev: ChatMessageProps,
  next: ChatMessageProps,
): boolean {
  const sharedEqual =
    prev.isGrouped === next.isGrouped &&
    prev.agentName === next.agentName &&
    prev.appearance === next.appearance &&
    prev.reduceMotion === next.reduceMotion &&
    prev.playing === next.playing &&
    prev.labels === next.labels &&
    prev.onCopy === next.onCopy &&
    prev.onDelete === next.onDelete &&
    prev.onDismissSuggestion === next.onDismissSuggestion &&
    prev.onAcceptSuggestion === next.onAcceptSuggestion &&
    prev.onEdit === next.onEdit &&
    prev.onSpeak === next.onSpeak &&
    prev.onLongPressCopy === next.onLongPressCopy &&
    prev.onRetry === next.onRetry &&
    prev.onReply === next.onReply &&
    prev.replyTarget?.id === next.replyTarget?.id &&
    prev.renderContent === next.renderContent &&
    // renderContext is rebuilt per parent render; compare its fields so only
    // the row whose volatile values changed re-renders.
    prev.renderContext?.turnStatus === next.renderContext?.turnStatus &&
    prev.renderContext?.suppressReasoning ===
      next.renderContext?.suppressReasoning &&
    prev.userMessagesOnRight === next.userMessagesOnRight &&
    prev.children === next.children;
  if (!sharedEqual) return false;

  // The transcript re-renders the full list on every streamed token. Without
  // a per-row comparator React.memo's shallow check trips on the inline
  // `message`/`replyTarget` references that are rebuilt on every parent
  // render even when nothing about a given row changed.
  if (prev.message === next.message) return true;

  const a = prev.message;
  const b = next.message;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.source === b.source &&
    a.interrupted === b.interrupted &&
    a.from === b.from &&
    a.fromUserName === b.fromUserName &&
    a.avatarUrl === b.avatarUrl &&
    a.replyToMessageId === b.replyToMessageId &&
    a.replyToSenderName === b.replyToSenderName &&
    a.replyToSenderUserName === b.replyToSenderUserName &&
    a.reactions === b.reactions &&
    a.voiceSpeaker === b.voiceSpeaker &&
    a.failureKind === b.failureKind &&
    a.attachments === b.attachments &&
    // Inline tool-call rows: a mode:"tool" stream update replaces `toolEvents`
    // by reference while every other compared field stays identical, so without
    // this compare the memo swallows the re-render and the running tool row
    // never flips to its settled state.
    a.toolEvents === b.toolEvents &&
    // Turn-settle fields the glass body renderer reads: a settled turn can gain
    // reasoning / a secret request without its text changing.
    a.reasoning === b.reasoning &&
    a.secretRequest === b.secretRequest
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  appearance = "panel",
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
  onLongPressCopy,
  onRetry,
  onReply,
  playing = false,
  reduceMotion = false,
  replyTarget = null,
  renderContent,
  renderContext,
  userMessagesOnRight = true,
}: ChatMessageProps) {
  const glass = appearance === "glass";
  const [copied, flashCopied] = useCopiedFlash(glass ? 1100 : 2000);
  // The press-and-hold "Copied" chip (glass) — separate from the action-row
  // copy state so a hold-flash never lights the row button and vice versa.
  const [holdCopied, flashHoldCopied] = useCopiedFlash(1100);
  const [showActions, setShowActions] = useState(false);
  const supportsHover = useSupportsHover();
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(message.text);
  const [savingEdit, setSavingEdit] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isRightAligned = isUser ? userMessagesOnRight : !userMessagesOnRight;
  const trimmedText = message.text.trim();
  // First-run onboarding turns render chromeless: agent prose floats as plain
  // wallpaper text with its CTA button directly beneath. Computed up here (not
  // at first use) so the message-action capabilities below can suppress the
  // hover/tap rail — replying to / copying / deleting the seeded greeting is
  // meaningless, and the rail contradicts the chromeless intent.
  const isFirstRun = !isUser && message.source === "first_run";
  const canEdit =
    isUser &&
    typeof onEdit === "function" &&
    message.source !== "local_command" &&
    !message.id.startsWith("temp-") &&
    // Glass keeps the shell rule: an image-only user turn has no editable text.
    (!glass || trimmedText.length > 0);
  const canPlay = Boolean(
    !isUser && !isFirstRun && typeof onSpeak === "function" && trimmedText,
  );
  // Persistent delete (#13533): available on any real turn when the surface
  // wires onDelete. An optimistic (temp-) turn has no persisted row to delete;
  // a proactive suggestion uses its own dismiss affordance (below), not delete;
  // a first-run greeting is chromeless (no rail at all).
  const canDelete =
    typeof onDelete === "function" &&
    !message.id.startsWith("temp-") &&
    !isFirstRun;
  const normalizedSource = normalizeChatSourceKey(message.source) ?? undefined;
  // Reply targets the persisted message by id, so an optimistic (temp-) turn,
  // which has no server row yet, has nothing to reply to. A proactive
  // suggestion carries its own accept/dismiss affordances, not a reply.
  // Proactive interaction comments (#8792) are agent-initiated *suggestions*, not
  // replies; render them with a distinct, one-tap-dismissible affordance.
  const isSuggestion = !isUser && normalizedSource === "proactive-interaction";
  const canReply =
    typeof onReply === "function" &&
    !message.id.startsWith("temp-") &&
    !isSuggestion &&
    !isFirstRun;
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
    flashCopied();
  }, [message.text, onCopy, flashCopied]);

  const handleReply = useCallback(() => {
    onReply?.(message);
    // Collapse the tap-revealed rail (touch/glass) after arming the reply so the
    // focus returns to the composer, not a lingering action row.
    if (glass || !supportsHover) setShowActions(false);
  }, [message, onReply, glass, supportsHover]);

  // Press-and-hold to copy an assistant answer (glass) — the only extraction
  // affordance on touch. A still hold past COPY_HOLD_MS copies + flashes
  // "Copied"; real finger travel cancels (shared usePointerPressAndHold).
  const canHoldCopy =
    glass && isAssistant && !!onLongPressCopy && trimmedText.length > 0;
  const holdBinding = usePointerPressAndHold<HTMLDivElement>({
    enabled: canHoldCopy,
    durationMs: COPY_HOLD_MS,
    canBegin: (e) => !isNestedInteractiveTarget(e.currentTarget, e.target),
    onHold: () => {
      onLongPressCopy?.(message.text);
      flashHoldCopied();
    },
  });
  const holdHandlers = canHoldCopy ? holdBinding : null;

  const handleStartEditing = useCallback(() => {
    if (!canEdit || savingEdit) return;
    setDraftText(message.text);
    setIsEditing(true);
  }, [canEdit, message.text, savingEdit]);

  const handleCancelEditing = useCallback(() => {
    if (savingEdit) return;
    setDraftText(message.text);
    setIsEditing(false);
    if (glass) setShowActions(false);
  }, [message.text, savingEdit, glass]);

  const handleSaveEdit = useCallback(async () => {
    if (!onEdit) return;
    const nextText = draftText.trim();
    if (!nextText) return;
    if (nextText === message.text.trim()) {
      setDraftText(message.text);
      setIsEditing(false);
      if (glass) setShowActions(false);
      return;
    }

    setSavingEdit(true);
    try {
      const saved = await onEdit(message.id, nextText);
      if (saved !== false) {
        setIsEditing(false);
        if (glass) setShowActions(false);
      }
    } finally {
      setSavingEdit(false);
    }
  }, [draftText, message.id, message.text, onEdit, glass]);

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
      // it happened to start on.
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
        // Escape closes THIS editor only — in the overlay it must not bubble
        // to the document-level Escape handler, which would also collapse the
        // whole chat sheet and discard the edit (#9148).
        if (glass) event.stopPropagation();
        handleCancelEditing();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void handleSaveEdit();
      }
    },
    [handleCancelEditing, handleSaveEdit, glass],
  );

  useEffect(() => {
    if (!isEditing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [isEditing]);

  // Outside pointerdown dismisses a revealed action row/rail (touch panel +
  // glass). Also closes an in-progress glass edit, mirroring the shell rule.
  const outsideDismissActive = glass
    ? showActions || isEditing
    : showActions && !supportsHover;
  useEffect(() => {
    if (!outsideDismissActive || typeof document === "undefined") {
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
        if (glass) setIsEditing(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [outsideDismissActive, glass]);

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

  // ── Glass chrome (the continuous overlay's floating row) ──────────────────
  if (glass) {
    // A failure the user can't recover from without wiring a provider renders a
    // structured gate (via renderContent), NOT a normal bubble — no reveal
    // actions, no copy-hold. The gate owns its own chrome; the row only carries
    // the entrance motion + the data-failure hook the shell tests key off.
    if (isAssistant && message.failureKind === "no_provider") {
      return (
        <motion.div
          ref={articleRef as React.RefObject<HTMLDivElement>}
          data-testid="thread-line"
          data-role={message.role}
          data-failure="no_provider"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{
            duration: reduceMotion ? 0.15 : 0.52,
            ease: GLASS_EASE,
          }}
          className="mb-2.5 flex w-full justify-start"
        >
          {renderContent?.(message, renderContext) ?? children ?? message.text}
        </motion.div>
      );
    }

    const canRowCopy = !isFirstRun && !!onCopy && trimmedText.length > 0;
    // Suggestions carry their own dismiss affordance, not the delete control.
    const canRowDelete = canDelete && !isSuggestion;
    // A first-run greeting is chromeless — no rail, no tap-to-reveal. Every
    // capability above already excludes it, so hasActions is false and the
    // bubble stays a plain, non-interactive container.
    const hasActions =
      canRowCopy || canPlay || canEdit || canRowDelete || canReply;
    // An assistant turn carrying an inline choice/form/followups widget must
    // stay a plain container — see messageHasInteractiveWidget.
    const hasInteractiveWidget =
      isAssistant && messageHasInteractiveWidget(message.text);
    const bubbleInteractive = hasActions && !isEditing && !hasInteractiveWidget;
    // A recoverable assistant failure gets a one-tap Retry that re-sends the
    // preceding user turn. `no_provider` (the overlay's own Settings gate) and
    // `insufficient_credits` are excluded: a retry can't fix those.
    const canRetry =
      isAssistant &&
      !!onRetry &&
      (message.failureKind === "rate_limited" ||
        message.failureKind === "provider_issue");

    const toggleRevealed = () => {
      if (!hasActions || isEditing) return;
      // Never hijack a text-selection drag: a click that finishes a highlight
      // must not also toggle the row (the bubble text stays selectable).
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (sel && sel.toString().trim().length > 0) return;
      setShowActions((v) => !v);
    };
    const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
      if (!bubbleInteractive) return;
      if (isNestedInteractiveTarget(e.currentTarget, e.target)) return;
      toggleRevealed();
    };
    const handleBubbleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (!bubbleInteractive) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleRevealed();
    };

    const bubbleContent =
      isUser && isEditing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            ref={editTextareaRef}
            aria-label="Edit message"
            data-testid="thread-line-edit-input"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={handleEditKeyDown}
            rows={Math.min(6, Math.max(1, draftText.split("\n").length))}
            className="min-h-0 w-full resize-none rounded-lg border-0 bg-white/10 px-2.5 py-1.5 text-[14px] text-white outline-none [overflow-wrap:anywhere]"
            disabled={savingEdit}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              data-testid="thread-line-edit-cancel"
              onClick={handleCancelEditing}
              className="h-auto rounded-full bg-white/10 px-3 py-1 text-[13px] font-medium text-white/80 transition-colors hover:bg-white/20"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="thread-line-edit-save"
              onClick={() => void handleSaveEdit()}
              className="h-auto rounded-full bg-[rgb(255,88,0)] px-3 py-1 text-[13px] font-medium text-white transition-colors hover:bg-[rgb(214,74,0)]"
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <>
          {isSuggestion ? (
            // Proactive suggestion affordance (#8792): Suggestion chip + accept
            // ("Do it") + dismiss. stopPropagation keeps these taps from
            // toggling the bubble's click-to-reveal action row.
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[rgb(255,148,84)]">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Suggestion
              </span>
              <div className="flex items-center gap-1">
                {onAcceptSuggestion ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="thread-line-suggestion-accept"
                    title="Do it"
                    aria-label="Do it"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAcceptSuggestion(message);
                    }}
                    className="h-auto rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-medium text-[rgb(255,148,84)] transition-colors hover:bg-white/20"
                  >
                    Do it
                  </Button>
                ) : null}
                {onDismissSuggestion ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid="thread-line-suggestion-dismiss"
                    title="Dismiss suggestion"
                    aria-label="Dismiss suggestion"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismissSuggestion(message.id);
                    }}
                    className="h-6 w-6 rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div data-chat-selectable="true">
            {renderContent?.(message, renderContext) ??
              children ??
              message.text}
          </div>
          <AnimatePresence>
            {holdCopied ? (
              <motion.span
                key="copied"
                data-testid="thread-line-copied"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
                className="pointer-events-none absolute -top-2 right-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-black"
              >
                Copied
              </motion.span>
            ) : null}
          </AnimatePresence>
        </>
      );

    const bubbleExtraClassName = cn(
      // Tapping a bubble with actions reveals its row (pointer affordance).
      bubbleInteractive && "cursor-pointer",
      // First-run greeting: normal chat messages float on the sheet's shared
      // glass panel, but onboarding has no panel behind them, so the hairline
      // edge alone reads as a faint line on black. Give the greeting a subtle
      // frosted fill + slightly stronger edge so it reads as a proper, sleek
      // bubble on the opaque onboarding backdrop.
      isFirstRun && "border-white/25 bg-white/[0.06]",
      // Suggestion treatment (#8792): dashed accent edge + faint accent tint so
      // a proactive offer reads as a suggestion, not a normal reply. Placed
      // last so it wins over the glass hairline.
      isSuggestion &&
        "border border-dashed border-[rgb(255,88,0)]/45 bg-[rgb(255,88,0)]/[0.06]",
    );

    return (
      <motion.div
        ref={articleRef as React.RefObject<HTMLDivElement>}
        data-testid="thread-line"
        data-role={message.role}
        // New turns rise+fade in. Transform/opacity only; reduced motion
        // collapses it to a quick fade with no positional movement.
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={{ duration: reduceMotion ? 0.15 : 0.52, ease: GLASS_EASE }}
        className={cn(
          "mb-1.5 flex w-full",
          isUser ? "justify-end" : "justify-start",
        )}
      >
        {/* Bubble + its click-to-reveal action row stack vertically, aligned to
            the turn's side (#10713). */}
        <div
          className={cn(
            "flex max-w-[80%] flex-col gap-1",
            isUser ? "items-end" : "items-start",
          )}
        >
          {bubbleInteractive ? (
            <ChatBubble
              variant="glass"
              bare={false}
              tone={isUser ? "user" : "assistant"}
              {...(holdHandlers ?? {})}
              role="button"
              tabIndex={0}
              aria-label={
                actionsVisible ? "Hide message actions" : "Show message actions"
              }
              aria-expanded={actionsVisible}
              onClick={handleBubbleClick}
              onKeyDown={handleBubbleKeyDown}
              className={bubbleExtraClassName}
              data-proactive-suggestion={isSuggestion ? "true" : undefined}
            >
              {bubbleContent}
            </ChatBubble>
          ) : (
            <ChatBubble
              variant="glass"
              bare={false}
              tone={isUser ? "user" : "assistant"}
              {...(holdHandlers ?? {})}
              className={bubbleExtraClassName}
              data-proactive-suggestion={isSuggestion ? "true" : undefined}
            >
              {bubbleContent}
            </ChatBubble>
          )}
          {actionsVisible && !isEditing && hasActions ? (
            <div
              data-testid="thread-line-actions"
              className={cn(
                "flex items-center gap-1.5",
                isUser ? "pr-1" : "pl-1",
              )}
            >
              <ChatMessageActions
                appearance="glass-row"
                canDelete={canRowDelete}
                canEdit={canEdit}
                canPlay={canPlay}
                canReply={canReply}
                copied={copied}
                labels={labels}
                onCopy={canRowCopy ? handleCopy : undefined}
                onDelete={() => onDelete?.(message.id)}
                onEdit={handleStartEditing}
                onPlay={() => onSpeak?.(message.id, message.text)}
                onReply={handleReply}
                playing={playing}
              />
            </div>
          ) : null}
          {/* Retry a recoverable failure by re-sending the preceding user turn.
              Always visible on the failed turn (not gated behind the reveal
              row) so a stalled turn isn't a dead end the user has to retype. */}
          {canRetry ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="thread-line-retry"
              aria-label="Retry"
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.(message.id);
              }}
              className="h-auto gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[13px] font-medium text-white/80 transition-colors hover:bg-white/20"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </Button>
          ) : null}
        </div>
      </motion.div>
    );
  }

  // ── Panel chrome (ChatView / detached windows) ─────────────────────────────
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
            (renderContent?.(message, renderContext) ??
            children ??
            message.text)
          )}

          {!isUser && message.interrupted ? (
            <div className="mt-2 border-t border-danger/30 pt-2">
              <span className="inline-flex rounded-sm border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
                {labels.responseInterrupted ?? "Response interrupted"}
              </span>
            </div>
          ) : null}

          {!isEditing && !isFirstRun ? (
            <div
              data-testid="chat-message-action-rail"
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
                canDelete={canDelete}
                canEdit={canEdit}
                canPlay={canPlay}
                canReply={canReply}
                copied={copied}
                labels={labels}
                onCopy={handleCopy}
                onDelete={() => onDelete?.(message.id)}
                onEdit={handleStartEditing}
                onPlay={() => onSpeak?.(message.id, message.text)}
                onReply={handleReply}
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
