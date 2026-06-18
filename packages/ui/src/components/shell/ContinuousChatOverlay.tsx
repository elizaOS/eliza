import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";

import type { ImageAttachment } from "../../api/client-types-chat";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import {
  filesToImageAttachments,
  MAX_CHAT_IMAGES,
} from "../../utils/image-attachment";
import type { ShellMessage } from "./shell-state";
import { type PullGestureBinding, usePullGesture } from "./use-pull-gesture";
import { usePromptSuggestions } from "./usePromptSuggestions";
import type { ShellController } from "./useShellController";

/**
 * The continuous-chat overlay: one always-present, ambient glass conversation
 * that floats over EVERY view. There are no separate chats and no switcher — it
 * is a single endless thread (the app's one active conversation, via
 * useShellController).
 *
 * Layout is a fixed composer at the bottom with a pull-up history SHEET above
 * it. At rest the sheet is a slim peek (the grabber + the latest line); pull it
 * UP — anywhere on the sheet — or just start typing to spring it open into the
 * full transcript; pull the grabber back DOWN, or press Escape, to close.
 * Nothing else dismisses it — clicking or scrolling the view behind does
 * nothing. The composer never moves; the history slides up over it.
 *
 * The container is pointer-events-none (the view behind stays live); only the
 * composer + sheet capture input, so it is non-blocking — unlike the
 * focus-trapping AssistantOverlay it supersedes in the main shell.
 *
 * Two design rules keep it intimate rather than app-like:
 *  1. SELF-CONTAINED CONTRAST — every surface carries its own dark-glass scrim
 *     (or, for floating text, a soft shadow) plus fixed light text, never the
 *     theme's `--txt`, so it stays legible over any substrate: a bright view, a
 *     dark view, or the warm "good evening" backdrop.
 *  2. NO CHROME/SIGNAGE — the thread speaks for itself: no message counter, no
 *     "new chat", no tab strip; controls dissolve into the glass, and status is
 *     a soft breath of light, not a brand-colored alert ring.
 *
 * Pure/presentational: it takes the controller as a prop so it can be rendered
 * in isolation (stories / harness) with a mock. The app wraps it in a small
 * context-reading mount (see App.tsx) that supplies the shared controller.
 */

// Floating (un-scrimmed) text gets a soft shadow so it reads over bright views.
const FLOAT_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]";

// Shared easing for the overlay's cheap motion path. Open/close must stay
// opacity/translate only: animating blur/filter or scaling a scrollable
// transcript repaints too much of the viewport and visibly janks on laptops.
const OVERLAY_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// Pull-sheet detents. The chat-history window is bottom-anchored just above the
// fixed composer; its height animates between a slim CLOSED peek (the grabber +
// the latest line — the pull-up target) and OPEN (most of the viewport above
// the input). The live drag tracks the finger 1:1; release snaps with an
// Apple-style spring. The whole sheet is unmounted when there's no thread yet.
const SHEET_OPEN_VH = 0.72; // fraction of viewport height at the FULL detent
const SHEET_HALF_VH = 0.46; // fraction of viewport height at the HALF detent

// A light iOS-style impact on each detent cross. Self-contained + guarded so it
// is a no-op off-native (and in jsdom tests) without coupling the overlay to the
// Capacitor bridge module. Mirrors `bridge/capacitor-bridge.ts` `haptics.light()`.
function detentHaptic(): void {
  try {
    const cap = (
      globalThis as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          Plugins?: {
            Haptics?: { impact?: (o: { style: string }) => unknown };
          };
        };
      }
    ).Capacitor;
    if (cap?.isNativePlatform?.()) {
      void cap.Plugins?.Haptics?.impact?.({ style: "LIGHT" });
    }
  } catch {
    // Haptics are a nicety — never let them throw into the gesture path.
  }
}
const SHEET_SPRING = {
  type: "spring" as const,
  stiffness: 320,
  damping: 34,
  mass: 0.9,
};
// Rubber-band resistance applied to drag past a detent (iOS-style overscroll).
function rubberBand(overshoot: number): number {
  return Math.sign(overshoot) * Math.sqrt(Math.abs(overshoot)) * 6;
}

// Glyphs (viewBox 0 0 36 36), rendered in currentColor inside a soft chip — the
// up-arrow (send) and five-bar waveform (mic) from the shared composer language.
const SEND_GLYPH = "M18 10L25 18H21V27H15V18H11Z";
const MIC_GLYPH =
  "M6 14H9V22H6Z M11.5 10H14.5V26H11.5Z M16.5 7H19.5V29H16.5Z M22 10H25V26H22Z M27 14H30V22H27Z";
