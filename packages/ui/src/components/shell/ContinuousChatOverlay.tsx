import {
  Home,
  Maximize2,
  Mic,
  Minimize2,
  RotateCcw,
  SendHorizontal,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  AnimatePresence,
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from "motion/react";
import * as React from "react";

import type { ImageAttachment } from "../../api/client-types-chat";
import {
  parseSlashDraft,
  runSlashExecution,
  type SlashExecution,
} from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import {
  TUTORIAL_CHAT_CONTROL_EVENT,
  type TutorialChatControlDetail,
} from "../../events";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { useViewChatBinding } from "../../state/view-chat-binding";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  filesToImageAttachments,
  MAX_CHAT_IMAGES,
} from "../../utils/image-attachment";
import { ThinkingBlock } from "../chat/ThinkingBlock";
import { SlashCommandMenu, useSlashMenu } from "./SlashCommandMenu";
import type { ShellMessage } from "./shell-state";
import { type PullGestureBinding, usePullGesture } from "./use-pull-gesture";
import { usePromptSuggestions } from "./usePromptSuggestions";
import type { ShellController } from "./useShellController";

/** No-op slash controller so the overlay renders without a provider (stories). */
const EMPTY_SLASH_CONTROLLER: SlashCommandController = {
  commands: [],
  loading: false,
  resolveChoices: () => [],
  resolveSection: () => undefined,
  navigateTab: () => {},
  navigateSettings: () => {},
  navigateView: () => {},
  clearChat: () => {},
  openCommandPalette: () => {},
};

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
// HALF is a comfortable mid-stop; FULL fills all the way to panelMaxH (the sheet
// rises to just under the status bar) — you pull it back DOWN to dismiss.
/** The five explicit states of the floating chat surface. Derived from the
 * resting height + flags so it always matches what's rendered (see the
 * `chatState` derivation in the component). */
export type ChatState =
  | "CLOSED"
  | "INPUT"
  | "OPEN_UNDER_HALF"
  | "OPEN_HALF_OR_OVER"
  | "MAXIMIZED";

/** Push-to-talk lifecycle. idle → pending (timer armed) → holding (dictating) →
 *  idle. A release while still `pending` is a quick tap (no capture started). */
type PttPhase =
  | { kind: "idle" }
  | { kind: "pending"; pointerId: number; timer: number }
  | { kind: "holding"; pointerId: number };

const SHEET_HALF_VH = 0.46; // fraction of viewport height at the HALF detent
// px kept clear above the panel. Sized to clear an edge-to-edge status bar
// (~58px) plus a buffer so the grabber sits BELOW the notification-shade pull
// zone — the full sheet reaches the top without fighting the system gesture.
const SHEET_TOP_MARGIN = 72;
// Detent magnetism: on a deliberate (non-flick) drag release, a height within
// this many px of a detent (collapsed/half/full) snaps to that detent instead
// of resting free — so near-detent releases are deterministic + clean, and only
// the clear gaps between detents keep the free-drag rest height.
const SHEET_DETENT_MAGNET = 64;
// Cap how many turns are actually rendered. Older messages stay in state (the
// agent's context is untouched) — this only bounds DOM nodes so a long thread
// can't jank scrolling on a phone, without pulling in a virtualizer.
const MAX_RENDERED_MESSAGES = 80;

// Feature flag: the resting one-tap prompt-suggestion strip. Off for now so the
// composer can be tested without it; flip to true to bring the strip back.
const SHOW_PROMPT_SUGGESTIONS = false;

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
// Slightly springier preset for the pill→input "liquid glass" open: a touch
// less damping than the height spring so the input reads as springing IN on a
// flick, while the live drag-tracking gives a slow pull its "lerp" character.
const OPEN_SPRING = {
  type: "spring" as const,
  stiffness: 300,
  damping: 26,
  mass: 0.85,
};
// Finger travel (px) that fully opens the input from the pill. A live pill drag
// maps offset → openProgress ∈ [0,1] over this distance; past it, the excess
// flows into the thread height so pill → input → chat is one continuous motion.
const PILL_OPEN_DISTANCE = 120;
// Rubber-band resistance applied to drag past a detent (iOS-style overscroll).
function rubberBand(overshoot: number): number {
  return Math.sign(overshoot) * Math.sqrt(Math.abs(overshoot)) * 6;
}

// Glyphs (viewBox 0 0 36 36), rendered in currentColor inside a soft chip. Send
// + mic now use lucide icons (SendHorizontal / Mic); the rest stay hand-drawn.
const PLUS_GLYPH = "M16 8H20V16H28V20H20V28H16V20H8V16H16Z";
// Stop generating: a centered rounded square (the universal "stop" affordance).
const STOP_GLYPH = "M12 12H24V24H12Z";
// Muted-speaker glyph for the autoplay-blocked "tap to enable sound" prompt.
const SPEAKER_MUTED_GLYPH =
  "M7 15H12L18 10V26L12 21H7Z M21 12.4L22.4 11L31 19.6L29.6 21Z";
function Glyph({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 36 36" className="h-[26px] w-[26px]" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={d} />
    </svg>
  );
}

/** A soft round glass control that dissolves into the bar; brightens only when active. */
function SoftButton({
  glyph,
  icon: Icon,
  label,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  disabled,
  active,
  testId,
}: {
  /** A hand-drawn SVG path glyph (legacy), OR pass `icon` for a lucide icon. */
  glyph?: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
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
        // 44×44 hit target (WCAG 2.5.5) — comfortably thumb-tappable without
        // crowding the bar (split the difference back down from 48).
        "grid h-11 w-11 shrink-0 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        active
          ? "border-white/40 bg-white/85 text-black"
          : "border-white/15 bg-white/10 text-white/75 hover:bg-white/20 hover:text-white",
        disabled && "opacity-40",
      )}
    >
      {Icon ? (
        <Icon className="h-[22px] w-[22px]" aria-hidden={true} />
      ) : glyph ? (
        <Glyph d={glyph} />
      ) : null}
    </button>
  );
}

/** A compact glass control for the full-state header (maximize / clear /
 *  settings). Smaller than SoftButton; same neutral resting → neutral-hover
 *  language (no blue), `active` gets the white fill. Renders a lucide icon. */
function HeaderButton({
  icon: Icon,
  label,
  onClick,
  active,
  testId,
}: {
  icon: typeof Maximize2;
  label: string;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        active
          ? "border-white/40 bg-white/85 text-black"
          : "border-white/15 bg-white/10 text-white/75 hover:bg-white/20 hover:text-white",
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
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
  opacity,
  pilled,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  binding: PullGestureBinding;
  glow: boolean;
  // Crossfade opacity (driven by openProgress): 0 while the pill capsule owns the
  // handle, fading to 1 only AFTER the pill has fully faded out — so the grabber
  // bar and the (identical) pill bar are NEVER both visible (the "two pills" bug).
  opacity: MotionValue<number>;
  // Inert while pilled so the invisible grabber can't steal taps meant for the
  // pill capsule (or pass-through to the home screen) below it.
  pilled: boolean;
}): React.JSX.Element {
  return (
    <motion.button
      style={{ opacity, pointerEvents: pilled ? "none" : "auto" }}
      // Invisible + inert while pilled: the pill capsule below owns the drag, so
      // keep this out of the tab order and the a11y tree until it's the handle.
      tabIndex={pilled ? -1 : undefined}
      aria-hidden={pilled || undefined}
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
        "appearance-none border-0 bg-transparent text-left",
        // ABSOLUTELY positioned over the panel top (zero layout height — it
        // floats slightly on top of the input row, so collapsed height == the
        // input bar). The bar sits a touch lower; the BIG invisible `before` hit
        // zone reaches UP into the empty space above the panel (3× taller/wider
        // than the bar) so it's easy to grab without covering the edge buttons.
        // z-20 keeps it above the input row (z-10) so it always wins the drag.
        "absolute left-1/2 top-0.5 z-20 -translate-x-1/2 flex cursor-grab touch-none select-none items-center justify-center px-16 py-1 active:cursor-grabbing",
        // The hit zone reaches UP into the empty space above the panel (easy to
        // grab) and stops at the handle's own bottom — it never reaches the
        // vertically-centered textarea, so a tap on the composer lands natively
        // on the textarea and raises the keyboard (a programmatic focus from the
        // handle wouldn't). Pull gestures start from the bar / the upward zone.
        "before:absolute before:-inset-x-6 before:-top-16 before:bottom-0 before:content-['']",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:rounded-full",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // 30% wider bar (w-11 → w-14), a touch taller, brighter.
          "h-2.5 w-16 rounded-full transition-colors duration-300",
          glow ? "bg-[rgba(255,180,120,0.8)]" : "bg-white/45",
        )}
      />
    </motion.button>
  );
}

/**
 * The fully-collapsed PILL — the chat reduced to a small glass capsule at the
 * very bottom. Tap or flick/pull it up to bring the input back. Big invisible
 * hit area so it's easy to grab; the visible capsule stays small.
 */
function PillHandle({
  binding,
  onOpen,
  glow,
}: {
  binding: PullGestureBinding;
  onOpen: () => void;
  glow: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="chat-pill"
      aria-label="open chat"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
          e.preventDefault();
          onOpen();
        }
      }}
      {...binding}
      className={cn(
        // The bar hugs the BOTTOM (small pb) where the collapsed input sat — not
        // floating mid-air; the tall pt keeps a generous upward grab/flick zone.
        "pointer-events-auto flex cursor-grab touch-none select-none items-end justify-center px-16 pb-1.5 pt-10 active:cursor-grabbing",
        "focus-visible:rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // Identical to the SheetGrabber bar — the handle keeps the same white
          // shape + color whether the chat is open or fully collapsed to the pill.
          "h-2.5 w-16 rounded-full transition-colors duration-300",
          glow ? "bg-[rgba(255,180,120,0.8)]" : "bg-white/45",
        )}
      />
    </button>
  );
}

