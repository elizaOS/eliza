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
import { usePromptSuggestions } from "./usePromptSuggestions";
import type { ShellController } from "./useShellController";

/**
 * The continuous-chat overlay: one always-present, ambient glass conversation
 * that floats over EVERY view. There are no separate chats and no switcher — it
 * is a single endless thread (the app's one active conversation, via
 * useShellController). Collapsed, recent lines "whisper" — dissolving in over
 * whatever is behind — and an always-present composer bar invites the next line;
 * expanding reveals the whole thread as one flowing, single-column transcript
 * (no chat-app bubbles). The container is pointer-events-none (the view behind
 * stays live); only the composer + thread capture input, so it is non-blocking,
 * unlike the focus-trapping AssistantOverlay it supersedes in the main shell.
 *
 * Two design rules keep it intimate rather than app-like:
 *  1. SELF-CONTAINED CONTRAST — every surface carries its own dark-glass scrim
 *     (or, for floating text, a soft shadow) plus fixed light text, never the
 *     theme's `--txt`, so it stays legible over any substrate: a bright view, a
 *     dark view, or the warm "good evening" backdrop.
 *  2. NO CHROME/SIGNAGE — the thread speaks for itself: no message counter, no
 *     "new chat", no tab strip, controls dissolve into the glass, and status is
 *     a soft breath of light, not a brand-colored alert ring.
 *
 * Pure/presentational: it takes the controller as a prop so it can be rendered
 * in isolation (stories / harness) with a mock. The app wraps it in a small
 * context-reading mount (see App.tsx) that supplies the shared controller.
 */

// Self-contained glass composer bar (fixed dark scrim + light edge highlight) —
// does NOT use theme `--txt`, so it reads over bright, dark, or warm backdrops.
// The expanded transcript itself is intentionally chrome-free (no panel
// background/border); its lines carry their own scrim via ThreadLine `floating`.
const GLASS_BAR =
  "flex items-center gap-2 rounded-full border border-white/18 bg-black/45 px-3 py-2 backdrop-blur-xl " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_16px_46px_-12px_rgba(0,0,0,0.66)]";

// Floating (un-scrimmed) text gets a soft shadow so it reads over bright views.
const FLOAT_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]";

// Shared easing for the overlay's cheap motion path. Fullscreen open/close must
// stay opacity/translate only: animating blur/filter or scaling a scrollable
// transcript repaints too much of the viewport and visibly janks on laptops.
const OVERLAY_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// Resting / typing view (not fullscreen) shows only the last couple of turns
// with no scroll; fullscreen shows the whole history with scroll.
const RESTING_THREAD_LINES = 2;

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
// Two diagonal expand arrows (top-right + bottom-left) — "open in full page".
const MAXIMIZE_GLYPH =
  "M20 8H28V16H25V13.1L18.5 19.6L16.4 17.5L22.9 11H20Z " +
  "M16 28H8V20H11V22.9L17.5 16.4L19.6 18.5L13.1 25H16Z";
// Trash can (lid bar + body) — DEV-only "clear conversation" debug control.
const TRASH_GLYPH = "M14 7H22V10H27V13H9V10H14Z M11 15H25L23.5 30H12.5Z";

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

/** Three quiet, borderless dots that breathe while the assistant is replying. */
function TypingDots({ reduce }: { reduce?: boolean }): React.JSX.Element {
  return (
    <motion.div
      className="flex gap-1.5"
      role="status"
      aria-label="assistant is responding"
      // Fade in/out so the dots dissolve with the reply rather than popping.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.45, ease: OVERLAY_EASE }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            // `motion-reduce:animate-none` stills the breathing pulse for users
            // who ask for reduced motion (the CSS pulse isn't a motion/react anim).
            "h-1.5 w-1.5 animate-pulse rounded-full bg-white/70 motion-reduce:animate-none",
            FLOAT_SHADOW,
          )}
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </motion.div>
  );
}