const PLUS_GLYPH = "M16 8H20V16H28V20H20V28H16V20H8V16H16Z";
// Assistant voice output: a speaker (distinct from the mic waveform above) —
// "on" = speaker + sound waves, "muted" = speaker + slash.
const SPEAKER_GLYPH =
  "M7 15H12L18 10V26L12 21H7Z M21 14Q25 18 21 22L23 22Q27 18 23 14Z M25 11Q31 18 25 25L27 25Q33 18 27 11Z";
const SPEAKER_MUTED_GLYPH =
  "M7 15H12L18 10V26L12 21H7Z M21 12.4L22.4 11L31 19.6L29.6 21Z";
function Glyph({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 36 36" className="h-4 w-4" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={d} />
    </svg>
  );
}

/** A soft round glass control that dissolves into the bar; brightens only when active. */
function SoftButton({
  glyph,
  label,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  disabled,
  active,
  testId,
}: {
  glyph: string;
  label: string;
  onClick?: () => void;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      // aria-disabled (not the native attr) so the button stays focusable and its
      // label/reason is announceable; the click is guarded instead.
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onPointerDown={disabled ? undefined : onPointerDown}
      onPointerUp={disabled ? undefined : onPointerUp}
      onPointerCancel={disabled ? undefined : onPointerCancel}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        active
          ? "border-white/40 bg-white/85 text-black"
          : "border-white/15 bg-white/10 text-white/75 hover:bg-white/20 hover:text-white",
        disabled && "opacity-40",
      )}
    >
      <Glyph d={glyph} />
    </button>
  );
}

/**
 * The drag handle at the top of the chat sheet — pull UP to open the history,
 * pull DOWN to close it. It is also keyboard-operable (Enter/Space toggles,
 * ArrowUp opens, ArrowDown/Escape closes) so the drag-only affordance stays
 * WCAG 2.1.1 operable. `touch-none` keeps the browser from scroll/refreshing
 * mid-drag. A faint warm sheen rides the handle while the agent is live.
 */
function SheetGrabber({
  open,
  onOpen,
  onClose,
  binding,
  glow,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  binding: PullGestureBinding;
  glow: boolean;
}): React.JSX.Element {
  return (
    <button
      // A disclosure toggle for the chat history, not a value-bearing separator:
      // button + aria-expanded is the accurate semantic and stays keyboard-
      // operable (Enter/Space toggle, Arrow keys nudge) per WCAG 2.1.1.
      type="button"
      aria-expanded={open}
      aria-label={open ? "drag down to close chat" : "drag up to open chat"}
      data-testid="chat-sheet-grabber"
      data-open={open ? "true" : "false"}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (open) onClose();
          else onOpen();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onOpen();
        } else if (e.key === "ArrowDown" || e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      {...binding}
      className={cn(
        "appearance-none border-0 bg-transparent p-0 text-left",
        // Top padding only — the bar hugs the very bottom of the handle so, when
        // collapsed, it sits right above the input with no gap below it.
        "pointer-events-auto mx-auto flex w-full max-w-3xl shrink-0 cursor-grab touch-none select-none items-center justify-center pt-2.5 active:cursor-grabbing",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:rounded-full",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-10 rounded-full transition-colors duration-300",
          glow ? "bg-[rgba(255,180,120,0.75)]" : "bg-white/35",
        )}
      />
    </button>
  );
}

/** Three quiet, borderless dots that breathe while the assistant is replying. */
function TypingDots({ reduce }: { reduce?: boolean }): React.JSX.Element {
  return (
    <motion.div
      className="mb-2.5 flex w-full justify-start"
      data-testid="typing-dots"
      role="status"
      aria-label="assistant is responding"
      // Fade in/out so the dots dissolve with the reply rather than popping.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.45, ease: OVERLAY_EASE }}
    >
      <div
        className={cn(
          "rounded-2xl rounded-bl-md border border-white/10 bg-black/45 px-3.5 py-2 text-white/90",
          FLOAT_SHADOW,
        )}
      >
        <span className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/70 motion-reduce:animate-none"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
      </div>
    </motion.div>
  );
}

