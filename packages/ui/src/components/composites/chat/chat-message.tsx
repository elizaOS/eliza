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

import { isRetryableChatFailureKind } from "@elizaos/shared/contracts";
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from "lucide-react";
import { motion } from "motion/react";
import type * as React from "react";
import {
  type FocusEvent,
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
import { RelativeTime } from "../../shell/RelativeTime";
import { Button } from "../../ui/button";
import {
  Message as MessageRow,
  MessageContent as MessageRowContent,
  MessageFooter as MessageRowFooter,
} from "../../ui/message";
import { Textarea } from "../../ui/textarea";
import { ChatBubble, GLASS_EASE } from "./chat-bubble";
import {
  ChatMessageActionSurface,
  ChatMessageActions,
} from "./chat-message-actions";
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

const MotionMessageRow = motion.create(MessageRow);

export interface ChatMessageProps {
  /**
   * Live, non-message state that shares the glass action lane. The continuous
   * overlay uses this for active playback so status never consumes a second
   * transcript row.
   */
  actionAccessory?: React.ReactNode;
  /** Interactive content visually grouped with this turn but rendered as a
   * sibling below the message bubble rather than inside its chrome. */
  afterBubbleContent?: React.ReactNode;
  agentName?: string;
  /** Chrome: theme-token `panel` (default) or the overlay's floating `glass`. */
  appearance?: ChatMessageAppearance;
  children?: React.ReactNode;
  /**
   * Play a one-shot fade+lift entrance when this row mounts. Set only for a
   * freshly-arrived turn so reloaded or reconciled history never animates.
   * Deliberately NOT part of arePropsEqual: the row keeps its mount-time value,
   * so streamed-token re-renders neither restart nor cancel the animation.
   */
  enterOnMount?: boolean;
  isGrouped?: boolean;
  labels?: ChatMessageLabels;
  message: ChatMessageData;
  onCopy?: (text: string) => void;
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
   * Dismiss a proactive suggestion (#8792). This is intentionally separate
   * from ordinary message actions and only renders on suggestion bubbles.
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

// Narrow layouts use the touch interaction even when a responsive desktop
// preview supplies a fine pointer; the affordance follows the surface the user
// is reviewing, while wider desktop layouts retain hover discovery.
const HOVER_MEDIA_QUERY =
  "(min-width: 768px) and (hover: hover) and (pointer: fine)";
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
    prev.actionAccessory === next.actionAccessory &&
    Boolean(prev.afterBubbleContent) === Boolean(next.afterBubbleContent) &&
    prev.agentName === next.agentName &&
    prev.appearance === next.appearance &&
    prev.reduceMotion === next.reduceMotion &&
    prev.playing === next.playing &&
    prev.labels === next.labels &&
    prev.onCopy === next.onCopy &&
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
    a.timestamp === b.timestamp &&
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
    a.secretRequest === b.secretRequest &&
    a.capabilityHandoff === b.capabilityHandoff
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  actionAccessory,
  afterBubbleContent,
  appearance = "panel",
  isGrouped = false,
  agentName = "Agent",
  children,
  enterOnMount = false,
  labels = {},
  onCopy,
  onSpeak,
  onEdit,
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
  const [showActions, setShowActions] = useState(false);
  const supportsHover = useSupportsHover();
  const [isEditing, setIsEditing] = useState(false);
  const [editBubbleWidth, setEditBubbleWidth] = useState<number | null>(null);
  const [draftText, setDraftText] = useState(message.text);
  const [savingEdit, setSavingEdit] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const accessoryModeRef = useRef<"actions" | "edit">("actions");
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
  const normalizedSource = normalizeChatSourceKey(message.source) ?? undefined;
  // Reply targets the persisted message by id, so an optimistic (temp-) turn,
  // which has no server row yet, has nothing to reply to. A proactive
  // suggestion carries its own accept/dismiss affordances, not a reply.
  // Proactive interaction comments (#8792) are agent-initiated *suggestions*, not
  // replies; render them with a distinct, one-tap-dismissible affordance.
  const isSuggestion = !isUser && normalizedSource === "proactive-interaction";
  const isFlatAssistant = !isUser && !isFirstRun && !isSuggestion;
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

  const focusMessageSurface = useCallback(() => {
    const messageElement = articleRef.current;
    const focusTarget = glass
      ? messageElement?.querySelector<HTMLElement>(
          '[data-chat-message-bubble="true"]',
        )
      : messageElement;
    focusTarget?.focus({ preventScroll: true });
  }, [glass]);

  const handleCopy = useCallback(() => {
    onCopy?.(message.text);
    flashCopied();
  }, [message.text, onCopy, flashCopied]);

  const handleReply = useCallback(() => {
    // Focus the stable message surface before hiding the touch/glass actions;
    // otherwise the browser can retain focus inside controls being unmounted.
    // Consumers run afterward so a composer focus request remains authoritative.
    if (glass || !supportsHover) {
      focusMessageSurface();
      setShowActions(false);
    }
    onReply?.(message);
  }, [message, onReply, glass, supportsHover, focusMessageSurface]);

  // Press-and-hold shares the action row's existing confirmation state so copy
  // feedback never creates a second floating surface over nearby messages.
  const canHoldCopy =
    glass && isAssistant && !!onLongPressCopy && trimmedText.length > 0;
  const holdBinding = usePointerPressAndHold<HTMLDivElement>({
    enabled: canHoldCopy,
    durationMs: COPY_HOLD_MS,
    canBegin: (e) => !isNestedInteractiveTarget(e.currentTarget, e.target),
    onHold: () => {
      onLongPressCopy?.(message.text);
      flashCopied();
    },
  });
  const holdHandlers = canHoldCopy ? holdBinding : null;

  const handleStartEditing = useCallback(() => {
    if (!canEdit || savingEdit) return;
    const bubble = articleRef.current?.querySelector<HTMLElement>(
      '[data-chat-message-bubble="true"]',
    );
    const measuredWidth = bubble?.getBoundingClientRect().width ?? 0;
    setEditBubbleWidth(measuredWidth > 0 ? measuredWidth : null);
    setDraftText(message.text);
    setShowActions(false);
    setIsEditing(true);
  }, [canEdit, message.text, savingEdit]);

  const handleCancelEditing = useCallback(() => {
    if (savingEdit) return;
    setDraftText(message.text);
    setEditBubbleWidth(null);
    setIsEditing(false);
    setShowActions(glass);
  }, [glass, message.text, savingEdit]);

  const handleSaveEdit = useCallback(async () => {
    if (!onEdit) return;
    const nextText = draftText.trim();
    if (!nextText) return;
    if (nextText === message.text.trim()) {
      setDraftText(message.text);
      setEditBubbleWidth(null);
      setIsEditing(false);
      setShowActions(false);
      return;
    }

    setSavingEdit(true);
    try {
      const saved = await onEdit(message.id, nextText);
      if (saved !== false) {
        setEditBubbleWidth(null);
        setIsEditing(false);
        setShowActions(false);
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

  const handleActionsMouseLeave = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const activeElement = event.currentTarget.ownerDocument.activeElement;
      const keyboardFocusWithin =
        activeElement instanceof HTMLElement &&
        event.currentTarget.contains(activeElement) &&
        activeElement.matches(":focus-visible");
      if (!keyboardFocusWithin) {
        setShowActions(false);
      }
    },
    [],
  );

  const handleActionsPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      // Row insertion and transcript anchoring can place a new message beneath
      // a stationary cursor. Pointer movement is the durable signal that the
      // user intends to inspect this row; geometry-driven enter events are not.
      setShowActions(true);
    },
    [],
  );

  const handleActionsFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(":focus-visible")) {
      setShowActions(true);
    }
  }, []);

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
        if (glass) {
          setEditBubbleWidth(null);
          setIsEditing(false);
        }
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

  const editSaveDisabled =
    savingEdit || !draftText.trim() || draftText.trim() === message.text.trim();
  const inlineEditControls = (
    <ChatMessageActionSurface
      bare={glass}
      data-testid={
        glass ? "thread-line-edit-controls" : "chat-message-edit-controls"
      }
      className={cn(
        glass ? "gap-0.5" : "gap-0 px-1.5 py-0.5",
        !glass && "absolute right-0 top-full z-30 mt-1",
      )}
    >
      {glass ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={labels.cancel ?? "Cancel"}
            title={labels.cancel ?? "Cancel"}
            data-testid="thread-line-edit-cancel"
            onClick={(event) => {
              event.stopPropagation();
              handleCancelEditing();
            }}
            disabled={savingEdit}
            className="keyboard-focus-emphasis h-7 w-7 rounded-none bg-transparent p-0 text-white/60 transition-[color,transform] duration-150 hover:bg-transparent hover:text-white active:scale-95 active:bg-transparent disabled:text-white/30 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              savingEdit
                ? (labels.saving ?? "Saving...")
                : (labels.send ?? "Send")
            }
            title={savingEdit ? undefined : (labels.send ?? "Send")}
            data-testid="thread-line-edit-save"
            onClick={(event) => {
              event.stopPropagation();
              void handleSaveEdit();
            }}
            disabled={editSaveDisabled}
            className="keyboard-focus-emphasis h-7 w-7 rounded-none bg-transparent p-0 text-white/80 transition-[color,transform] duration-150 hover:bg-transparent hover:text-white active:scale-95 active:bg-transparent disabled:text-white/30 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            {savingEdit ? (
              <LoaderCircle
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
          </Button>
        </>
      ) : (
        <>
          <Button
            unstyled
            onClick={handleCancelEditing}
            disabled={savingEdit}
            className="keyboard-focus-emphasis min-h-7 px-2 py-1 text-xs font-medium text-white/60 transition-colors duration-150 hover:text-white disabled:text-white/30 pointer-coarse:min-h-touch"
          >
            {labels.cancel ?? "Cancel"}
          </Button>
          <span aria-hidden className="mx-0.5 h-3.5 w-px bg-white/15" />
          <Button
            unstyled
            onClick={() => void handleSaveEdit()}
            disabled={editSaveDisabled}
            className="keyboard-focus-emphasis min-h-7 px-2 py-1 text-xs font-medium text-white/85 transition-colors duration-150 hover:text-white disabled:text-white/30 pointer-coarse:min-h-touch"
          >
            {savingEdit
              ? (labels.saving ?? "Saving...")
              : (labels.saveAndResend ?? "Save and resend")}
          </Button>
        </>
      )}
    </ChatMessageActionSurface>
  );

  const inlineEditor = (
    <div
      data-testid={
        glass ? "thread-line-inline-editor" : "chat-message-inline-editor"
      }
      className="relative min-w-0"
    >
      <Textarea
        ref={editTextareaRef}
        aria-label={labels.edit ?? "Edit message"}
        data-testid={
          glass ? "thread-line-edit-input" : "chat-message-edit-input"
        }
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        onKeyDown={handleEditKeyDown}
        rows={Math.min(6, Math.max(1, draftText.split("\n").length))}
        className={cn(
          "field-sizing-content min-h-0 max-h-40 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 shadow-none outline-none transition-opacity duration-200 disabled:cursor-default",
          glass
            ? "text-[14px] leading-relaxed text-white caret-white"
            : "text-[15px] leading-[1.7] text-txt-strong caret-txt-strong",
        )}
        style={{ fontFamily: "var(--font-chat)" }}
        disabled={savingEdit}
      />
      {glass ? null : inlineEditControls}
    </div>
  );

  // ── Glass chrome (the continuous overlay's floating row) ──────────────────
  if (glass) {
    const initial = enterOnMount ? { opacity: 0 } : false;
    const transition = {
      duration: reduceMotion ? 0.05 : 0.09,
      ease: GLASS_EASE,
    };
    // A failure the user can't recover from by retrying (no provider wired, or
    // a drained credit balance) renders a structured gate (via renderContent),
    // NOT a normal bubble — no reveal actions, no copy-hold. The gate owns its
    // own chrome; the row only carries the entrance motion + the data-failure
    // hook the shell tests key off.
    if (
      isAssistant &&
      (message.failureKind === "no_provider" ||
        message.failureKind === "insufficient_credits")
    ) {
      return (
        <motion.div
          ref={articleRef as React.RefObject<HTMLDivElement>}
          id={getChatMessageAnchorId(message.id)}
          data-testid="thread-line"
          data-role={message.role}
          data-failure={message.failureKind}
          initial={initial}
          animate={{ opacity: 1 }}
          transition={transition}
          className="mb-2.5 flex w-full justify-start"
        >
          {renderContent?.(message, renderContext) ?? children ?? message.text}
        </motion.div>
      );
    }

    const canRowCopy = !isFirstRun && !!onCopy && trimmedText.length > 0;
    // A first-run greeting is chromeless — no rail, no tap-to-reveal. Every
    // capability above already excludes it, so hasActions is false and the
    // bubble stays a plain, non-interactive container.
    const hasActions = canRowCopy || canPlay || canEdit || canReply;
    const hasActionLane = hasActions || Boolean(actionAccessory);
    const accessoryVisible =
      actionsVisible || isEditing || Boolean(actionAccessory);
    const hiddenActionLane = {
      opacity: 0,
      y: reduceMotion ? 0 : 4,
      scale: reduceMotion ? 1 : 0.98,
    };
    const timestampAccessory =
      typeof message.timestamp === "number" &&
      Number.isFinite(message.timestamp) ? (
        <RelativeTime
          ts={message.timestamp}
          short
          data-testid="thread-line-timestamp"
          className="inline-block min-w-[3ch] whitespace-nowrap text-left text-[11px] tabular-nums text-white/45"
        />
      ) : null;
    const trailingAccessory =
      timestampAccessory || actionAccessory ? (
        <div className="flex min-w-0 items-center gap-1.5">
          {actionAccessory}
          {timestampAccessory}
        </div>
      ) : undefined;
    if (isEditing) accessoryModeRef.current = "edit";
    else if (actionsVisible) accessoryModeRef.current = "actions";
    // Retain the last visible contents while the shared slot collapses so its
    // exit never flashes the other control set on the final frame.
    const accessoryMode = accessoryModeRef.current;
    // An assistant turn carrying an inline choice/form/followups widget must
    // stay a plain container — see messageHasInteractiveWidget.
    const hasInteractiveWidget =
      isAssistant && messageHasInteractiveWidget(message.text);
    const bubbleInteractive = hasActions && !isEditing && !hasInteractiveWidget;
    // A recoverable assistant failure gets a one-tap Retry that re-sends the
    // preceding user turn. Permanent gates stay on the shared non-retry
    // contract (`no_provider`, credits, missing capability).
    const canRetry =
      isAssistant &&
      !!onRetry &&
      !!message.failureKind &&
      isRetryableChatFailureKind(message.failureKind);

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
        inlineEditor
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
          <div
            data-chat-selectable="true"
            className={cn(
              isFirstRun &&
                "flex w-full flex-col gap-4 whitespace-normal text-[17px] leading-relaxed text-white",
            )}
          >
            {renderContent?.(message, renderContext) ??
              children ??
              message.text}
          </div>
        </>
      );

    const bubbleExtraClassName = cn(
      // Tapping a bubble with actions reveals its row (pointer affordance).
      bubbleInteractive && "cursor-pointer",
      // Give first-run the same conversational bubble structure as chat, with
      // enough room and contrast for its next-step action. Intrinsic width keeps
      // short greetings from stretching across the full onboarding column;
      // longer copy still wraps at the row's existing 22rem maximum.
      isFirstRun &&
        "w-fit max-w-full rounded-2xl rounded-bl-md border border-white/20 bg-black/35 px-4 py-3.5 backdrop-blur-md sm:px-5 sm:py-4",
      // Ordinary assistant replies use shadcn's full-width ghost treatment.
      isFlatAssistant && "w-full px-0 py-1",
      // Align the user bubble's bordered text edge with the flat assistant
      // text edge so the reserved action lane has the same visual rhythm.
      isUser && "py-[3px]",
      // Suggestion treatment (#8792): dashed accent edge + faint accent tint so
      // a proactive offer reads as a suggestion, not a normal reply. Placed
      // last so it wins over the glass hairline.
      isSuggestion &&
        "border border-dashed border-[rgb(255,88,0)]/45 bg-[rgb(255,88,0)]/[0.06]",
    );

    return (
      <MotionMessageRow
        ref={articleRef as React.RefObject<HTMLDivElement>}
        id={getChatMessageAnchorId(message.id)}
        align={isUser ? "end" : "start"}
        data-testid="thread-line"
        data-role={message.role}
        // A very short opacity-only entrance keeps fast-model turns immediate
        // without fighting the scroller's bottom anchor.
        initial={initial}
        animate={{ opacity: 1 }}
        transition={transition}
        className="mb-0"
        onPointerMove={
          supportsHover && hasActions ? handleActionsPointerMove : undefined
        }
        onMouseLeave={
          supportsHover && hasActions ? handleActionsMouseLeave : undefined
        }
        onFocusCapture={hasActions ? handleActionsFocus : undefined}
        onBlurCapture={
          hasActions
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setShowActions(false);
                }
              }
            : undefined
        }
      >
        {/* Bubble + its click-to-reveal action row stack vertically, aligned to
            the turn's side (#10713). */}
        <MessageRowContent
          className={cn(
            "relative flex flex-col",
            // Fine pointers keep a stable hover lane so moving onto its controls
            // never reflows the transcript. Touch has no hover transition to
            // protect, so it stays compact until a tap opens the action cluster;
            // the shared glass easing makes that space open and close with it.
            hasActionLane &&
              "transition-[padding-bottom] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:duration-100",
            hasActionLane &&
              (supportsHover ? "pb-6" : accessoryVisible ? "pb-9" : "pb-0"),
            isFirstRun
              ? "max-w-[22rem] items-start"
              : isUser
                ? "max-w-[80%] items-end"
                : "w-full items-start",
          )}
        >
          {bubbleInteractive ? (
            <ChatBubble
              variant="glass"
              bare={isFlatAssistant}
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
              style={
                isEditing && editBubbleWidth
                  ? { width: editBubbleWidth, maxWidth: "100%" }
                  : undefined
              }
              data-chat-message-bubble="true"
              data-proactive-suggestion={isSuggestion ? "true" : undefined}
            >
              {bubbleContent}
            </ChatBubble>
          ) : (
            <ChatBubble
              variant="glass"
              bare={isFlatAssistant}
              tone={isUser ? "user" : "assistant"}
              tabIndex={-1}
              aria-label={`${isUser ? "Your" : agentName} message`}
              {...(holdHandlers ?? {})}
              className={bubbleExtraClassName}
              style={
                isEditing && editBubbleWidth
                  ? { width: editBubbleWidth, maxWidth: "100%" }
                  : undefined
              }
              data-chat-message-bubble="true"
              data-proactive-suggestion={isSuggestion ? "true" : undefined}
            >
              {bubbleContent}
            </ChatBubble>
          )}
          {afterBubbleContent ? (
            <div
              className="mt-2 w-full max-w-[13.5rem] pointer-events-auto"
              data-testid="thread-line-after-bubble"
            >
              {afterBubbleContent}
            </div>
          ) : null}
          {hasActionLane ? (
            <motion.div
              data-testid="thread-line-actions"
              aria-hidden={!accessoryVisible}
              inert={!accessoryVisible}
              initial={accessoryVisible ? false : hiddenActionLane}
              animate={
                accessoryVisible
                  ? { opacity: 1, y: 0, scale: 1 }
                  : hiddenActionLane
              }
              transition={{
                duration: reduceMotion ? 0.1 : 0.2,
                ease: GLASS_EASE,
              }}
              className={cn(
                "absolute bottom-0 z-10 min-w-0",
                isUser ? "right-0 origin-top-right" : "left-0 origin-top-left",
                // Accessibility state and paint state change in the same React
                // commit. A newly inserted row must never depend on Motion's
                // post-mount style application to keep its controls concealed.
                accessoryVisible
                  ? "visible pointer-events-auto"
                  : "invisible pointer-events-none opacity-0",
              )}
            >
              <MessageRowFooter className="flex items-center p-0 text-white/70">
                <motion.div
                  key={accessoryMode}
                  className="flex"
                  initial={reduceMotion ? false : { opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduceMotion ? 0.08 : 0.14,
                    ease: GLASS_EASE,
                  }}
                >
                  {accessoryMode === "edit" ? (
                    inlineEditControls
                  ) : (
                    <ChatMessageActions
                      appearance="glass-row"
                      canEdit={canEdit}
                      canPlay={canPlay}
                      canReply={canReply}
                      copied={copied}
                      labels={labels}
                      onCopy={canRowCopy ? handleCopy : undefined}
                      onEdit={handleStartEditing}
                      onPlay={() => onSpeak?.(message.id, message.text)}
                      onReply={handleReply}
                      playing={playing}
                      trailingAccessory={trailingAccessory}
                    />
                  )}
                </motion.div>
              </MessageRowFooter>
            </motion.div>
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
        </MessageRowContent>
      </MotionMessageRow>
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
      tabIndex={isFirstRun ? undefined : 0}
      onPointerMove={supportsHover ? handleActionsPointerMove : undefined}
      onMouseLeave={supportsHover ? handleActionsMouseLeave : undefined}
      onFocusCapture={!isFirstRun ? handleActionsFocus : undefined}
      onBlurCapture={
        !isFirstRun
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setShowActions(false);
              }
            }
          : undefined
      }
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
          style={{
            fontFamily: "var(--font-chat)",
            ...(isEditing && editBubbleWidth
              ? { width: editBubbleWidth, maxWidth: "100%" }
              : {}),
          }}
          data-chat-message-bubble="true"
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
          {isEditing
            ? inlineEditor
            : (renderContent?.(message, renderContext) ??
              children ??
              message.text)}

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
              aria-hidden={!actionsVisible}
              inert={!actionsVisible}
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
                canEdit={canEdit}
                canPlay={canPlay}
                canReply={canReply}
                copied={copied}
                labels={labels}
                onCopy={handleCopy}
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