/** One turn of the transcript as a chat bubble — assistant on the left, user on the right. */
function ThreadLine({
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
      // New turns rise+fade in (and the old whisper line slides out as the
      // 2-line resting window shifts). Transform/opacity only; reduced motion
      // collapses it to a quick fade with no positional movement.
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
          // Both the whisper lines and the chrome-free expanded transcript
          // render floating: each bubble carries its own dark glass so it stays
          // legible directly over whatever view is behind. The light tone is for
          // any embedding that supplies its own surrounding scrim.
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
}

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
    clearConversation,
  } = controller;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  const [draft, setDraft] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  const [composerFocused, setComposerFocused] = React.useState(false);
  const [whisperVisible, setWhisperVisible] = React.useState(false);
  const [pushToTalkActive, setPushToTalkActive] = React.useState(false);
  const [pendingImages, setPendingImages] = React.useState<ImageAttachment[]>(
    [],
  );
  const [imageError, setImageError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const suggestionsRef = React.useRef<HTMLFieldSetElement>(null);
  const composerRef = React.useRef<HTMLFieldSetElement>(null);
  const focusThreadRef = React.useRef(false);
  const pushToTalkTimerRef = React.useRef<number | null>(null);
  const pushToTalkActiveRef = React.useRef(false);
  const suppressMicClickRef = React.useRef(false);
  const hoverLeaveTimerRef = React.useRef<number | null>(null);

  const visibleMessages = messages.filter((m) => m.content.trim());
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  const seenIdRef = React.useRef(lastId);
  // The last line id the scroll effect pinned to — lets it tell a NEW line
  // (always pin to bottom) from streaming growth of the current line (follow
  // only when the reader is already at the bottom).
  const scrollPinnedIdRef = React.useRef(lastId);

  const booting = phase === "booting";
  const listening = phase === "listening";
  const responding = phase === "responding";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;
  const open = expanded || hovered || fullscreen || composerFocused;
  // "Peek" = the non-fullscreen reveal: the chat bubbles + suggestions fade in
  // when the user hovers the bar, focuses the composer, clicks into a populated
  // thread (expanded), while a reply is streaming (responding), or briefly when
  // a new line arrives (whisperVisible). They fade back out otherwise.
  const peek =
    !fullscreen &&
    (hovered || composerFocused || expanded || responding || whisperVisible);

  // The suggestion strip rides along with the bubbles (same peek reveal). The
  // base conditions keep it sensible (ready, nothing typed/attached, not
  // listening); `peek` gates both its visibility and the model fetch so the
  // small model isn't called for a hidden strip.
  const suggestionsBase =
    !fullscreen && !recording && !booting && canSend && !hasDraft && !hasImages;
  const suggestionsVisible = peek && suggestionsBase;

  // Three tailored prompt suggestions for the resting overlay (model-backed via
  // TEXT_SMALL, with a static offline fallback).
  const suggestions = usePromptSuggestions(messages, {
    enabled: suggestionsVisible,
  });

  // Whisper: when a genuinely NEW line arrives while collapsed, surface the
  // recent lines for 12s. Keyed on the last message id (not length, and the
  // `open` dep early-returns) so toggling the panel never re-triggers it.
  React.useEffect(() => {
    if (lastId === seenIdRef.current) return;
    seenIdRef.current = lastId;
    if (open) return;
    setWhisperVisible(true);
    const timer = window.setTimeout(() => setWhisperVisible(false), 12000);
    return () => window.clearTimeout(timer);
  }, [lastId, open]);

  React.useEffect(() => {
    if (open) setWhisperVisible(false);
  }, [open]);

  React.useEffect(
    () => () => {
      if (pushToTalkTimerRef.current !== null) {
        window.clearTimeout(pushToTalkTimerRef.current);
      }
      if (hoverLeaveTimerRef.current !== null) {
        window.clearTimeout(hoverLeaveTimerRef.current);
      }
    },
    [],
  );

  // Keep the transcript pinned to the latest line. On first open (or when
  // entering fullscreen) jump INSTANTLY to the bottom — a layout effect runs
  // before paint, so the thread never flashes at the top. A NEW line (the
  // user's own send, or a fresh reply) always re-pins to the bottom; streaming
  // growth of the current line follows only when the reader is already resting
  // at the bottom, so scrolling up to read history is never yanked down.
  const wasOpenRef = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastId/lastContent/fullscreen are the triggers; the body reads refs
  React.useLayoutEffect(() => {
    // Only the fullscreen transcript scrolls; the resting/typing view shows the
    // last couple of turns with no scroll, so there is nothing to pin there.
    if (!fullscreen) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    const isNewLine = lastId !== scrollPinnedIdRef.current;
    scrollPinnedIdRef.current = lastId;

    const el = threadRef.current;
    const atBottom =
      !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;

    if (justOpened || isNewLine || atBottom) {
      endRef.current?.scrollIntoView(
        isNewLine && !justOpened && !reduce
          ? { behavior: "smooth", block: "end" }
          : { block: "end" },
      );
    }
    if (justOpened && focusThreadRef.current) {
      threadRef.current?.focus();
      focusThreadRef.current = false;
    }
  }, [lastId, lastContent, fullscreen]);

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
    setExpanded(true);
    inputRef.current?.focus();
  }, [draft, pendingImages, canSend, send]);

  // Tapping a suggestion sends it immediately (same path as submit), so the
  // strip is a one-tap shortcut, not just a draft pre-fill.
  const pickSuggestion = React.useCallback(
    (text: string) => {
      if (!canSend) return;
      setDraft("");
      send(text);
      setExpanded(true);
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

  const collapseAll = React.useCallback(() => {
    setExpanded(false);
    setFullscreen(false);
    setHovered(false);
    setComposerFocused(false);
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
  }, []);

  const collapse = React.useCallback(() => {
    collapseAll();
    inputRef.current?.focus();
  }, [collapseAll]);

  // Hover reveal: entering the bar (or the bubbles) peeks the chat; leaving fades
  // it back out after a short grace so moving between the bubbles and the
  // composer doesn't flicker it closed.
  const handleHoverEnter = React.useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  const handleHoverLeave = React.useCallback(() => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current);
    }
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      hoverLeaveTimerRef.current = null;
      setHovered(false);
    }, 150);
  }, []);

  const handleAmbientFocus = React.useCallback(() => {
    setComposerFocused(true);
  }, []);

  const handleAmbientBlur = React.useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      const staysInOverlay =
        next instanceof Element &&
        ((composerRef.current?.contains(next) ?? false) ||
          (suggestionsRef.current?.contains(next) ?? false));
      if (!staysInOverlay) setComposerFocused(false);
    },
    [],
  );

  // The maximize button: toggle a true full-screen transcript. /chat is the
  // overlay itself (overlay-only), so there is no separate page to navigate to —
  // "full screen" means expanding this same thread to fill the viewport.
  const toggleFullscreen = React.useCallback(() => {
    setFullscreen((f) => {
      const next = !f;
      if (next && hasThread) focusThreadRef.current = true;
      return next;
    });
    // Entering fullscreen supersedes the partial panel; leaving it collapses.
    setExpanded(false);
  }, [hasThread]);

  // Click into the composer → reveal the thread, but keep keyboard focus in the
  // input (don't arm the thread-focus move) so the user can type immediately.
  const expand = React.useCallback(() => {
    setComposerFocused(true);
    if (!hasThread) return;
    setExpanded(true);
  }, [hasThread]);

  // Close the thread on any pointer-down that isn't on a message bubble, the
  // suggestions, or the composer — i.e. anywhere that isn't the chat itself (the
  // live view behind, a gap in the thread, the backdrop). The overlay root is
  // pointer-events-none, so a capture-phase document listener still catches
  // clicks that fall through to the view behind; guarding on the chat affordances
  // keeps normal interaction from dismissing it.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const onBubble = target.closest('[data-testid="thread-line"]') !== null;
      const inSuggestions = suggestionsRef.current?.contains(target) ?? false;
      const inComposer = composerRef.current?.contains(target) ?? false;
      if (onBubble || inSuggestions || inComposer) return;
      collapseAll();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, collapseAll]);

  return (
    <div
      className={cn(
        "pointer-events-none fixed flex flex-col items-center px-4",
        // Fullscreen: take over the whole viewport (transcript fills, composer
        // pinned to the bottom). Otherwise: a bottom-anchored ambient bar.
        fullscreen
          ? "inset-0 justify-end pt-[calc(var(--safe-area-top,0px)+1rem)]"
          : "inset-x-0 bottom-0",
        "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+1.5rem)]",
      )}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      data-testid="continuous-chat-overlay"
      data-fullscreen={fullscreen ? "true" : undefined}
    >
      {/* Focus backdrop — a cheap scrim over the live view. Always mounted (so
          its testid is stable); only opacity animates. Captures pointer events only while
          fullscreen; clicking it exits via the outside-click handler. */}
      <motion.div
        aria-hidden="true"
        data-testid="chat-fullscreen-backdrop"
        data-active={fullscreen ? "true" : "false"}
        className={cn(
          "fixed inset-0",
          "bg-[linear-gradient(135deg,rgba(255,255,255,0.08)_0%,rgba(8,10,18,0.64)_48%,rgba(0,0,0,0.70)_100%)]",
          fullscreen ? "pointer-events-auto" : "pointer-events-none",
        )}
        initial={false}
        animate={{
          opacity: fullscreen ? 1 : 0,
        }}
        transition={{ duration: reduce ? 0.08 : 0.16, ease: OVERLAY_EASE }}
      />

      {/* Cinematic bottom vignette — grounds the floating bar over bright views.
          Hidden in fullscreen: the solid backdrop already supplies contrast. */}
      {!fullscreen ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/45 via-black/15 to-transparent"
        />
      ) : null}

      {/* Fullscreen transcript — full history in a plain composited panel. Keep
          the transition to opacity/translate so long threads do not stutter. */}
      <AnimatePresence>
        {fullscreen && hasThread ? (
          <motion.div
            key="fullscreen-thread"
            id="continuous-thread"
            data-variant="fullscreen"
            ref={threadRef}
            role="log"
            aria-label="conversation history"
            aria-live="polite"
            // The scrollable log region is keyboard-focusable so it can be
            // arrow/Page scrolled (WCAG 2.1.1).
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                collapse();
              }
            }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={
              reduce
                ? { opacity: 0 }
                : {
                    opacity: 0,
                    y: 8,
                    transition: { duration: 0.12, ease: OVERLAY_EASE },
                  }
            }
            transition={
              reduce
                ? { duration: 0.08 }
                : { duration: 0.18, ease: OVERLAY_EASE }
            }
            className={cn(
              "pointer-events-auto relative mb-3 min-h-0 w-full max-w-3xl flex-1 origin-bottom overflow-y-auto px-5 py-6",
              "rounded-[24px] border border-white/12 bg-black/60",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_28px_80px_-28px_rgba(0,0,0,0.62)]",
              // No visible scrollbar — the thread still scrolls, the chrome hides.
              "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
            )}
          >
            <AnimatePresence initial={false}>
              {visibleMessages.map((m) => (
                <ThreadLine key={m.id} message={m} floating reduce={reduce} />
              ))}
            </AnimatePresence>
            <AnimatePresence>
              {responding ? <TypingDots reduce={reduce} /> : null}
            </AnimatePresence>
            <div ref={endRef} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Resting / typing bubbles — the last couple of turns, floating over the
          view with no scroll. Always mounted (when there is a thread) so the
          quick opacity fade plays in BOTH directions; `peek` reveals them on
          hover, on focus (expanded), while replying, or briefly when a new line
          arrives, and fades them back out otherwise. */}
      {!fullscreen && hasThread ? (
        <div
          id="continuous-thread"
          ref={threadRef}
          role="log"
          aria-label="conversation history"
          aria-live="polite"
          aria-hidden={!peek}
          data-revealed={peek ? "true" : "false"}
          data-variant="resting"
          onPointerEnter={handleHoverEnter}
          onPointerLeave={handleHoverLeave}
          className={cn(
            "relative mb-3 w-full max-w-3xl overflow-hidden px-1 py-2 transition-opacity duration-200",
            peek
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          <AnimatePresence initial={false}>
            {visibleMessages.slice(-RESTING_THREAD_LINES).map((m) => (
              <ThreadLine key={m.id} message={m} floating reduce={reduce} />
            ))}
          </AnimatePresence>
          <AnimatePresence>
            {responding ? <TypingDots reduce={reduce} /> : null}
          </AnimatePresence>
        </div>
      ) : null}

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

      {/* Three tailored prompt suggestions — keyboard-strip style. They ride
          along with the chat bubbles (same `peek` reveal: hover or focus) and
          fade with them, so they only appear when the conversation does. Tapping
          one sends it immediately. */}
      {suggestionsBase ? (
        <fieldset
          ref={suggestionsRef}
          onPointerEnter={handleHoverEnter}
          onPointerLeave={handleHoverLeave}
          onFocus={handleAmbientFocus}
          onBlur={handleAmbientBlur}
          aria-label="Suggested prompts"
          aria-hidden={!suggestionsVisible}
          className={cn(
            "relative m-0 mb-2 flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 border-0 p-0 transition-opacity duration-200",
            suggestionsVisible
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0",
          )}
          data-testid="chat-suggestions"
        >
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              data-testid={`chat-suggestion-${i}`}
              aria-label={s}
              tabIndex={suggestionsVisible ? 0 : -1}
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

      {/* The always-present ambient composer (the heart of the layer). Hovering
          it (or the bubbles/suggestions) peeks the chat; leaving fades it out. */}
      <fieldset
        ref={composerRef}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
        onFocus={handleAmbientFocus}
        onBlur={handleAmbientBlur}
        aria-label="Chat composer"
        className="pointer-events-auto relative m-0 w-full max-w-3xl border-0 p-0"
      >
        {/* Soft breath of light for live states — not a brand-colored alert ring.
            Always mounted; only opacity changes so it swells in/out over 700ms. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-3 rounded-full blur-2xl"
          // The glow both swells (opacity) and shifts hue — warm while listening,
          // cool while replying. Animating backgroundColor tweens that hue smoothly
          // instead of snapping. `initial={false}`: settle at rest, animate on change.
          initial={false}
          animate={{
            opacity: listening || responding ? 1 : 0,
            backgroundColor: listening
              ? "rgba(255,180,120,0.32)"
              : "rgba(190,210,255,0.22)",
          }}
          transition={{ duration: reduce ? 0 : 1.1, ease: "easeInOut" }}
        />
        {/* Pending image attachments + any read error, above the bar. */}
        {hasImages || imageError ? (
          <div className="relative mb-2 flex flex-col gap-1.5">
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
        <div className={cn(GLASS_BAR, "relative")}>
          {/* No expand/collapse chevron: focusing the input opens the thread,
              and Escape / clicking outside collapses it. */}
          {/* DEV-only: clear the conversation and start a fresh, greeted one. */}
          {import.meta.env.DEV ? (
            <SoftButton
              glyph={TRASH_GLYPH}
              label="clear conversation (debug)"
              onClick={() => clearConversation?.()}
              testId="chat-composer-clear-debug"
            />
          ) : null}
          <SoftButton
            glyph={MAXIMIZE_GLYPH}
            label={fullscreen ? "exit full screen" : "expand to full screen"}
            active={fullscreen}
            onClick={toggleFullscreen}
            testId="chat-composer-fullscreen"
          />
          <SoftButton
            glyph={PLUS_GLYPH}
            label="attach image"
            disabled={booting || pendingImages.length >= MAX_CHAT_IMAGES}
            onClick={() => fileInputRef.current?.click()}
            testId="chat-composer-attach"
          />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={expand}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && open) {
                e.preventDefault();
                collapseAll();
              }
            }}
            placeholder={booting ? "connecting…" : "say anything…"}
            aria-label="message"
            data-testid="chat-composer-textarea"
            aria-describedby={booting ? "cc-booting-hint" : undefined}
            aria-disabled={booting}
            readOnly={booting}
            className="min-w-0 flex-1 border-none bg-transparent text-sm text-white/[0.92] outline-none placeholder:text-white/45"
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
              />
            )}
          </motion.div>
        </div>
      </fieldset>
    </div>
  );
}