/**
 * One turn of the transcript as a chat bubble — assistant on the left, user on
 * the right. Memoized so a live drag (which re-renders the overlay on every
 * pointer-move frame) doesn't re-render every message in a long thread.
 */
const ThreadLine = React.memo(function ThreadLine({
  message,
  floating,
  reduce,
}: {
  message: ShellMessage;
  floating?: boolean;
  reduce?: boolean;
}): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <motion.div
      data-testid="thread-line"
      data-role={message.role}
      // New turns rise+fade in. Transform/opacity only; reduced motion collapses
      // it to a quick fade with no positional movement.
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
      transition={{ duration: reduce ? 0.15 : 0.52, ease: OVERLAY_EASE }}
      className={cn(
        "flex w-full",
        floating ? "mb-1.5" : "mb-2.5",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed",
          // The chrome-free transcript renders floating: each bubble carries its
          // own dark glass so it stays legible directly over whatever view is
          // behind. The light tone is for any embedding that supplies its own
          // surrounding scrim.
          isUser ? "rounded-br-md" : "rounded-bl-md",
          floating
            ? cn(
                "border",
                isUser
                  ? "border-white/15 bg-black/55 text-white"
                  : "border-white/10 bg-black/45 text-white/90",
                FLOAT_SHADOW,
              )
            : isUser
              ? "bg-white/20 text-white"
              : "bg-white/10 text-white/90",
        )}
      >
        {message.content}
      </div>
    </motion.div>
  );
});