/** Three quiet, borderless dots that breathe while the assistant is replying. */
// Just the three breathing dots — rendered INSIDE a bubble (the in-flight
// assistant turn, so "thinking" is anchored where the reply will appear) or
// wrapped in its own bubble by TypingDots for the pre-placeholder gap.
function TypingDotsInner(): React.JSX.Element {
  return (
    <span
      className="flex gap-1.5 py-1"
      data-testid="typing-dots"
      role="status"
      aria-label="assistant is responding"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/70 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

function TypingDots({ reduce }: { reduce?: boolean }): React.JSX.Element {
  return (
    <motion.div
      className="mb-2.5 flex w-full justify-start"
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
        <TypingDotsInner />
      </div>
    </motion.div>
  );
}

/**
 * One turn of the transcript as a chat bubble — assistant on the left, user on
 * the right. Memoized so a live drag (which re-renders the overlay on every
 * pointer-move frame) doesn't re-render every message in a long thread.
 */
// Press-and-hold copy: a still hold this long fires; any finger travel past the
// move threshold first cancels it (so it yields to the thread's scroll).
const COPY_HOLD_MS = 420;
const COPY_MOVE_CANCEL_PX = 10;

const ThreadLine = React.memo(function ThreadLine({
  message,
  floating,
  reduce,
  onCopy,
  onOpenSettings,
}: {
  message: ShellMessage;
  floating?: boolean;
  reduce?: boolean;
  /** Copy this message's text (assistant bubbles only). Stable identity. */
  onCopy?: (text: string) => void;
  /** Jump to Settings from the no_provider gate. Stable identity. */
  onOpenSettings?: () => void;
}): React.JSX.Element {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  // Press-and-hold to copy an assistant answer — the only extraction affordance
  // on touch (no hover row). A still hold past COPY_HOLD_MS copies + flashes
  // "Copied" + a light haptic; real finger travel cancels so it never fights the
  // thread's touch-pan-y scroll.
  const [copied, setCopied] = React.useState(false);
  const holdTimer = React.useRef<number | null>(null);
  const holdStart = React.useRef<{ x: number; y: number } | null>(null);
  const copiedTimer = React.useRef<number | null>(null);
  const clearHold = React.useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    holdStart.current = null;
  }, []);
  React.useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
      if (copiedTimer.current !== null)
        window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const canCopy = isAssistant && !!onCopy && message.content.trim().length > 0;
  const copyHandlers = canCopy
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          holdStart.current = { x: e.clientX, y: e.clientY };
          holdTimer.current = window.setTimeout(() => {
            onCopy?.(message.content);
            detentHaptic();
            setCopied(true);
            if (copiedTimer.current !== null)
              window.clearTimeout(copiedTimer.current);
            copiedTimer.current = window.setTimeout(
              () => setCopied(false),
              1100,
            );
            holdTimer.current = null;
          }, COPY_HOLD_MS);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const s = holdStart.current;
          if (!s) return;
          if (
            Math.abs(e.clientX - s.x) > COPY_MOVE_CANCEL_PX ||
            Math.abs(e.clientY - s.y) > COPY_MOVE_CANCEL_PX
          )
            clearHold();
        },
        onPointerUp: clearHold,
        onPointerCancel: clearHold,
      }
    : null;

  // A failed turn the user can't recover from without wiring a provider: render
  // a structured gate (not the raw error text) with a one-tap jump to Settings.
  if (isAssistant && message.failureKind === "no_provider") {
    return (
      <motion.div
        data-testid="thread-line"
        data-role={message.role}
        data-failure="no_provider"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={{ duration: reduce ? 0.15 : 0.52, ease: OVERLAY_EASE }}
        className={cn(
          "flex w-full justify-start",
          floating ? "mb-1.5" : "mb-2.5",
        )}
      >
        <div
          className={cn(
            "max-w-[85%] rounded-2xl rounded-bl-md border border-amber-300/30 bg-black/60 px-3.5 py-3 text-white",
            FLOAT_SHADOW,
          )}
        >
          <div className="mb-1 text-[14px] font-medium">
            Connect a provider to chat
          </div>
          <div className="mb-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-white/80 [overflow-wrap:anywhere]">
            {message.content}
          </div>
          <button
            type="button"
            data-testid="chat-no-provider-settings"
            onClick={() => onOpenSettings?.()}
            className="rounded-full border border-white/20 bg-white/15 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            Open Settings
          </button>
        </div>
      </motion.div>
    );
  }

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
        {...(copyHandlers ?? {})}
        className={cn(
          // whitespace-pre-wrap keeps newlines; overflow-wrap breaks long URLs /
          // hashes / paths so they can't blow out the bubble width on a phone.
          "relative max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed [overflow-wrap:anywhere]",
          // The chrome-free transcript renders floating: each bubble carries its
          // own dark glass so it stays legible directly over whatever view is
          // behind. The light tone is for any embedding that supplies its own
          // surrounding scrim.
          isUser ? "rounded-br-md" : "rounded-bl-md",
          // Assistant bubbles own the press-and-hold copy gesture, so suppress
          // the native long-press selection/callout that would fight it.
          canCopy && "select-none [-webkit-touch-callout:none]",
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
        {isAssistant && !message.content.trim() ? (
          // The in-flight assistant turn (kept by visibleMessages only while
          // responding): breathe the dots INSIDE the bubble so they're anchored
          // where the streamed text fills in — then the text replaces them.
          <TypingDotsInner />
        ) : (
          message.content
        )}
        {isAssistant && message.reasoning?.trim() ? (
          <ThinkingBlock reasoning={message.reasoning} />
        ) : null}
        <AnimatePresence>
          {copied ? (
            <motion.span
              key="copied"
              data-testid="thread-line-copied"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-none absolute -top-2 right-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-black shadow"
            >
              Copied
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
});

export function ContinuousChatOverlay({
  controller,
  agentName = "Eliza",
  slash: slashProp,
}: {
  controller: ShellController;
  /** Name shown in the composer placeholder ("Ask {agentName}"). Defaults to Eliza. */
  agentName?: string;
  /** Universal slash-command catalog + app-level nav effects. */
  slash?: SlashCommandController;
}): React.JSX.Element {
  const {
    messages,
    phase,
    responding,
    send,
    canSend,
    recording,
    startRecording,
    stopRecording,
    handsFree,
    toggleHandsFree,
    setDictationSink,
    setComposerHasDraft,
    transcript,
    needsAudioUnlock,
    unlockAudio,
    openSettings,
    navigateHome,
    currentTab,
    clearConversation,
    stop,
  } = controller;

  // Copy an assistant answer (press-and-hold on its bubble). Stable identity so
  // the memoized ThreadLine isn't re-rendered every parent tick.
  const handleCopyMessage = React.useCallback((text: string) => {
    void copyTextToClipboard(text);
  }, []);

  const slash = slashProp ?? EMPTY_SLASH_CONTROLLER;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  const [draft, setDraft] = React.useState("");
  // The active view can take over the composer: override the placeholder and
  // receive the live draft (e.g. Help uses the chat as its search box).
  const viewChatBinding = useViewChatBinding();
  // Escape dismisses the slash menu without clearing the draft; typing reopens.
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  // The chat-history sheet: closed (a slim peek + grabber) ↔ open (full
  // scrollable history). The ONLY open/close driver — opened by a pull-up drag,
  // by focusing the composer, or by sending; closed by a pull-down drag or
  // Escape. Never by click-out, scroll, or blur.
  // The sheet's vertical position is ONE ordinal — the single source of truth for
  // how far the chat is open: `input` (composer-only peek) → `half` (reading
  // height) → `full` (near-fullscreen). `sheetOpen`/`expanded` are derived
  // read-only views so the two can never disagree (no impossible "open but not
  // open" combos). `pilled` sits BELOW input; `maximized` drops the inset at full.
  // Grabber pulls step through the detents (each cross haptics); programmatic
  // opens (send/focus) go full.
  const [detent, setDetent] = React.useState<"input" | "half" | "full">(
    "input",
  );
  const sheetOpen = detent !== "input";
  const expanded = detent === "full";
  // PILL is the detent BELOW input: the whole chat collapses to a small pill at
  // the bottom (input hidden) so it can get out of the way entirely, yet stays
  // one flick away. Pull down from input → pill; flick/pull up from pill → input
  // → chat. `pilled` overrides sheetOpen/expanded while true.
  const [pilled, setPilled] = React.useState(false);
  // Free-drag rest height (px): when set, the sheet rests exactly where the user
  // released a deliberate drag instead of snapping to a detent. Cleared whenever
  // a detent is taken (tap/flick/focus/collapse) so the detents stay the
  // snap-to targets and free-positioning is purely the drag affordance.
  const [freeH, setFreeH] = React.useState<number | null>(null);
  // FULL-SCREEN (maximized): at the FULL detent the user can drop the inset
  // (max-width, side padding, top margin, rounding) so the chat is edge-to-edge.
  // Invariant: only true while at FULL (sheetOpen && expanded && !pilled); every
  // leave-full transition resets it.
  const [maximized, setMaximized] = React.useState(false);
  // Whether the sheet was collapsed when the composer last gained focus — so
  // dismissing the keyboard (tap the handle) returns to the prior resting state
  // (collapsed) instead of leaving the sheet hanging open.
  const preFocusCollapsedRef = React.useRef(true);
  // Composer focus ⟺ the soft keyboard is up on mobile. This is the reliable
  // keyboard signal: Capacitor's resize:"body" shrinks innerHeight too, so a
  // visualViewport-derived keyboardInset reads 0 and can't gate the layout.
  const [composerFocused, setComposerFocused] = React.useState(false);
  // The live thread (history) height in px, as a MOTION VALUE — driven directly
  // by the pointer during a drag and spring-animated to a detent on release.
  // Keeping it off React state means a drag updates the DOM height every frame
  // with NO component re-render, so the gesture stays buttery. `draggingRef`
  // gates the settle effect so it doesn't fight an in-flight finger drag.
  const threadHeight = useMotionValue(0);
  // Pill → input morph progress (0 = pill capsule, 1 = full input bar), OFF React
  // state like threadHeight so a pill drag morphs the glass at 60fps with no
  // re-render. Drives the glass/content crossfade + scale; `threadHeight` stays
  // 0 until the input is fully formed, then takes over for input → chat.
  const openProgress = useMotionValue(pilled ? 0 : 1);
  // Latest `settleDrag` (defined below) exposed to the viewport-resize effect
  // (which runs earlier). A rotation can orphan an in-flight drag — re-settling
  // the morph keeps the pill↔input crossfade from stranding both bars visible.
  const settleDragRef = React.useRef<(() => void) | null>(null);
  const draggingRef = React.useRef(false);
  // Push-to-talk phase (single source of truth) + a label-only mirror.
  const pttRef = React.useRef<PttPhase>({ kind: "idle" });
  const [pttHolding, setPttHolding] = React.useState(false);
  // Swallow exactly the one click that follows a held PTT release.
  const suppressNextClickRef = React.useRef(false);
  const [pendingImages, setPendingImages] = React.useState<ImageAttachment[]>(
    [],
  );
  const [imageError, setImageError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLFieldSetElement>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const focusThreadRef = React.useRef(false);
  // Recomputed only when the thread changes — NOT on every drag/draft re-render.
  // Filter empty turns, then keep only the most recent window (cap DOM nodes).
  const visibleMessages = React.useMemo(
    () =>
      messages
        // Drop empty turns — EXCEPT the in-flight assistant turn while a reply is
        // streaming, so its bubble can show the breathing dots anchored where the
        // text fills in (then the text replaces them). It's dropped again the
        // moment we leave `responding`, so a failed/empty turn never lingers.
        .filter(
          (m) =>
            m.content.trim() ||
            (m.role === "assistant" && phase === "responding"),
        )
        .slice(-MAX_RENDERED_MESSAGES),
    [messages, phase],
  );
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  // The last line id the scroll effect pinned to — lets it tell a NEW line
  // (always pin to bottom) from streaming growth of the current line (follow
  // only when the reader is already at the bottom).
  const scrollPinnedIdRef = React.useRef(lastId);

  const booting = phase === "booting";
  const listening = phase === "listening";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;

  // The suggestion strip is a keyboard-style row of one-tap prompts shown in the
  // RESTING (closed) state — ready, nothing typed or attached, not recording. It
  // unmounts once the sheet opens or a draft starts; this condition also gates
  // the small-model fetch so it isn't called for a hidden strip.
  const suggestionsVisible =
    SHOW_PROMPT_SUGGESTIONS &&
    !pilled &&
    !sheetOpen &&
    !recording &&
    !booting &&
    canSend &&
    !hasDraft &&
    !hasImages;

  // Three tailored prompt suggestions for the resting overlay (model-backed via
  // TEXT_SMALL, with a static offline fallback).
  const suggestions = usePromptSuggestions(messages, {
    enabled: suggestionsVisible,
  });

  // Defensive unmount: clear a pending timer and stop a stuck dictation capture
  // if the overlay unmounts mid-press (the controller outlives the overlay).
  // biome-ignore lint/correctness/useExhaustiveDependencies: stopRecording is stable; this runs once on unmount
  React.useEffect(
    () => () => {
      const phase = pttRef.current;
      if (phase.kind === "pending") window.clearTimeout(phase.timer);
      if (phase.kind === "holding") stopRecording();
      pttRef.current = { kind: "idle" };
      suppressNextClickRef.current = false;
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

  // Send `text` (and optional images) through the normal chat pipeline, clearing
  // the composer. Shared by the send button, the slash menu (agent commands),
  // and suggestion taps.
  const submitText = React.useCallback(
    (text: string, images: ImageAttachment[] = []) => {
      const trimmed = text.trim();
      // An image-only turn is valid; only bail when there's nothing to send.
      if ((!trimmed && images.length === 0) || !canSend) return;
      setDraft("");
      setSlashDismissed(false);
      setPendingImages([]);
      setImageError(null);
      if (images.length) {
        send(trimmed, { images });
      } else {
        send(trimmed);
      }
      // Programmatic open → FULL detent (see the reply). Clear any free-rest so
      // the height can't stay pinned below full.
      setFreeH(null);
      setDetent("full");
      detentHaptic();
      inputRef.current?.focus();
    },
    [canSend, send],
  );

  const submit = React.useCallback(() => {
    submitText(draft, pendingImages);
  }, [submitText, draft, pendingImages]);

  // Tapping a suggestion sends it immediately (same path as submit), so the
  // strip is a one-tap shortcut, not just a draft pre-fill.
  const pickSuggestion = React.useCallback(
    (text: string) => {
      if (!canSend) return;
      setDraft("");
      send(text);
      setFreeH(null);
      setDetent("full");
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

  // ── Push-to-talk state machine ──────────────────────────────────────────────
  // ONE phase ref is the source of truth: idle → (press) pending → (200ms hold)
  // holding → (release) idle. `pttHolding` mirrors only what the label needs.
  // A quick tap releases while still "pending" (never started a capture) and
  // falls through to handleMicClick → toggleHandsFree. A held release stops the
  // dictation and suppresses the trailing click so it doesn't ALSO toggle.
  const beginPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // Only arm from idle, primary button, no draft, and no capture already
      // live (a tap while hands-free toggles it off — handleMicClick). No
      // `booting` guard: voice capture is independent of agent-respond readiness.
      if (
        pttRef.current.kind !== "idle" ||
        event.button !== 0 ||
        hasDraft ||
        recording ||
        // Voice input is gated while a reply is in flight; type + send to queue
        // another turn instead. Re-enabled the instant the reply finishes.
        responding
      )
        return;
      const { pointerId } = event;
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // Synthetic/detached pointer — capture is best-effort.
      }
      const timer = window.setTimeout(() => {
        // Promote to holding only if still pending for THIS pointer.
        const phase = pttRef.current;
        if (phase.kind !== "pending" || phase.pointerId !== pointerId) return;
        pttRef.current = { kind: "holding", pointerId };
        setPttHolding(true);
        // Press-and-hold = dictation: fills the composer draft (no send).
        startRecording("dictate");
      }, 200);
      pttRef.current = { kind: "pending", pointerId, timer };
    },
    [hasDraft, recording, responding, startRecording],
  );

  // One funnel for BOTH pointerup (cancelled=false) and pointercancel
  // (cancelled=true). Always clears the pending timer + releases pointer capture
  // FIRST — before any early return — so a quick tap can never leak a stuck timer
  // or a captured pointer (the bug that mis-routed later events).
  const finishPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
      const phase = pttRef.current;
      if (phase.kind === "pending") window.clearTimeout(phase.timer);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      pttRef.current = { kind: "idle" };
      if (phase.kind === "holding") {
        stopRecording();
        setPttHolding(false);
        // A real click follows a pointer-UP (never a cancel); suppress it so the
        // dictation release doesn't also toggle hands-free. Setting it ONLY here
        // means it can never leak true into the next legitimate tap.
        if (!cancelled) suppressNextClickRef.current = true;
      }
    },
    [stopRecording],
  );

  const handleMicClick = React.useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // Voice can't be turned ON while a reply is in flight (it's gated until the
    // turn finishes), but an active hands-free session can always be turned OFF.
    if (responding && !handsFree) return;
    // Quick tap = hands-free conversation: the agent speaks its replies back and
    // the mic re-opens after each one. Tap again to end.
    toggleHandsFree();
  }, [responding, handsFree, toggleHandsFree]);

  const hasThread = visibleMessages.length > 0;

  // Track the VISUAL viewport so the chat sizes to — and sits above — whatever
  // the mobile keyboard leaves visible. `height` shrinks when the keyboard opens
  // (on iOS innerHeight does not, so read visualViewport); `keyboardInset` is how
  // far the keyboard intrudes from the layout bottom, used to lift the whole
  // overlay above it. `bottomPad` is the overlay's own safe-area/nav padding,
  // reserved when bounding the panel height.
  const readViewport = React.useCallback(() => {
    if (typeof window === "undefined") return { height: 800, keyboardInset: 0 };
    const vv = window.visualViewport;
    const height = vv?.height ?? window.innerHeight;
    const keyboardInset = vv
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0;
    return { height, keyboardInset };
  }, []);
  const [viewport, setViewport] = React.useState(readViewport);
  const [bottomPad, setBottomPad] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => {
      setViewport(readViewport());
      const el = overlayRef.current;
      if (el) {
        setBottomPad(
          Number.parseFloat(getComputedStyle(el).paddingBottom) || 0,
        );
      }
    };
    // A viewport SIZE change (rotation) must never strand the pill↔input morph
    // mid-crossfade — rotation often cancels the in-flight pointer with no
    // pointerup, leaving the drag orphaned (openProgress frozen mid-range = BOTH
    // the grabber bar and the pill bar visible). Re-settle to a clean 0/1 end so
    // the crossfade always resolves to exactly one bar. (No-op at rest; a live
    // legit drag rotating is rare and settling is the right call there too.)
    // Plain `sync` (no settle) stays on vv `scroll` — that fires constantly while
    // the keyboard animates and must not interrupt an open sheet.
    const syncAndSettle = () => {
      sync();
      settleDragRef.current?.();
    };
    syncAndSettle();
    const vv = window.visualViewport;
    window.addEventListener("resize", syncAndSettle);
    vv?.addEventListener("resize", syncAndSettle);
    vv?.addEventListener("scroll", sync);
    return () => {
      window.removeEventListener("resize", syncAndSettle);
      vv?.removeEventListener("resize", syncAndSettle);
      vv?.removeEventListener("scroll", sync);
    };
  }, [readViewport]);
  const viewportH = viewport.height;
  const keyboardInset = viewport.keyboardInset;

  // FULL-SCREEN derived gate: maximized only takes effect AT the full detent, so
  // a stale flag can never leak into half/collapsed/pill. Drives the edge-to-edge
  // panel styles + a zero top margin.
  const fullBleed = maximized && expanded && sheetOpen && !pilled;

  // The chat panel may never exceed the visible height minus its own
  // safe-area/nav padding and a top margin — so it can't spill above the screen.
  // The thread (flex-shrink) gives way to this cap, scrolling instead of pushing
  // the panel off-screen. Maximized drops the top margin so it reaches the top.
  const topMargin = fullBleed ? 0 : SHEET_TOP_MARGIN;
  const panelMaxH = Math.max(200, viewportH - bottomPad - topMargin);

  // History-height detents: COLLAPSED (0) → HALF → FULL — the thread's ideal
  // flex-basis; flex-shrink clamps the real height to fit. FULL == panelMaxH so
  // the detent target matches the visible height (no dead slack at the top of a
  // pull-down) while the sheet rises all the way to the top.
  const openH = panelMaxH;
  const halfH = Math.round(viewportH * SHEET_HALF_VH);
  const detentH = !sheetOpen ? 0 : expanded ? openH : halfH;
  // A free-drag rest height wins over the detent until a detent is re-taken.
  const baseH = freeH != null ? Math.min(freeH, panelMaxH) : detentH;

  // The single explicit state of the chat surface — the named machine the rest
  // of the component (header gate, data attribute, transitions) reads from. It
  // is DERIVED from the resting height so it always agrees with what's on
  // screen; the live drag stays on the `threadHeight` motion value (no
  // re-render per frame). The five states:
  //   CLOSED            — pill only (sheet pilled away)
  //   INPUT             — composer bar, no thread (the resting closed state)
  //   OPEN_UNDER_HALF   — opened but below the half detent (a deliberate slow
  //                       pull rested here); header buttons stay hidden
  //   OPEN_HALF_OR_OVER — at the half detent or taller (header buttons show)
  //   MAXIMIZED         — full-bleed edge-to-edge
  // Transitions: pill tap / flick-up → INPUT; focus·type·flick·send → an OPEN_*
  // state; pull-down → INPUT → CLOSED; maximize toggle ↔ MAXIMIZED; Home/Settings
  // animate out of MAXIMIZED then collapse (see navigateAndClose).
  // MAXIMIZED is keyed off the SAME `fullBleed` predicate the styles use, so the
  // enum and the full-bleed layout can never disagree (no "maximized at half"
  // ghost state).
  const chatState: ChatState = pilled
    ? "CLOSED"
    : !sheetOpen
      ? "INPUT"
      : fullBleed
        ? "MAXIMIZED"
        : baseH >= halfH - 1
          ? "OPEN_HALF_OR_OVER"
          : "OPEN_UNDER_HALF";
  // Header buttons (maximize/clear/home/settings) are gated on the LIVE rendered
  // height, NOT the settled enum — otherwise dragging the panel below half keeps
  // the header mounted on a too-short panel (the "buttons between input and half"
  // bug). They show only when the panel actually renders at/over half (or is
  // full-bleed), tracking the finger frame-by-frame; the prev===next guard keeps
  // re-renders to the two threshold crossings.
  const evalHeaderVisible = React.useCallback(
    (h: number) => !pilled && (fullBleed || h >= halfH - 1),
    [pilled, fullBleed, halfH],
  );
  const [headerVisible, setHeaderVisible] = React.useState(false);
  useMotionValueEvent(threadHeight, "change", (h) => {
    const next = evalHeaderVisible(h);
    setHeaderVisible((prev) => (prev === next ? prev : next));
  });
  // Re-evaluate on settled-state changes that don't tick the height (programmatic
  // pill/maximize/open with the spring already at rest).
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadHeight is a stable motion ref
  React.useEffect(() => {
    setHeaderVisible(evalHeaderVisible(threadHeight.get()));
  }, [evalHeaderVisible]);
  // Map a raw drag height: rubber-band past FULL, hard-clamp the bottom to 0.
  const clampHeight = React.useCallback(
    (raw: number) =>
      raw > openH ? openH + rubberBand(raw - openH) : Math.max(0, raw),
    [openH],
  );
  // Backdrop dimming + the suggestion-strip fade follow the live height; the
  // thread's flex-basis is the live height as a px string.
  const revealed = useTransform(threadHeight, (h) =>
    Math.min(1, Math.max(0, h / Math.max(1, openH))),
  );
  const suggestionsOpacity = useTransform(threadHeight, (h) =>
    Math.max(0, 1 - h / Math.max(1, openH * 0.5)),
  );
  const threadFlexBasis = useTransform(threadHeight, (h) => `${h}px`);
  // Corner radius tracks the live height so it can't flash as a tall full-pill
  // mid-pull: a perfect pill at rest (collapsed input, matching the round
  // buttons) relaxing to a calm 24px the instant the thread starts opening.
  const panelRadius = useTransform(threadHeight, [0, 12], [9999, 24], {
    clamp: true,
  });
  // --- Liquid-glass pill → input morph (driven by openProgress) ---------------
  // The panel is ONE persistent element; the pill capsule and the full glass
  // input crossfade by opacity (compositor-cheap — never tween backdrop-blur)
  // while the whole panel scales up from a capsule. transform + opacity only.
  const panelScale = useTransform(openProgress, [0, 1], [0.9, 1]);
  // Glass surface + its content crossfade IN as the input forms (one wrapper, so
  // sheen/glow/thread/composer resolve together with the glass).
  const glassOpacity = useTransform(openProgress, [0, 1], [0, 1]);
  // The pill capsule fades OUT over the first half of the open so it has cleared
  // before the input controls resolve (no double-image mid-morph).
  const pillOpacity = useTransform(openProgress, [0, 0.55], [1, 0], {
    clamp: true,
  });
  // The drag-handle (SheetGrabber) bar is IDENTICAL to the pill bar, so they must
  // never both be on screen. The pill fades OUT over [0, 0.55]; the grabber fades
  // IN only over [0.55, 0.95] — a strict crossfade with no overlap. (Before, the
  // grabber mounted at full opacity the instant `pilled` flipped false, while the
  // pill was still fading out → two bars = the "two pills" bug.)
  const grabberOpacity = useTransform(openProgress, [0.55, 0.95], [0, 1], {
    clamp: true,
  });
  // Header reveal tracks the LIVE height: as the panel approaches the half
  // detent the top buttons FADE in and their space LERPS open; pulling back
  // below half fades them out and collapses the space — no pop. (Maximized sits
  // at openH ≫ half, so it's fully revealed.) overflow-hidden on the header clips
  // the buttons while the space is still opening.
  const headerOpacity = useTransform(
    threadHeight,
    [halfH - 64, halfH],
    [0, 1],
    {
      clamp: true,
    },
  );
  const headerMaxH = useTransform(threadHeight, [halfH - 64, halfH], [0, 100], {
    clamp: true,
  });
  // The header's top padding LERPS with the same live height. A flex item's
  // `min-height:auto` lets its padding survive `max-height:0`, so a static
  // `pt-2.5` would leak ~10px above the composer in the collapsed/input state
  // (extra, irregular top margin). Driving padding-top 0 → 10px alongside the
  // reveal keeps the collapsed panel exactly the input-bar height, then opens
  // the breathing room as the header fades in.
  const headerPadTop = useTransform(
    threadHeight,
    [halfH - 64, halfH],
    [0, 10],
    {
      clamp: true,
    },
  );

  // Sub-threshold release: spring back to the current detent (no state change).
  // Also settles the pill→input morph to its resting end (0 while pilled, 1 once
  // open) so a half-finished pill drag springs cleanly back to the capsule.
  const settleDrag = React.useCallback(() => {
    draggingRef.current = false;
    const open = pilled ? 0 : 1;
    if (reduce) {
      threadHeight.set(baseH);
      openProgress.set(open);
    } else {
      animate(threadHeight, baseH, SHEET_SPRING);
      animate(openProgress, open, OPEN_SPRING);
    }
  }, [threadHeight, openProgress, baseH, pilled, reduce]);
  // Keep the ref the (earlier-declared) viewport-resize effect calls pointing at
  // the latest settleDrag, so a rotation re-settles with current pilled/baseH.
  settleDragRef.current = settleDrag;

  // Drive openProgress from the pilled flag for NON-drag transitions (tap the
  // pill, programmatic open/close): a live finger drag owns openProgress itself
  // (draggingRef gates this so it never fights the gesture).
  // biome-ignore lint/correctness/useExhaustiveDependencies: openProgress is a stable motion value ref
  React.useEffect(() => {
    if (draggingRef.current) return;
    const open = pilled ? 0 : 1;
    if (reduce) {
      openProgress.set(open);
      return;
    }
    const controls = animate(openProgress, open, OPEN_SPRING);
    return () => controls.stop();
  }, [pilled, reduce]);

  const closeSheet = React.useCallback(() => {
    draggingRef.current = false;
    setFreeH(null);
    setMaximized(false);
    setDetent("input");
  }, []);

  // Leaving the chat for Settings/Home: animate OUT of maximize and collapse the
  // sheet (closeSheet un-maximizes + springs the thread height down) BEFORE
  // swapping the page underneath, so it reads as the chat closing into the new
  // view rather than a jump-cut from full-screen. The page swap waits a beat for
  // the collapse spring to start (a touch longer when leaving MAXIMIZED, since
  // there's more to unwind); reduced motion navigates immediately.
  const navigateAndClose = React.useCallback(
    (go: () => void) => {
      const wasMaximized = maximized;
      closeSheet();
      window.setTimeout(go, reduce ? 0 : wasMaximized ? 260 : 190);
    },
    [closeSheet, maximized, reduce],
  );

  // Maximize toggle. Maximizing from ANY open detent (half or a free rest) first
  // rises to the FULL detent, then drops the inset — so the height spring
  // animates up and the panel goes edge-to-edge in one gesture (previously
  // full-bleed required `expanded`, so tapping maximize at the half detent did
  // nothing). Un-maximizing drops back to the inset FULL detent.
  const toggleMaximize = React.useCallback(() => {
    if (maximized) {
      setMaximized(false);
      return;
    }
    // Snap the morph fully open BEFORE flipping to full-bleed so no in-flight
    // pill-open spring can leak a sub-1 scale into the maximized frame (top gap).
    draggingRef.current = false;
    openProgress.set(1);
    setFreeH(null);
    setDetent("full");
    setMaximized(true);
  }, [maximized, openProgress]);

  // The single detent→detent animator: whenever the settled detent (or viewport)
  // changes and we're not mid finger-drag, spring the history height to it. The
  // gesture / open paths just flip sheetOpen/expanded and this reacts — no
  // per-frame React state, so the live drag stays buttery.
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseH already encodes sheetOpen/expanded/freeH/viewportH; threadHeight is a stable ref
  React.useEffect(() => {
    if (draggingRef.current) return;
    if (reduce) {
      threadHeight.set(baseH);
      return;
    }
    const controls = animate(threadHeight, baseH, SHEET_SPRING);
    return () => controls.stop();
  }, [baseH, reduce]);

  // Snap to one of the three iOS-style detents and settle the live drag. A
  // detent change fires a light haptic so the snap feels physical on device.
  // "collapsed" hides the history entirely (just the input); "half" is the
  // comfortable reading height; "full" the near-fullscreen reading mode.
  const goToDetent = React.useCallback((to: "collapsed" | "half" | "full") => {
    // Flip the settled detent; the [baseH] effect springs the height to it.
    // A detent always clears any free-drag rest height and (since only FULL
    // can be maximized) drops full-bleed when stepping anywhere else.
    draggingRef.current = false;
    setFreeH(null);
    if (to !== "full") setMaximized(false);
    // "collapsed" is the input peek (sheet closed); half/full open the thread.
    setDetent(to === "collapsed" ? "input" : to);
    // Stepping all the way down closes the keyboard (the chat is dismissed).
    if (to === "collapsed") inputRef.current?.blur();
    detentHaptic();
  }, []);

  // Collapsing always drops input focus, so the mobile keyboard goes away the
  // moment the chat is dismissed (pull-down, Escape, or click-out) — the chat is
  // no longer "focused". Blurring (rather than the old refocus dance) also means
  // there's no focus→expand bounce to guard against, so the model stays simple.
  const collapse = React.useCallback(() => {
    // If focus is sitting inside the thread log, pull it out before the log
    // becomes aria-hidden / tabIndex=-1 — never park focus on a hidden element.
    if (
      typeof document !== "undefined" &&
      threadRef.current &&
      document.activeElement instanceof HTMLElement &&
      threadRef.current.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    closeSheet();
    inputRef.current?.blur();
  }, [closeSheet]);

  // Focusing or typing in the composer opens the chat (keyboard + history) when
  // there's a thread to show. Opens to HALF — the conversation is visible above
  // the keyboard without a full-screen takeover; the maximize button is for that.
  // Remember whether we opened from collapsed so dismissing the keyboard (tap the
  // handle) can return to that prior resting state. Clears any free-rest so the
  // height matches the detent (no stale freeH pinning it below half).
  const expand = React.useCallback(() => {
    if (!hasThread) return;
    preFocusCollapsedRef.current = !sheetOpen;
    setFreeH(null);
    // Open to at least HALF; if already at half/full, keep the taller detent.
    setDetent((d) => (d === "input" ? "half" : d));
  }, [hasThread, sheetOpen]);

  // Interactive tour control: the tutorial drives the chat into a clean, known
  // state at the start of each frame (so the spotlight always lands on the right
  // control) and pre-fills the composer for the guided "ask to navigate" demo.
  // Decoupled via a window event so the tour never reaches into these internals.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<TutorialChatControlDetail>).detail;
      if (!detail) return;
      switch (detail.action) {
        case "pill":
          closeSheet();
          setPilled(true);
          inputRef.current?.blur();
          break;
        case "rest":
          setPilled(false);
          goToDetent("collapsed");
          break;
        case "expand":
          setPilled(false);
          goToDetent("full");
          break;
        case "prefill":
          setPilled(false);
          setDraft(detail.text ?? "");
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
      }
    };
    window.addEventListener(TUTORIAL_CHAT_CONTROL_EVENT, onControl);
    return () =>
      window.removeEventListener(TUTORIAL_CHAT_CONTROL_EVENT, onControl);
  }, [closeSheet, goToDetent]);

  // Push-to-talk dictation drops its final transcript into the composer draft
  // (no send): register the sink with the controller while this overlay is
  // mounted, appending to whatever the user has already typed.
  React.useEffect(() => {
    setDictationSink((text) => {
      setDraft((current) => (current ? `${current} ${text}` : text));
      inputRef.current?.focus();
      expand();
    });
    return () => setDictationSink(null);
  }, [setDictationSink, expand]);

  // Tell the controller whether a draft is pending so the hands-free always-on
  // loop pauses while the user is typing (or editing a PTT dictation) and
  // resumes the prior voice state once the draft clears on send.
  React.useEffect(() => {
    setComposerHasDraft(hasDraft);
  }, [hasDraft, setComposerHasDraft]);

  // ── Slash commands ─────────────────────────────────────────────────────────
  // Inline command autocomplete: the menu derives from the draft + the loaded
  // catalog; Escape dismisses it (without clearing the draft); typing reopens.
  const slashMenu = useSlashMenu(draft, slash);
  // Short-circuit the slash parse on the common (non-slash) keystroke path — a
  // draft that doesn't start with "/" is never a slash command, so skip the work.
  const isSlashDraft = draft.startsWith("/") && parseSlashDraft(draft).isSlash;
  const slashOpen = slashMenu.open && !slashDismissed;
  // Combobox a11y for the composer input — only when a slash catalog is wired
  // in. Spread so the input is a plain message box (no role) otherwise.
  const comboboxAria: React.AriaAttributes & { role?: "combobox" } = slashProp
    ? {
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": slashOpen,
        "aria-controls": slashOpen ? "slash-command-listbox" : undefined,
        "aria-activedescendant":
          slashOpen && slashMenu.items[slashMenu.activeIndex]
            ? `slash-option-${slashMenu.items[slashMenu.activeIndex].id}`
            : undefined,
      }
    : {};

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft IS the trigger — any edit re-arms the menu after an Escape dismissal.
  React.useEffect(() => {
    setSlashDismissed(false);
  }, [draft]);

  // Run a resolved slash execution: agent commands flow through the normal send
  // pipeline; navigation/client commands run their app- or overlay-level effect
  // and clear the composer.
  const runExecution = React.useCallback(
    (exec: SlashExecution) => {
      if (exec.kind === "send") {
        submitText(exec.text);
        return;
      }
      runSlashExecution(exec, {
        navigateTab: slash.navigateTab,
        navigateSettings: slash.navigateSettings,
        navigateView: slash.navigateView,
        clearChat: slash.clearChat,
        newConversation: () => controller.clearConversation(),
        // The overlay owns full-screen via the `maximized` detent flag, not a
        // controller method, so toggle it directly here.
        toggleFullscreen: toggleMaximize,
        openCommandPalette: slash.openCommandPalette,
        showCommands: slash.openCommandPalette,
        send: (text) => submitText(text),
      });
      setDraft("");
      setSlashDismissed(true);
      inputRef.current?.focus();
    },
    [slash, controller, submitText, toggleMaximize],
  );

  const pickSlashItem = React.useCallback(
    (index: number) => {
      const exec = slashMenu.resolve(index);
      if (exec) runExecution(exec);
    },
    [slashMenu, runExecution],
  );

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
      // Leave a tap on the GRABBER to onTap, which both drops the keyboard AND
      // returns to the pre-focus resting state — blurring here would preempt it.
      if (
        target instanceof Element &&
        target.closest('[data-testid="chat-sheet-grabber"]')
      ) {
        return;
      }
      input.blur();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Escape collapses the chat from ANY open state, even a free-drag open with no
  // focused element (the element-level handlers on the textarea/thread only fire
  // when one of them holds focus). Registered only while open.
  React.useEffect(() => {
    if (typeof document === "undefined" || !sheetOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen, collapse]);

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

  // Open the input back out of the collapsed pill (tap or keyboard-activate).
  // A tap routes through the gesture's `onDrag(0)` first, which sets
  // draggingRef=true AND openProgress=0 — so we MUST clear draggingRef here, or
  // the pilled→openProgress effect early-returns and the morph stays stuck at 0
  // (a visible-but-inert pill, no input: the "bad state"). We also spring
  // openProgress → 1 directly so the open never depends on that effect's timing.
  const openFromPill = React.useCallback(() => {
    draggingRef.current = false;
    setPilled(false);
    if (reduce) openProgress.set(1);
    else animate(openProgress, 1, OPEN_SPRING);
    detentHaptic();
  }, [openProgress, reduce]);

  // --- Pull gesture --------------------------------------------------------
  // The grabber is the draggable handle. A live drag sets the threadHeight motion
  // value DIRECTLY (no React state → no re-render per frame, so it tracks the
  // finger 1:1); release fires onPullUp/onPullDown (distance OR velocity, via
  // usePullGesture) to snap to a detent.
  const onDragOffset = React.useCallback(
    (offset: number) => {
      draggingRef.current = true;
      // PILL drag: map the upward travel to the pill→input morph (openProgress).
      // The thread stays at 0 until the input is fully formed; only the EXCESS
      // past PILL_OPEN_DISTANCE flows into the thread height, so a single
      // continuous pull reads pill → input → chat (and a flick-up no longer
      // flashes a chat sliver, since the thread only grows after the morph).
      if (pilled) {
        const up = Math.max(0, offset);
        openProgress.set(Math.min(1, up / PILL_OPEN_DISTANCE));
        const excess = up - PILL_OPEN_DISTANCE;
        threadHeight.set(excess > 0 ? clampHeight(excess) : 0);
        return;
      }
      // Pin the dead direction at each end so the panel feels held: collapsed →
      // only upward (positive); full → only downward (negative); half → both.
      const off = !sheetOpen
        ? Math.max(0, offset)
        : expanded
          ? Math.min(0, offset)
          : offset;
      threadHeight.set(clampHeight(baseH + off));
    },
    [
      pilled,
      sheetOpen,
      expanded,
      baseH,
      clampHeight,
      threadHeight,
      openProgress,
    ],
  );

  const pullBinding: PullGestureBinding = usePullGesture({
    onDrag: onDragOffset,
    // Pulls STEP one detent at a time (peek→half→full and back) rather than
    // jumping straight to the ends — the iOS sheet feel. The inline closures are
    // rebuilt every render, so they always read the current detent.
    onPullUp: () => {
      if (pilled) {
        // PILL → INPUT, or straight into the chat when there's history: a flick
        // up opens. Mirror the slow-drag path so a flick and a slow drag BOTH
        // reach the chat (no hard stop at the bare input). Releasing draggingRef
        // first lets the pilled→openProgress effect spring the morph 0→1.
        draggingRef.current = false;
        setPilled(false);
        if (hasThread) {
          focusThreadRef.current = true;
          goToDetent("half");
        } else {
          if (reduce) threadHeight.set(0);
          else animate(threadHeight, 0, SHEET_SPRING);
          detentHaptic();
        }
        return;
      }
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
      if (pilled) return settleDrag(); // already the lowest detent
      // Step down ONE detent based on the EFFECTIVE height (so a free-rest above
      // half steps to half first, never skipping it). A downward flick also
      // closes the keyboard — goToDetent("collapsed") blurs; half-step blurs too.
      const effectiveH = freeH != null ? Math.min(freeH, panelMaxH) : detentH;
      if (sheetOpen && effectiveH > halfH + 1) {
        inputRef.current?.blur();
        goToDetent("half");
      } else if (sheetOpen) {
        goToDetent("collapsed");
      } else {
        // INPUT → PILL: collapse the input away into a pill at the bottom.
        setPilled(true);
        setMaximized(false);
        draggingRef.current = false;
        inputRef.current?.blur();
        detentHaptic();
      }
    },
    // A tap (no drag) on the handle. When collapsed the handle's hit zone covers
    // the composer's center, so a tap there focuses the input to type. While the
    // keyboard is up (composer focused), a tap on the handle DISMISSES it and
    // returns to the pre-focus resting state (collapsed if that's where we came
    // from). A tap on the pill brings the input back.
    onTap: () => {
      if (pilled) {
        openFromPill();
        return;
      }
      const composerFocused =
        typeof document !== "undefined" &&
        document.activeElement === inputRef.current;
      if (composerFocused) {
        inputRef.current?.blur();
        if (preFocusCollapsedRef.current) collapse();
        return;
      }
      if (!sheetOpen) inputRef.current?.focus();
    },
    // A deliberate (slow) drag: REST exactly where released instead of snapping
    // to a detent — drag the sheet to any size and it stays.
    onSettleFree: (direction) => {
      draggingRef.current = false;
      if (pilled) {
        // From the pill: lerp-to-nearest. A slow drag that crossed at least the
        // halfway open (openProgress ≥ 0.5) commits to opening; a shorter pull
        // springs back to the capsule. An opening drag flows straight into the
        // chat — half, or full if the same pull already pushed the thread past
        // the half mark — so pill → input → chat is one continuous motion.
        const opened = direction === "up" && openProgress.get() >= 0.5;
        if (!opened) {
          settleDrag(); // springs openProgress → 0 (pilled still true) + thread → 0
          return;
        }
        setPilled(false);
        if (hasThread) {
          focusThreadRef.current = true;
          goToDetent(threadHeight.get() >= halfH ? "full" : "half");
        } else if (reduce) {
          threadHeight.set(0);
        } else {
          animate(threadHeight, 0, SHEET_SPRING);
        }
        return;
      }
      // From the collapsed input, a downward drag has nothing to "size" below
      // it — collapse straight to the pill (matches the flick-down path).
      if (!sheetOpen && direction === "down") {
        setPilled(true);
        inputRef.current?.blur();
        detentHaptic();
        return;
      }
      const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
      // DETENT MAGNETISM — the resting positions are the detents {collapsed:0,
      // half, full}; a release within SHEET_DETENT_MAGNET of one snaps to it
      // (deterministic, no janky near-detent slivers), and only the clear gaps
      // between them keep the free-drag rest height. goToDetent commits the
      // honest flags so data-detent + the maximize header match the height.
      if (h <= SHEET_DETENT_MAGNET) {
        // Near the bottom → collapse to the input peek.
        closeSheet();
        return;
      }
      focusThreadRef.current = true;
      if (h >= openH - SHEET_DETENT_MAGNET) {
        goToDetent("full");
      } else if (Math.abs(h - halfH) <= SHEET_DETENT_MAGNET) {
        goToDetent("half");
      } else {
        // In a gap between detents → rest exactly where released. `half` is the
        // open base; `freeH` overrides the actual height to where the finger left.
        setFreeH(h);
        setDetent("half");
      }
    },
  });

  // NOTE: the chat has NO close-on-outside-pointerdown beyond the keyboard blur;
  // it COLLAPSES on a pull-down, Escape, or a click on the dimming scrim.

  return (
    <div
      ref={overlayRef}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 flex w-full min-w-0 flex-col items-center",
        // Full-bleed (maximized) removes the side inset so the chat is edge-to-edge.
        fullBleed ? "px-0" : "px-3 sm:px-4",
      )}
      // Lift the whole overlay above the on-screen keyboard (`bottom`); padding
      // below the composer is conditional: when the composer is FOCUSED (keyboard
      // up), only a small gap (0.75rem, matching the side margin) sits between the
      // composer and the keyboard — the home-gesture clearance isn't needed
      // because the keyboard covers it. At rest, clear the home-gesture zone (max
      // safe-area / android inset) plus a hair, keeping the chat low without
      // touching that zone.
      style={{
        zIndex: Z_SHELL_OVERLAY,
        bottom: keyboardInset,
        // Full-bleed fills the screen edge-to-edge: NO overlay bottom padding,
        // so the glass panel reaches the true bottom (no orange gap). The
        // gesture-zone clearance moves INSIDE the composer row (below) so the
        // input still sits above the home-gesture bar. Non-full-bleed keeps the
        // chat lifted off the gesture zone as before.
        paddingBottom: fullBleed
          ? 0
          : composerFocused
            ? "0.75rem"
            : "calc(var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.25rem)",
      }}
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
        // Opacity follows the live history height (motion value) — no re-render
        // during a drag. Capture clicks only once open.
        style={{
          opacity: revealed,
          pointerEvents: sheetOpen ? "auto" : "none",
        }}
      />

      {/* Live interim transcript while listening. There's no "Listening…" text
          cue — the input bar (or collapsed pill) glows with the speech glow to
          confirm the mic is hot. Once the recognizer streams partials in, the
          words appear here above the composer (replaced as more are heard). */}
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

      {/* Audio-unlock prompt. When autoplay policy blocks the first spoken
          reply, the ambient overlay would otherwise go silent with no recourse
          (the in-view status bar has its own unlock; this is the floating-shell
          equivalent). Warm accent = call-to-action; no blue. */}
      {needsAudioUnlock ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none relative mb-2 flex w-full justify-center"
        >
          <button
            type="button"
            onClick={unlockAudio}
            data-testid="overlay-voice-audio-unlock"
            className={cn(
              "pointer-events-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              "border-warn/40 bg-warn/15 text-warn hover:bg-warn/25",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/70",
              FLOAT_SHADOW,
            )}
          >
            <Glyph d={SPEAKER_MUTED_GLYPH} />
            <span>Tap to enable sound</span>
          </button>
        </div>
      ) : null}

      {/* Three tailored prompt suggestions — a keyboard-style strip shown in the
          resting (closed) state when nothing is typed. Tapping one sends it
          immediately, which also pulls the chat sheet up. `order: -1` floats the
          strip ABOVE the chat sheet (sheet-below-bubbles layout); the strip fades
          out as the sheet is dragged up so the unmount on open never pops. */}
      {suggestionsVisible ? (
        <motion.fieldset
          aria-label="Suggested prompts"
          className={cn(
            "pointer-events-auto relative m-0 mb-2 flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 border-0 p-0",
          )}
          style={{ order: -1, opacity: suggestionsOpacity }}
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
        </motion.fieldset>
      ) : null}

      {/* THE chat — one connected object. Its base is the always-present input;
          the conversation grows UP out of it on a pull, inside this same panel.
          The drag handle floats above the panel in THIS non-clipped wrapper
          (the fieldset itself is overflow-hidden), so its big hit zone can reach
          up into the empty space above the input. Pull the handle up to reveal
          history; pull down to collapse the input into the pill. */}
      <div
        className={cn(
          "pointer-events-none relative flex w-full flex-col items-center",
          fullBleed ? "max-w-none" : "max-w-3xl",
        )}
      >
        {!fullBleed ? (
          <SheetGrabber
            open={sheetOpen}
            onOpen={() => {
              if (!hasThread) return;
              goToDetent("half");
              focusThreadRef.current = true;
            }}
            onClose={collapse}
            binding={pullBinding}
            glow={listening || responding}
            opacity={grabberOpacity}
            pilled={pilled}
          />
        ) : null}
        <motion.fieldset
          ref={panelRef}
          aria-label="Chat composer"
          data-testid="chat-sheet"
          data-variant={sheetOpen ? "open" : "closed"}
          // The label reflects the EFFECTIVE height: a free-rest at/near the top
          // reads "full", a mid free-rest folds into "half" — so the label never
          // disagrees with the rendered height.
          data-detent={
            pilled
              ? "pill"
              : !sheetOpen
                ? "collapsed"
                : freeH != null
                  ? Math.min(freeH, panelMaxH) >= openH - 1
                    ? "full"
                    : "half"
                  : expanded
                    ? "full"
                    : "half"
          }
          data-maximized={fullBleed ? "true" : undefined}
          data-revealed={sheetOpen ? "true" : "false"}
          data-chat-state={chatState}
          data-header-shown={headerVisible ? "true" : "false"}
          // ONE persistent element across pill ↔ input ↔ chat (never remounts —
          // that pop was the core jank). It's a transparent scale/position
          // container; the liquid glass lives in an inner layer faded by
          // openProgress, so pill → input is a continuous scale + crossfade.
          // maxHeight keeps it from spilling off the top (thread scrolls instead).
          style={{
            maxHeight: panelMaxH,
            // Full-bleed must be exactly scale 1 — a sub-1 morph scale with a
            // bottom transform-origin would drop the top edge below the status
            // bar (the "gap at the top when maximized" bug).
            scale: fullBleed ? 1 : panelScale,
            // Grow UP out of the pill at the bottom.
            transformOrigin: "bottom center",
            // Pilled: span the (invisible) input area but pass taps through to the
            // home screen — only the pill-capsule child re-enables pointer events.
            pointerEvents: pilled ? "none" : "auto",
          }}
          className={cn(
            // overflow-VISIBLE on the outer fieldset: the glass layer's soft drop
            // shadow + the pill's tall grab zone must bleed past the box. The
            // rounded thread-clip lives on the inner content wrapper instead, so
            // clipping the scroll never clips the shadow into a hard square edge.
            "relative m-0 flex w-full min-w-0 flex-col overflow-visible border-0 p-0",
          )}
        >
          {/* GLASS SURFACE — absolute fill; the blur/bg/border/shadow + the live
              corner radius. Crossfades in by openProgress (compositor opacity —
              never the blur radius, which would repaint per frame). */}
          <motion.div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-0",
              fullBleed ? "border-0" : "border border-white/[0.16]",
              // Liquid glass: a near-clear tint that lets the backdrop show
              // through, BLURRED + over-saturated + brightness-knocked-down so
              // bright content (the orange ambient) stops white text from washing
              // out — instead of a heavy dark fill. blur(16px)+saturate+brightness
              // compose into ONE backdrop-filter pass (blur radius never animated,
              // so it stays cheap on the per-frame-resizing surface). The base
              // bg-black/45 is the legible fallback when backdrop-filter is
              // unavailable; the supports- rule thins it to glass once the filter
              // is doing the darkening.
              "bg-black/45 backdrop-blur-lg backdrop-saturate-[1.8] backdrop-brightness-[0.68] supports-[backdrop-filter]:bg-black/[0.12]",
              fullBleed
                ? "shadow-none"
                : "shadow-[inset_0_1px_0_rgba(255,255,255,0.26),inset_0_0_0_0.5px_rgba(255,255,255,0.08),0_18px_50px_-16px_rgba(0,0,0,0.72)]",
            )}
            style={{
              opacity: glassOpacity,
              borderRadius: fullBleed ? 0 : panelRadius,
            }}
          />
          {/* CONTENT — sheen, glow, thread, composer. Crossfades with the glass
              and goes fully inert while pilled (opacity 0 + `inert` removes it
              from pointer, tab order, and the a11y tree) so it can't be reached
              behind the pill capsule. */}
          <motion.div
            data-testid="chat-content"
            inert={pilled || undefined}
            // overflow-hidden + the live radius clips the sheen/thread to the
            // panel's rounded shape (the clip the fieldset used to do) WITHOUT
            // touching the sibling glass layer's shadow.
            className="relative z-10 flex min-h-0 w-full flex-col overflow-hidden"
            style={{
              opacity: glassOpacity,
              pointerEvents: pilled ? "none" : "auto",
              borderRadius: fullBleed ? 0 : panelRadius,
            }}
          >
            {/* Specular sheen — a soft light from the top edge, the liquid-glass
            highlight. Subtle + non-interactive. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-0 h-20 bg-gradient-to-b from-white/[0.07] to-transparent"
            />
            {/* Soft live-state glow at the base — bright warm while listening, a
            dimmer warm while replying. Orange is the only accent (no blue).
            Two FIXED-color blurred layers crossfaded by opacity ONLY (the old
            single layer tweened backgroundColor, a per-frame paint on a blurred
            element); opacity is compositor-cheap. */}
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-28 blur-xl bg-[rgba(255,180,120,0.30)]"
              initial={false}
              animate={{ opacity: listening ? 1 : 0 }}
              transition={{ duration: reduce ? 0 : 1.1, ease: "easeInOut" }}
            />
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-28 blur-xl bg-[rgba(255,140,80,0.18)]"
              initial={false}
              animate={{ opacity: responding ? 1 : 0 }}
              transition={{ duration: reduce ? 0 : 1.1, ease: "easeInOut" }}
            />

            {/* Sheet header — shown at the HALF detent and up (not just FULL).
              Left: Maximize (toggle edge-to-edge full-screen) + Clear (reset to
              a fresh greeted thread, RotateCcw — it resets, it doesn't delete).
              Right: Home (back to the home dashboard) + Settings. Home is hidden
              while already on the home screen ("chat"); Settings is hidden while
              already on the settings screen. */}
            {!pilled ? (
              <motion.div
                // Always mounted (when not pilled) so it can FADE + LERP its
                // space open/closed with the live height instead of popping in
                // on a mount. `headerVisible` (live-height boolean) gates
                // interactivity + the a11y tree so the faded/collapsed header
                // can't be clicked or read.
                inert={!headerVisible || undefined}
                style={{
                  opacity: headerOpacity,
                  maxHeight: headerMaxH,
                  // Collapsed → 0 top padding (no leaked margin above the
                  // composer); opens to ~10px as the header reveals. Full-bleed
                  // keeps its fixed safe-area inset (it's always fully revealed).
                  paddingTop: fullBleed ? undefined : headerPadTop,
                }}
                className={cn(
                  "relative z-10 flex shrink-0 items-center justify-between gap-1.5 overflow-hidden px-3",
                  // Maximized goes edge-to-edge under the status bar, so the
                  // buttons must clear the safe-area inset (the clock/battery)
                  // or they sit under it and become untappable.
                  fullBleed && "pt-[calc(env(safe-area-inset-top,0px)+0.5rem)]",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <HeaderButton
                    icon={maximized ? Minimize2 : Maximize2}
                    label={maximized ? "exit full screen" : "full screen"}
                    active={maximized}
                    onClick={toggleMaximize}
                    testId="chat-full-maximize"
                  />
                  <HeaderButton
                    icon={RotateCcw}
                    label="clear conversation"
                    onClick={() => clearConversation()}
                    testId="chat-full-clear"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  {currentTab !== "chat" ? (
                    <HeaderButton
                      icon={Home}
                      label="home"
                      onClick={() => navigateAndClose(() => navigateHome?.())}
                      testId="chat-full-home"
                    />
                  ) : null}
                  {currentTab !== "settings" ? (
                    <HeaderButton
                      icon={SettingsIcon}
                      label="settings"
                      onClick={() => navigateAndClose(() => openSettings())}
                      testId="chat-full-settings"
                    />
                  ) : null}
                </div>
              </motion.div>
            ) : null}

            {/* The conversation. Height animates 0 (collapsed) → half → full; the
            inner log scrolls. The grabber owns the drag, so dragging the messages
            just scrolls them. */}
            {hasThread ? (
              <motion.div
                data-testid="chat-thread"
                className={cn(
                  "relative z-10 min-h-0 w-full shrink grow-0 overflow-hidden",
                  // When open, fade the top edge into the glass so the topmost
                  // message dissolves under the drag handle instead of butting
                  // against it.
                  sheetOpen &&
                    "[mask-image:linear-gradient(to_bottom,transparent_0,#000_34px)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_34px)]",
                )}
                // Flex-basis IS the motion value (px string) — set 1:1 during a drag,
                // spring-animated to a detent on release; no `animate`/`transition`,
                // so no re-render. `shrink min-h-0` lets the panel's `maxHeight` cap
                // win: a tall detent (or the keyboard) shrinks the thread (it
                // scrolls) instead of pushing the panel off-screen.
                style={{ flexBasis: threadFlexBasis }}
              >
                <div
                  id="continuous-thread"
                  ref={threadRef}
                  role="log"
                  aria-label="conversation history"
                  aria-live="polite"
                  aria-hidden={!sheetOpen ? true : undefined}
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
                          onCopy={handleCopyMessage}
                          onOpenSettings={openSettings}
                        />
                      ))}
                    </AnimatePresence>
                    <AnimatePresence>
                      {/* Fallback dots for the brief window where we're
                          responding but the assistant placeholder turn isn't in
                          the thread yet. Once the in-flight assistant bubble
                          exists it carries its own dots, so don't double up. */}
                      {responding &&
                      !(
                        visibleMessages.at(-1)?.role === "assistant" &&
                        !visibleMessages.at(-1)?.content.trim()
                      ) ? (
                        <TypingDots reduce={reduce} />
                      ) : null}
                    </AnimatePresence>
                    <div ref={endRef} />
                  </div>
                </div>
              </motion.div>
            ) : null}
            {/* Pending image attachments + any read error, just above the input. */}
            {hasImages || imageError ? (
              <div className="relative z-10 flex shrink-0 flex-col gap-1.5 px-3 pt-2">
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
                          // Small visual disc on a 56px thumbnail, but a 44px-class
                          // hit zone via the invisible `before` overlay so it's
                          // thumb-tappable without crowding the image.
                          className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-white/20 bg-black/70 text-xs text-white/90 backdrop-blur transition-colors before:absolute before:-inset-3 before:content-[''] hover:bg-black/90"
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
            divider sits above it whenever the history is open. The whole content
            wrapper crossfades + scales in from the pill (openProgress), so this
            row needs no separate entrance — it just sits at the panel base. */}
            <div
              className={cn(
                // items-center vertically centers a single-line composer with
                // the round +/mic buttons (the common case); a multi-line draft
                // grows the textarea and the buttons stay centered. shrink-0
                // keeps the input fully visible when the panel hits its
                // maxHeight cap (only the thread above gives way).
                // Equal inset on all sides (px == py): a round button nested in
                // the pill's round end-cap reads as concentric, with the same
                // gap on the sides as top/bottom.
                "relative z-10 flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-2 sm:gap-2",
                sheetOpen ? "border-t border-white/10" : "",
              )}
              // Full-bleed has no overlay bottom padding (the panel is
              // edge-to-edge), so the composer carries the home-gesture
              // clearance itself — except while the keyboard is up, which
              // already covers that zone.
              style={
                fullBleed && !composerFocused
                  ? {
                      paddingBottom:
                        "calc(0.5rem + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)))",
                    }
                  : undefined
              }
            >
              {/* Inline slash-command autocomplete, floating just above the
                    input row. */}
              {slashProp && !slashDismissed ? (
                <SlashCommandMenu
                  state={slashMenu}
                  loading={isSlashDraft && slash.loading}
                  onPick={pickSlashItem}
                />
              ) : null}
              <SoftButton
                glyph={PLUS_GLYPH}
                label="attach image"
                disabled={pendingImages.length >= MAX_CHAT_IMAGES}
                onClick={() => fileInputRef.current?.click()}
                testId="chat-composer-attach"
              />
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Mirror the live draft to the active view (Help search etc.).
                  viewChatBinding?.onQuery?.(e.target.value);
                  if (e.target.value.trim().length > 0) expand();
                }}
                onFocus={() => {
                  setComposerFocused(true);
                  expand();
                }}
                onBlur={() => setComposerFocused(false)}
                onKeyDown={(e) => {
                  // The slash menu intercepts navigation/commit keys when open.
                  if (slashOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      slashMenu.move(1);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      slashMenu.move(-1);
                      return;
                    }
                    if (e.key === "Tab") {
                      const completed = slashMenu.complete();
                      if (completed != null) {
                        e.preventDefault();
                        setDraft(completed);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      const exec = slashMenu.resolve();
                      if (exec) {
                        e.preventDefault();
                        runExecution(exec);
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setSlashDismissed(true);
                      return;
                    }
                  }
                  // Enter sends; Shift+Enter inserts a newline (multi-line compose).
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "Escape" && sheetOpen) {
                    e.preventDefault();
                    collapse();
                  }
                }}
                placeholder={
                  booting
                    ? `Ask ${agentName} — waking up…`
                    : (viewChatBinding?.placeholder ?? `Ask ${agentName}`)
                }
                aria-label="message"
                data-testid="chat-composer-textarea"
                aria-describedby={booting ? "cc-booting-hint" : undefined}
                // Combobox semantics (role + aria-*) are applied as one spread,
                // and only when a slash catalog is wired in — a plain message
                // box otherwise.
                {...comboboxAria}
                className="max-h-[8.5rem] min-h-8 min-w-0 flex-1 resize-none self-center border-none bg-transparent px-1.5 py-1 text-left text-sm leading-relaxed text-white/[0.92] outline-none [scrollbar-width:none] placeholder:text-white/45 [&::-webkit-scrollbar]:hidden"
              />
              <span id="cc-booting-hint" className="sr-only">
                {agentName} is waking up — you can type now; your message sends
                and the reply arrives in a moment.
              </span>
              {/* One trailing control, ChatGPT-style: mic when there's nothing to
              send (or while recording, to stop), swapping to send once the user
              starts typing or attaches an image. It morphs IN PLACE (one
              persistent <div>, no `key`): React reconciles the SoftButton's
              glyph/label/handlers without a remount, so there's no scale/fade
              pop on every keystroke that crosses the draft boundary. */}
              <div className="shrink-0">
                {(hasDraft || hasImages) && !recording ? (
                  <SoftButton
                    icon={SendHorizontal}
                    label={
                      !canSend
                        ? "send (agent stopped)"
                        : responding
                          ? "send another"
                          : "send"
                    }
                    disabled={!canSend}
                    // Keep focus in the textarea on tap: without this the
                    // button steals focus, the textarea blurs, the keyboard
                    // retracts and the composer relayouts between pointerdown
                    // and click — so the first tap only dismissed the keyboard
                    // and a second tap was needed to actually send. Chromium
                    // still dispatches click after a preventDefaulted
                    // pointerdown, so onClick fires on the first tap and the
                    // keyboard stays up for the next message.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={submit}
                    testId="chat-composer-action"
                  />
                ) : !recording && responding ? (
                  // While a reply is streaming and nothing is typed, the mic becomes a
                  // stop control so the user can interrupt a runaway generation.
                  <SoftButton
                    glyph={STOP_GLYPH}
                    label="stop generating"
                    onClick={() => stop()}
                    testId="chat-composer-stop"
                  />
                ) : (
                  <SoftButton
                    icon={Mic}
                    label={
                      pttHolding
                        ? "release to send"
                        : handsFree
                          ? "end conversation"
                          : recording
                            ? "stop listening"
                            : "talk"
                    }
                    active={recording || handsFree}
                    onClick={handleMicClick}
                    onPointerDown={beginPushToTalkPress}
                    onPointerUp={(e) => finishPushToTalkPress(e, false)}
                    onPointerCancel={(e) => finishPushToTalkPress(e, true)}
                    testId="chat-composer-mic"
                  />
                )}
              </div>
            </div>
          </motion.div>
          {/* PILL CAPSULE — the collapsed handle, crossfaded out as the input
              forms. Interactive only while pilled; sits over the (faded) input. */}
          <motion.div
            className="absolute inset-x-0 bottom-0 z-30 flex justify-center"
            style={{
              opacity: pillOpacity,
              pointerEvents: pilled ? "auto" : "none",
            }}
          >
            <PillHandle
              binding={pullBinding}
              onOpen={openFromPill}
              glow={listening || responding}
            />
          </motion.div>
        </motion.fieldset>
      </div>
    </div>
  );
}