export function ContinuousChatOverlay({
  controller,
}: {
  controller: ShellController;
}): React.JSX.Element {
  const {
    messages,
    phase,
    send,
    canSend,
    recording,
    toggleRecording,
    startRecording,
    stopRecording,
    transcript,
    speaking,
    agentVoiceMuted,
    toggleAgentVoiceMute,
  } = controller;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  const [draft, setDraft] = React.useState("");
  // The chat-history sheet: closed (a slim peek + grabber) ↔ open (full
  // scrollable history). The ONLY open/close driver — opened by a pull-up drag,
  // by focusing the composer, or by sending; closed by a pull-down drag or
  // Escape. Never by click-out, scroll, or blur.
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // iOS-style 3 detents: PEEK (sheet closed) → HALF → FULL. `sheetOpen` stays
  // the primary peek-vs-open gate (suggestions, scroll-pin, scrim); `expanded`
  // selects FULL vs HALF while open. Grabber pulls step through the detents
  // (each cross fires a light haptic); programmatic opens (send/focus) go FULL.
  const [expanded, setExpanded] = React.useState(false);
  // Live drag offset in px (positive = pulling up) while the grabber/peek is
  // dragged; 0 at rest. Drives the sheet height 1:1 so it tracks the finger,
  // then resets when the release spring takes over.
  const [drag, setDrag] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [pushToTalkActive, setPushToTalkActive] = React.useState(false);
  const [pendingImages, setPendingImages] = React.useState<ImageAttachment[]>(
    [],
  );
  const [imageError, setImageError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const panelRef = React.useRef<HTMLFieldSetElement>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const focusThreadRef = React.useRef(false);
  const pushToTalkTimerRef = React.useRef<number | null>(null);
  const pushToTalkActiveRef = React.useRef(false);
  const suppressMicClickRef = React.useRef(false);

  // Recomputed only when the thread changes — NOT on every drag/draft re-render.
  const visibleMessages = React.useMemo(
    () => messages.filter((m) => m.content.trim()),
    [messages],
  );
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  // The last line id the scroll effect pinned to — lets it tell a NEW line
  // (always pin to bottom) from streaming growth of the current line (follow
  // only when the reader is already at the bottom).
  const scrollPinnedIdRef = React.useRef(lastId);

  const booting = phase === "booting";
  const listening = phase === "listening";
  const responding = phase === "responding";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;

  // The suggestion strip is a keyboard-style row of one-tap prompts shown in the
  // RESTING (closed) state — ready, nothing typed or attached, not recording. It
  // unmounts once the sheet opens or a draft starts; this condition also gates
  // the small-model fetch so it isn't called for a hidden strip.
  const suggestionsVisible =
    !sheetOpen && !recording && !booting && canSend && !hasDraft && !hasImages;

  // Three tailored prompt suggestions for the resting overlay (model-backed via
  // TEXT_SMALL, with a static offline fallback).
  const suggestions = usePromptSuggestions(messages, {
    enabled: suggestionsVisible,
  });

  React.useEffect(
    () => () => {
      if (pushToTalkTimerRef.current !== null) {
        window.clearTimeout(pushToTalkTimerRef.current);
      }
    },
    [],
  );

  // Keep the transcript pinned to the latest line. On first open jump INSTANTLY
  // to the bottom — a layout effect runs before paint, so the thread never
  // flashes at the top. A NEW line (the user's own send, or a fresh reply)
  // always re-pins to the bottom; streaming growth of the current line follows
  // only when the reader is already resting at the bottom, so scrolling up to
  // read history is never yanked down.
  const wasOpenRef = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastId/lastContent/sheetOpen are the triggers; the body reads refs
  React.useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const isNewLine = lastId !== scrollPinnedIdRef.current;
    scrollPinnedIdRef.current = lastId;

    // CLOSED peek: always pin to the bottom so it whispers the LATEST line (the
    // one nearest the composer) — even though it can't be user-scrolled, the
    // clipped content must show the end of the thread, not the top.
    if (!sheetOpen) {
      wasOpenRef.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }

    // OPEN: jump to the bottom on first open; a NEW line re-pins (smooth); while
    // already resting at the bottom, follow streaming growth — but never yank a
    // reader who has scrolled up to read history. Direct scrollTop assignment is
    // more reliable than scrollIntoView inside this clipped flex column.
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNewLine && !justOpened && !reduce && atBottom) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else if (justOpened || isNewLine || atBottom) {
      el.scrollTop = el.scrollHeight;
    }
    if (justOpened && focusThreadRef.current) {
      el.focus();
      focusThreadRef.current = false;
    }
  }, [lastId, lastContent, sheetOpen]);

  // The closed peek must always whisper the NEWEST line, but closing is an
  // animated height collapse: a one-shot scroll set runs before the height
  // finishes shrinking, leaving the peek parked mid-thread as clientHeight
  // drops. Observe the peek while closed and re-pin to the bottom on every size
  // change (animation frames, web-font reflow, viewport resize) until it
  // settles. Disconnects the moment the sheet opens.
  React.useEffect(() => {
    const el = threadRef.current;
    if (!el || sheetOpen || typeof ResizeObserver === "undefined") return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheetOpen]);

  const submit = React.useCallback(() => {
    const text = draft.trim();
    const images = pendingImages;
    // An image-only turn is valid; only bail when there's nothing to send.
    if ((!text && images.length === 0) || !canSend) return;
    setDraft("");
    setPendingImages([]);
    setImageError(null);
    if (images.length) {
      send(text, { images });
    } else {
      send(text);
    }
    setSheetOpen(true);
    setExpanded(true);
    detentHaptic();
    inputRef.current?.focus();
  }, [draft, pendingImages, canSend, send]);

  // Tapping a suggestion sends it immediately (same path as submit), so the
  // strip is a one-tap shortcut, not just a draft pre-fill.
  const pickSuggestion = React.useCallback(
    (text: string) => {
      if (!canSend) return;
      setDraft("");
      send(text);
      setSheetOpen(true);
      setExpanded(true);
      detentHaptic();
      inputRef.current?.focus();
    },
    [canSend, send],
  );

  const addImageFiles = React.useCallback((files: FileList | File[]) => {
    void filesToImageAttachments(files)
      .then((attachments) => {
        if (!attachments.length) return;
        setImageError(null);
        setPendingImages((prev) =>
          [...prev, ...attachments].slice(0, MAX_CHAT_IMAGES),
        );
      })
      .catch((err: unknown) => {
        // Surface the failure inline rather than silently dropping the image —
        // the overlay is pure, so it can't reach the global notice channel.
        setImageError(
          err instanceof Error ? err.message : "Couldn't read image",
        );
      });
  }, []);

  const removeImage = React.useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearPushToTalkTimer = React.useCallback(() => {
    if (pushToTalkTimerRef.current === null) return;
    window.clearTimeout(pushToTalkTimerRef.current);
    pushToTalkTimerRef.current = null;
  }, []);

  const beginPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (hasDraft || recording || booting || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      clearPushToTalkTimer();
      pushToTalkTimerRef.current = window.setTimeout(() => {
        pushToTalkTimerRef.current = null;
        pushToTalkActiveRef.current = true;
        setPushToTalkActive(true);
        startRecording();
      }, 200);
    },
    [booting, clearPushToTalkTimer, hasDraft, recording, startRecording],
  );

  const endPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      clearPushToTalkTimer();
      if (!pushToTalkActiveRef.current) return;
      suppressMicClickRef.current = true;
      pushToTalkActiveRef.current = false;
      setPushToTalkActive(false);
      stopRecording();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [clearPushToTalkTimer, stopRecording],
  );

  const handleMicClick = React.useCallback(() => {
    if (suppressMicClickRef.current) {
      suppressMicClickRef.current = false;
      return;
    }
    toggleRecording();
  }, [toggleRecording]);

  const hasThread = visibleMessages.length > 0;

  const settleDrag = React.useCallback(() => {
    setDrag(0);
    setDragging(false);
  }, []);

  const closeSheet = React.useCallback(() => {
    setSheetOpen(false);
    setExpanded(false);
    settleDrag();
  }, [settleDrag]);

  // Snap to one of the three iOS-style detents and settle the live drag. A
  // detent change fires a light haptic so the snap feels physical on device.
  // "collapsed" hides the history entirely (just the input); "half" is the
  // comfortable reading height; "full" the near-fullscreen reading mode.
  const goToDetent = React.useCallback(
    (detent: "collapsed" | "half" | "full") => {
      setSheetOpen(detent !== "collapsed");
      setExpanded(detent === "full");
      settleDrag();
      detentHaptic();
    },
    [settleDrag],
  );

  // Collapsing always drops input focus, so the mobile keyboard goes away the
  // moment the chat is dismissed (pull-down, Escape, or click-out) — the chat is
  // no longer "focused". Blurring (rather than the old refocus dance) also means
  // there's no focus→expand bounce to guard against, so the model stays simple.
  const collapse = React.useCallback(() => {
    closeSheet();
    inputRef.current?.blur();
  }, [closeSheet]);

  // Focusing or typing in the composer pulls the chat up (open) when there's a
  // thread to show. No-op with no thread — the first send opens it.
  const expand = React.useCallback(() => {
    if (hasThread) setSheetOpen(true);
  }, [hasThread]);

  // Tapping ANYWHERE outside the chat panel drops the keyboard: if the composer
  // holds focus and the pointer lands outside the panel, blur it. This is the
  // iOS-standard "tap the background to dismiss the keyboard" behaviour and works
  // whether the chat is open (over the scrim) or collapsed (over the live view).
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return;
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      input.blur();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Auto-grow the composer with multi-line input: snap to the content height
  // (capped by `max-h` in CSS, which then scrolls). Runs on every draft change
  // so it also springs back to one line after a send clears the draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the trigger; the body reads the textarea ref
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // --- Pull gesture --------------------------------------------------------
  // The chat-history sheet is the draggable element. A live drag updates `drag`
  // (px, + = up) so the sheet height tracks the finger, resisting past either
  // detent (rubber-band in the render); release fires onPullUp/onPullDown
  // (distance OR velocity threshold, via usePullGesture) to snap. ONE binding
  // serves both the grabber and the closed peek — the handlers are state-aware,
  // so a wrong-direction pull is a harmless no-op. Closing here is the ONLY
  // dismiss path besides Escape: no click-out, scroll, or blur closes the sheet.
  const onDragOffset = React.useCallback(
    (offset: number) => {
      setDragging(true);
      // Three detents, three live-drag ranges. Peek (closed): only an upward
      // (positive) drag is meaningful. Full (expanded): only a downward
      // (negative) one. Half (the middle): both directions are live so the
      // finger can climb to full or fall to peek. Pin the dead direction so the
      // sheet feels held at the ends.
      if (!sheetOpen) setDrag(Math.max(0, offset));
      else if (expanded) setDrag(Math.min(0, offset));
      else setDrag(offset);
    },
    [sheetOpen, expanded],
  );

  const pullBinding: PullGestureBinding = usePullGesture({
    onDrag: onDragOffset,
    // Pulls STEP one detent at a time (peek→half→full and back) rather than
    // jumping straight to the ends — the iOS sheet feel. The inline closures are
    // rebuilt every render, so they always read the current detent.
    onPullUp: () => {
      if (!sheetOpen) {
        if (!hasThread) return settleDrag();
        goToDetent("half");
        focusThreadRef.current = true;
      } else if (!expanded) {
        goToDetent("full");
        focusThreadRef.current = true;
      } else {
        settleDrag();
      }
    },
    onPullDown: () => {
      if (expanded) goToDetent("half");
      else if (sheetOpen) goToDetent("collapsed");
      else settleDrag();
    },
  });

  // NOTE: the sheet deliberately has NO close-on-outside-pointerdown and NO
  // close-on-scroll listener. Clicking/scrolling anywhere outside the chat does
  // nothing — the sheet closes ONLY on a pull-down drag (the grabber) or Escape.

  // Viewport height drives the OPEN detent. Track the VISUAL viewport so the
  // open sheet sizes to the space actually left above the mobile on-screen
  // keyboard — visualViewport shrinks when the keyboard shows (and on rotation),
  // whereas window.innerHeight does not on iOS. Falls back to innerHeight on
  // desktop / older webviews and to a fixed value under SSR / tests.
  const readViewportH = React.useCallback(
    () =>
      typeof window === "undefined"
        ? 800
        : (window.visualViewport?.height ?? window.innerHeight),
    [],
  );
  const [viewportH, setViewportH] = React.useState(readViewportH);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setViewportH(readViewportH());
    const vv = window.visualViewport;
    window.addEventListener("resize", onResize);
    vv?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onResize);
    };
  }, [readViewportH]);

  // The thread (history) is the part that grows: the input bar is always there
  // and the conversation animates UP out of it inside the same panel. Three
  // detents — COLLAPSED (thread height 0, fully gone — no peek/whisper), a
  // comfortable HALF, and a near-full FULL. The live drag offset is added and
  // rubber-banded past FULL; the bottom is hard-clamped to 0 (you can't drag the
  // history below nothing).
  const openH = Math.round(viewportH * SHEET_OPEN_VH);
  const halfH = Math.round(viewportH * SHEET_HALF_VH);
  const baseH = !sheetOpen ? 0 : expanded ? openH : halfH;
  const rawH = baseH + drag;
  const threadH =
    rawH > openH ? openH + rubberBand(rawH - openH) : Math.max(0, rawH);
  // Reveal fraction 0→1 across the collapse→full gap; fades the dimming + the
  // backdrop in as the history grows.
  const revealed = Math.min(1, Math.max(0, threadH / Math.max(1, openH)));

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 flex w-full min-w-0 flex-col items-center px-3 sm:px-4",
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+1.5rem)]",
      )}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      data-testid="continuous-chat-overlay"
      data-open={sheetOpen ? "true" : undefined}
    >
      {/* Dimming scrim behind the open chat. It fades in WITH the reveal and
          captures pointer events while open; clicking it COLLAPSES the chat back
          to the input. Collapsed → pointer-events-none, so the view behind stays
          fully live (the overlay is non-blocking by design). */}
      <motion.div
        aria-hidden="true"
        data-testid="chat-sheet-backdrop"
        data-active={sheetOpen ? "true" : "false"}
        onClick={sheetOpen ? collapse : undefined}
        className="fixed inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.06)_0%,rgba(8,10,18,0.55)_46%,rgba(0,0,0,0.66)_100%)]"
        style={{ pointerEvents: revealed > 0.04 ? "auto" : "none" }}
        initial={false}
        animate={{ opacity: revealed }}
        transition={
          dragging || reduce
            ? { duration: 0 }
            : { duration: 0.2, ease: OVERLAY_EASE }
        }
      />

      {/* Cinematic bottom vignette — grounds the floating bar over bright views. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/45 via-black/15 to-transparent"
      />

      {/* Live interim transcript while listening */}
      {recording && transcript ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "pointer-events-none relative mb-2 w-full max-w-3xl text-center text-sm italic text-white/85",
            FLOAT_SHADOW,
          )}
        >
          {transcript}
          <span aria-hidden="true">…</span>
        </div>
      ) : null}

      {/* Three tailored prompt suggestions — a keyboard-style strip shown in the
          resting (closed) state when nothing is typed. Tapping one sends it
          immediately, which also pulls the chat sheet up. `order: -1` floats the
          strip ABOVE the chat sheet (sheet-below-bubbles layout); the strip fades
          out as the sheet is dragged up so the unmount on open never pops. */}
      {suggestionsVisible ? (
        <fieldset
          aria-label="Suggested prompts"
          className={cn(
            "pointer-events-auto relative m-0 mb-2 flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 border-0 p-0",
          )}
          style={{ order: -1, opacity: Math.max(0, 1 - revealed) }}
          data-testid="chat-suggestions"
        >
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              data-testid={`chat-suggestion-${i}`}
              aria-label={s}
              onClick={() => pickSuggestion(s)}
              className={cn(
                "max-w-full truncate rounded-full border border-white/15 bg-black/40 px-3 py-1.5",
                "text-[12px] text-white/80 backdrop-blur-xl transition-colors",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_30px_-12px_rgba(0,0,0,0.6)]",
                "hover:border-white/30 hover:bg-white/15 hover:text-white",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
              )}
            >
              {s}
            </button>
          ))}
        </fieldset>
      ) : null}

      {/* THE chat — one connected object. Its base is the always-present input;
          the conversation grows UP out of it on a pull, inside this same panel.
          Fully collapsed at rest (just the input, plus a grabber handle once
          there's a thread). Pull the grabber up to reveal history; pull down,
          press Escape, or click outside to collapse. The thread height animates
          0 → half → full within this element — the chat and the input are never
          two separate pieces. */}
      <fieldset
        ref={panelRef}
        aria-label="Chat composer"
        data-testid="chat-sheet"
        data-variant={sheetOpen ? "open" : "closed"}
        data-detent={!sheetOpen ? "collapsed" : expanded ? "full" : "half"}
        data-revealed={revealed > 0.5 ? "true" : "false"}
        className={cn(
          "pointer-events-auto relative m-0 flex w-full min-w-0 max-w-3xl flex-col overflow-hidden border-0 p-0",
          // Liquid glass: a translucent, blurred, slightly over-saturated pane
          // (more glass where backdrop-filter is supported) with a bright top
          // specular edge + a faint full-perimeter refractive inner stroke.
          "rounded-[28px] border border-white/[0.14] bg-black/55 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-black/40",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.20),inset_0_0_0_0.5px_rgba(255,255,255,0.06),0_18px_50px_-16px_rgba(0,0,0,0.72)]",
        )}
      >
        {/* Specular sheen — a soft light from the top edge, the liquid-glass
            highlight. Subtle + non-interactive. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-20 bg-gradient-to-b from-white/[0.07] to-transparent"
        />
        {/* Soft live-state glow at the base — warm while listening, cool while
            replying. Clipped to the panel (the glass already grounds it). */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-28 blur-2xl"
          initial={false}
          animate={{
            opacity: listening || responding ? 1 : 0,
            backgroundColor: listening
              ? "rgba(255,180,120,0.30)"
              : "rgba(190,210,255,0.20)",
          }}
          transition={{ duration: reduce ? 0 : 1.1, ease: "easeInOut" }}
        />

        {/* Grabber — the pull handle, present once there's a thread to reveal. */}
        {hasThread ? (
          <SheetGrabber
            open={sheetOpen}
            onOpen={() => {
              goToDetent("half");
              focusThreadRef.current = true;
            }}
            onClose={collapse}
            binding={pullBinding}
            glow={listening || responding}
          />
        ) : null}

        {/* The conversation. Height animates 0 (collapsed) → half → full; the
            inner log scrolls. The grabber owns the drag, so dragging the messages
            just scrolls them. */}
        {hasThread ? (
          <motion.div
            data-testid="chat-thread"
            className="relative z-10 w-full overflow-hidden"
            initial={false}
            animate={{ height: threadH }}
            transition={dragging || reduce ? { duration: 0 } : SHEET_SPRING}
          >
            <div
              id="continuous-thread"
              ref={threadRef}
              role="log"
              aria-label="conversation history"
              aria-live="polite"
              aria-hidden={revealed < 0.5 ? true : undefined}
              tabIndex={sheetOpen ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  collapse();
                }
              }}
              className="relative flex h-full w-full touch-pan-y flex-col overflow-y-auto px-5 [scrollbar-width:none] focus-visible:outline-none [&::-webkit-scrollbar]:hidden"
            >
              {/* `mt-auto` keeps the latest line at the bottom (nearest the input)
                  until the thread overflows, then it scrolls. */}
              <div className="mt-auto flex flex-col pb-3 pt-1">
                <AnimatePresence initial={false}>
                  {visibleMessages.map((m) => (
                    <ThreadLine
                      key={m.id}
                      message={m}
                      floating
                      reduce={reduce}
                    />
                  ))}
                </AnimatePresence>
                <AnimatePresence>
                  {responding ? <TypingDots reduce={reduce} /> : null}
                </AnimatePresence>
                <div ref={endRef} />
              </div>
            </div>
          </motion.div>
        ) : null}
        {/* Pending image attachments + any read error, just above the input. */}
        {hasImages || imageError ? (
          <div className="relative z-10 flex flex-col gap-1.5 px-3 pt-2">
            {hasImages ? (
              <div className="flex flex-wrap gap-2">
                {pendingImages.map((img, i) => (
                  <div
                    key={`${img.name}-${img.mimeType}-${img.data.length}`}
                    className="group relative h-14 w-14 shrink-0"
                  >
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={img.name}
                      className="h-14 w-14 rounded-lg border border-white/20 object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`remove ${img.name}`}
                      onClick={() => removeImage(i)}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-white/20 bg-black/70 text-xs text-white/90 backdrop-blur transition-colors hover:bg-black/90"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {imageError ? (
              <p
                role="alert"
                className={cn("text-xs text-red-200/90", FLOAT_SHADOW)}
              >
                {imageError}
              </p>
            ) : null}
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImageFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {/* The input row — the base of the panel, always visible. A hairline
            divider sits above it whenever the history is open. */}
        <div
          className={cn(
            // items-end keeps the +/mic controls pinned to the bottom as the
            // textarea grows upward with multi-line input.
            "relative z-10 flex min-w-0 items-end gap-1.5 px-3 py-2 sm:gap-2 sm:px-3.5",
            sheetOpen ? "border-t border-white/10" : "",
          )}
        >
          <SoftButton
            glyph={PLUS_GLYPH}
            label="attach image"
            disabled={booting || pendingImages.length >= MAX_CHAT_IMAGES}
            onClick={() => fileInputRef.current?.click()}
            testId="chat-composer-attach"
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (e.target.value.trim().length > 0) expand();
            }}
            onFocus={expand}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter inserts a newline (multi-line compose).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && sheetOpen) {
                e.preventDefault();
                collapse();
              }
            }}
            placeholder={booting ? "connecting…" : "say anything…"}
            aria-label="message"
            data-testid="chat-composer-textarea"
            aria-describedby={booting ? "cc-booting-hint" : undefined}
            aria-disabled={booting}
            readOnly={booting}
            className="max-h-[8.5rem] min-h-8 min-w-0 flex-1 resize-none self-end border-none bg-transparent px-1 py-1 text-sm leading-relaxed text-white/[0.92] outline-none [scrollbar-width:none] placeholder:text-white/45 [&::-webkit-scrollbar]:hidden"
          />
          <span id="cc-booting-hint" className="sr-only">
            connecting — you can’t send yet
          </span>
          {/* Assistant-voice mute: shown only while the agent is speaking or
              already muted, so the resting bar stays uncluttered. */}
          {speaking || agentVoiceMuted ? (
            <SoftButton
              glyph={agentVoiceMuted ? SPEAKER_MUTED_GLYPH : SPEAKER_GLYPH}
              label={
                agentVoiceMuted
                  ? "unmute assistant voice"
                  : "mute assistant voice"
              }
              active={agentVoiceMuted}
              onClick={toggleAgentVoiceMute}
              testId="chat-voice-mute"
            />
          ) : null}
          {/* One trailing control, ChatGPT-style: mic when there's nothing to
              send (or while recording, to stop), swapping to send once the user
              starts typing or attaches an image. */}
          {/* The trailing control morphs between mic and send. The `key` flip
              remounts on each swap, so React removes the old control instantly
              (no exit lag) and the new one pops in — a quick scale/fade that
              reads as a morph without an AnimatePresence exit delay. */}
          <motion.div
            key={(hasDraft || hasImages) && !recording ? "send" : "mic"}
            className="shrink-0"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reduce ? 0 : 0.3, ease: OVERLAY_EASE }}
          >
            {(hasDraft || hasImages) && !recording ? (
              <SoftButton
                glyph={SEND_GLYPH}
                label={canSend ? "send" : "send (waiting for reply)"}
                disabled={!canSend}
                onClick={submit}
                testId="chat-composer-action"
              />
            ) : (
              <SoftButton
                glyph={MIC_GLYPH}
                label={
                  pushToTalkActive
                    ? "release to send"
                    : recording
                      ? "stop listening"
                      : "talk"
                }
                active={recording}
                disabled={booting}
                onClick={handleMicClick}
                onPointerDown={beginPushToTalkPress}
                onPointerUp={endPushToTalkPress}
                onPointerCancel={endPushToTalkPress}
                testId="chat-composer-mic"
              />
            )}
          </motion.div>
        </div>
      </fieldset>
    </div>
  );
}
