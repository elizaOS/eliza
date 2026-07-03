import { transcriptPlainText } from "@elizaos/shared/transcripts";
import {
  Check,
  Copy,
  FileText,
  Film,
  LayoutGrid,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Music,
  Pencil,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Square,
  Volume2,
  X,
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

import { client } from "../../api/client";
import type {
  ChatTurnStatus,
  ImageAttachment,
} from "../../api/client-types-chat";
import {
  parseSlashDraft,
  resolveClientShortcutExecution,
  runSlashExecution,
  type SlashExecution,
  splitLeadingSlashCommand,
} from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import {
  type BackIntentEventDetail,
  CHAT_PREFILL_EVENT,
  type ChatPrefillEventDetail,
  ELIZA_BACK_INTENT_EVENT,
  TUTORIAL_CHAT_CONTROL_EVENT,
  type TutorialChatControlDetail,
} from "../../events";
import { useConversationSwipeJank } from "../../hooks/useConversationSwipeJank";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { claimAssistantLaunchPayloadFromHash } from "../../platform/assistant-launch-payload";
import {
  clearChatDraft,
  readChatDraft,
  useChatComposerDraftPersistence,
  writeChatDraft,
} from "../../state/ChatComposerContext.hooks";
import { useConversationMessages } from "../../state/ConversationMessagesContext.hooks";
import { goHome, goLauncher } from "../../state/shell-surface-store";
import { useViewChatBinding } from "../../state/view-chat-binding";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  CHAT_UPLOAD_ACCEPT,
  chatUploadKind,
  classifyComposerPaste,
  intakeAttachmentFiles,
  MAX_CHAT_IMAGES,
  summarizeDroppedAttachments,
} from "../../utils/image-attachment";
import { InlineWidgetText } from "../chat/InlineWidgetText";
import { MessageAttachments } from "../chat/MessageAttachments";
import { SensitiveRequestBlock } from "../chat/MessageContent";
import { findChoiceRegions } from "../chat/message-choice-parser";
import { findFollowupsRegions } from "../chat/message-followups-parser";
import { findFormRegions } from "../chat/message-form-parser";
import { ThinkingBlock } from "../chat/ThinkingBlock";
import { withTranscriptMarker } from "../chat/TranscriptViewerOverlay";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  measureSafeAreaInsetTop,
  resolveChatPanelLayout,
} from "./chat-panel-layout";
import { SlashCommandMenu, useSlashMenu } from "./SlashCommandMenu";
import { type ShellMessage, selectVisibleShellMessages } from "./shell-state";
import { TopicChipsBar } from "./TopicChipsBar";
import { TopicGroup } from "./TopicGroup";
import { deriveChannelTopics, groupMessagesByTopic } from "./topic-grouping";
import { type PullGestureBinding, usePullGesture } from "./use-pull-gesture";
import { usePromptSuggestions } from "./usePromptSuggestions";
import type { ConversationNav, ShellController } from "./useShellController";

/**
 * Server source tag for decider-pushed proactive suggestions (#8792) — mirrors
 * PROACTIVE_INTERACTION_SOURCE in the agent's proactive-interaction decider.
 */
const PROACTIVE_SUGGESTION_SOURCE = "proactive-interaction";

/** No-op slash controller so the overlay renders without a provider (stories). */
const EMPTY_SLASH_CONTROLLER: SlashCommandController = {
  commands: [],
  loading: false,
  naturalShortcutsEnabled: false,
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
 * it. At rest the sheet is only the composer + grabber; pull the grabber UP, or
 * just start typing, to spring it open into the full transcript. Pull the
 * grabber back DOWN, or press Escape, to close.
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
// fixed composer; its height animates between the closed composer/grabber and
// OPEN (most of the viewport above the input). The live drag tracks the finger
// 1:1; release snaps with an
// Apple-style spring. HALF is a comfortable mid-stop; FULL fills all the way to
// panelMaxH (the sheet rises to just under the status bar) — you pull it back
// DOWN to dismiss.
/** The five explicit states of the floating chat surface. Derived from the
 * resting height + flags so it always matches what's rendered (see the
 * `chatState` derivation in the component). */
export type ChatState =
  | "CLOSED"
  | "INPUT"
  | "OPEN_UNDER_HALF"
  | "OPEN_HALF_OR_OVER"
  | "MAXIMIZED";

/**
 * The chat's openness as a SINGLE source of truth — one ordered state machine
 * instead of separate `pilled` boolean + `detent` enum that had to be hand-kept
 * in sync. `pill` (collapsed to the bottom capsule) sits below `input` (bare
 * composer bar), then `half`/`full` open the thread. `pilled`, `sheetOpen`,
 * `expanded`, and the `detent` height read are all derived from this; `freeH`
 * (a transient free-drag height) and `maximized` (the full-bleed variant of
 * `full`) remain orthogonal overrides.
 */
export type ChatMode = "pill" | "input" | "half" | "full";

/** Push-to-talk lifecycle. idle → pending (timer armed) → holding (dictating) →
 *  idle. A release while still `pending` is a quick tap (no capture started). */
type PttPhase =
  | { kind: "idle" }
  | { kind: "pending"; pointerId: number; timer: number }
  | { kind: "holding"; pointerId: number };

type MotionControls = { stop: () => void };

const SHEET_HALF_VH = 0.46; // fraction of viewport height at the HALF detent
// The panel's top clearance + max height (which decide where the header buttons
// land relative to the notch) live in the pure, unit-tested
// `resolveChatPanelLayout` — see chat-panel-layout.ts.
// Detent magnetism: on a deliberate (non-flick) drag release, a height within
// this many px of a detent (collapsed/half/full) snaps to that detent instead
// of resting free — so near-detent releases are deterministic + clean, and only
// the clear gaps between detents keep the free-drag rest height.
const SHEET_DETENT_MAGNET = 64;
const OUTSIDE_SHEET_TAP_SLOP = 10;

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

/** Base64-encode WAV bytes in chunks (avoids the apply() arg-count limit). */
function wavBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** UTF-8-safe base64 for a transcript turned into a composer text attachment. */
function textToBase64(text: string): string {
  return wavBytesToBase64(new TextEncoder().encode(text));
}
// Muted-speaker glyph for the autoplay-blocked "tap to enable sound" prompt.
const SPEAKER_MUTED_GLYPH =
  "M7 15H12L18 10V26L12 21H7Z M21 12.4L22.4 11L31 19.6L29.6 21Z";
function Glyph({
  d,
  className,
}: {
  d: string;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 36 36"
      className={cn("h-[26px] w-[26px]", className)}
      aria-hidden="true"
    >
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
    <Button
      variant="ghost"
      size="icon-lg"
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
        // Icon-only control: transparent, borderless, no capsule — just the
        // glyph, sized up to carry weight without the removed background. The
        // 44×44 hit target (WCAG 2.5.5) stays; only the visible chrome goes.
        // Hover and active express through icon color alone — neutral resting →
        // neutral hover, accent for active — never a background/border, never
        // blue.
        "grid h-11 w-11 shrink-0 place-items-center bg-transparent p-0 transition-colors hover:bg-transparent",
        active ? "text-accent" : "text-white/75 hover:text-white",
        disabled && "opacity-40",
      )}
    >
      {Icon ? (
        <Icon className="h-[26px] w-[26px]" aria-hidden={true} />
      ) : glyph ? (
        <Glyph d={glyph} className="h-[30px] w-[30px]" />
      ) : null}
    </Button>
  );
}

/** A compact icon-only control for the full-state header (maximize / clear /
 *  settings). Smaller than SoftButton; same borderless neutral resting →
 *  neutral-hover language (no blue), `active` renders as the accent color. */
function HeaderButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  testId,
}: {
  icon: typeof Maximize2;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={cn(
        // Icon-only, same borderless language as SoftButton: no capsule, no
        // background — the glyph alone carries the control. Neutral resting →
        // neutral hover; active expresses as the accent color, never a fill.
        "grid h-9 w-9 shrink-0 place-items-center bg-transparent p-0 transition-colors hover:bg-transparent",
        disabled
          ? // On the view it targets: shown but inert + dimmed (we disable, not hide).
            "cursor-default text-white/35"
          : active
            ? "text-accent"
            : "text-white/75 hover:text-white",
      )}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden />
    </Button>
  );
}

/** Horizontal travel (px) at which a conversation-swipe edge hint is fully lit. */
const SWIPE_HINT_FULL = 96;

/** Inert conversation-nav fallback for minimal mock controllers. */
const EMPTY_CONVERSATION_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
  activeId: null,
  index: -1,
};

/**
 * A soft glass glow on the sheet edge the next/previous conversation will slide
 * in from during a horizontal swipe (#8929). Brightens with the drag distance;
 * inert and non-interactive.
 */
function SwipeEdgeHint({
  side,
  active,
  amount,
}: {
  side: "left" | "right";
  active: boolean;
  amount: number;
}): React.JSX.Element | null {
  if (!active) return null;
  const opacity = Math.min(1, Math.max(0, amount) / SWIPE_HINT_FULL);
  if (opacity <= 0) return null;
  return (
    <div
      aria-hidden
      data-testid={`conversation-swipe-hint-${side}`}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-20 w-16",
        side === "left"
          ? "left-0 bg-gradient-to-r from-white/25 to-transparent"
          : "right-0 bg-gradient-to-l from-white/25 to-transparent",
      )}
      style={{ opacity }}
    />
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
        // input bar). Keep the invisible hit target local to the visible handle:
        // it should be forgiving, not register drags far above the bar.
        // z-20 keeps it above the input row (z-10) so it always wins the drag.
        "absolute left-1/2 top-0.5 z-20 -translate-x-1/2 flex cursor-grab touch-none select-none items-center justify-center px-16 py-2 active:cursor-grabbing",
        // The hit zone reaches only a small distance above the panel and stops
        // at the handle's own bottom, so the handle does not steal taps intended
        // for the composer or feel like it starts in empty space.
        "before:absolute before:-inset-x-4 before:-top-4 before:bottom-0 before:content-['']",
        "   ",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // The visible grabber line. Its show/hide is driven by the WRAPPER's
          // `grabberOpacity` crossfade (fades in over [0.55, 0.95] of the open),
          // strictly anti-phase with the pill bar so the two are never on screen
          // together. The bar paints at full opacity — a prior regression pinned
          // it to `opacity-0`, leaving the handle grabbable but invisible (#9142).
          "h-2.5 w-16 rounded-full opacity-100 transition-colors duration-300",
          // Pulse while the mic is hot / a reply is speaking: the warm bar
          // breathes instead of sitting static, the "audio is on" cue.
          glow
            ? "animate-pulse bg-[rgba(255,180,120,0.8)] motion-reduce:animate-none"
            : "bg-white/45",
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
  pilled,
}: {
  binding: PullGestureBinding;
  onOpen: () => void;
  glow: boolean;
  // Interactive ONLY while pilled. The handle's hit zone (`px-16 pt-10`) is tall
  // and wide and sits directly over the composer textarea; if it kept
  // `pointer-events-auto` while NOT pilled it would intercept the tap meant for
  // the input (the parent's `pointer-events:none` can't override a child that
  // opts back in), so the keyboard would never open. Gate on `pilled` so taps
  // pass through to the textarea once the input has formed.
  pilled: boolean;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      data-testid="chat-pill"
      aria-label="open chat"
      // No onClick: the pull-gesture binding is the single tap authority (a tap
      // routes through onPointerUp → onTap → openFromPill), matching the
      // SheetGrabber. A native onClick would ALSO fire on every tap, opening the
      // pill twice in one gesture (double haptic + a stale focus-suppress flag
      // that swallowed the next focus→expand). Keyboard activation still routes
      // through onKeyDown below.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
          e.preventDefault();
          onOpen();
        }
      }}
      {...binding}
      tabIndex={pilled ? undefined : -1}
      aria-hidden={pilled ? undefined : true}
      className={cn(
        // The bar hugs the BOTTOM (small pb) where the collapsed input sat — not
        // floating mid-air; the tall pt keeps a generous upward grab/flick zone.
        "h-auto w-auto cursor-grab touch-none select-none items-end rounded-none bg-transparent px-16 pb-1.5 pt-10 hover:bg-transparent active:cursor-grabbing",
        // Interactive only while pilled. When NOT pilled the (faded) handle must
        // let taps fall through to the composer textarea below it — otherwise its
        // tall hit zone steals the tap and the keyboard never opens.
        pilled ? "pointer-events-auto" : "pointer-events-none",
        "   ",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // Identical to the SheetGrabber bar — same white shape + color whether
          // the chat is open or collapsed to the pill. Its show/hide is driven by
          // the WRAPPER's `pillOpacity` crossfade (anti-phase with the grabber).
          // The bar paints at full opacity — a prior regression pinned it to
          // `opacity-0`, leaving the pill handle grabbable but invisible (#9142).
          "h-2.5 w-16 rounded-full opacity-100 transition-colors duration-300",
          // Same pulse as the SheetGrabber bar: while audio is on and the chat
          // is collapsed to the pill, the pill itself pulses.
          glow
            ? "animate-pulse bg-[rgba(255,180,120,0.8)] motion-reduce:animate-none"
            : "bg-white/45",
        )}
      />
    </Button>
  );
}

/** Humanize an action/tool symbol ("SEND_MESSAGE" → "Send message") for the
 *  status label so it reads as prose, not a constant. */
function humanizeStatusName(name: string): string {
  const cleaned = name.trim().replace(/[_-]+/g, " ").toLowerCase();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** The phase label shown beside the breathing dots. Server-provided `label`
 *  always wins; otherwise derive a concise phrase from the kind (+ action/tool
 *  name when present). */
function turnStatusLabel(status: ChatTurnStatus): string {
  if (status.label?.trim()) return status.label.trim();
  switch (status.kind) {
    case "thinking":
      return "Thinking";
    case "streaming":
      return "Replying";
    case "running_action":
      return status.actionName
        ? `Running ${humanizeStatusName(status.actionName)}`
        : "Working";
    case "running_tool":
      return status.toolName
        ? `Using ${humanizeStatusName(status.toolName)}`
        : "Using a tool";
    case "evaluating":
      return "Reflecting";
    case "waking":
      return "Waking the agent";
    case "speaking":
      return "Speaking";
  }
}

// Min time (ms) a phase label must stay on screen before the next one replaces
// it. Without this, a fast thinking→action→streaming sequence flickers through
// labels faster than the eye can read. The text content the user sees is
// debounced; the dots animate continuously throughout.
const STATUS_MIN_DWELL_MS = 320;

/** Debounce a fast-changing status to a min on-screen dwell so a rapid
 *  thinking→action→streaming sequence doesn't strobe the label. The dots animate
 *  continuously; only the words wait their turn. Returns null when status is
 *  null (between turns). */
function useDebouncedTurnStatus(
  status: ChatTurnStatus | null,
): ChatTurnStatus | null {
  const [shown, setShown] = React.useState<ChatTurnStatus | null>(status);
  const lastChangeRef = React.useRef(0);
  const timerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!status) {
      setShown(null);
      return;
    }
    const now = Date.now();
    const elapsed = now - lastChangeRef.current;
    if (elapsed >= STATUS_MIN_DWELL_MS) {
      lastChangeRef.current = now;
      setShown(status);
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      lastChangeRef.current = Date.now();
      setShown(status);
      timerRef.current = null;
    }, STATUS_MIN_DWELL_MS - elapsed);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);
  return shown;
}

/**
 * The breathing dots + phase label content of the status indicator, WITHOUT a
 * bubble/motion wrapper — used both standalone (wrapped by TurnStatusIndicator)
 * and inline inside the in-flight assistant bubble.
 *
 * Mirrors ChatVoiceStatusBar's a11y (`role="status"` + `aria-live="polite"`).
 * Honors reduced motion (no pulse). Brand-safe: orange (the accent) ONLY for
 * `speaking`; every other phase is neutral white. No blue anywhere. Degrades to
 * plain dots when no status has arrived.
 */
function TurnStatusInner({
  status,
  showLabel = true,
}: {
  status: ChatTurnStatus | null;
  showLabel?: boolean;
}): React.JSX.Element {
  const shown = useDebouncedTurnStatus(status);
  const speaking = shown?.kind === "speaking";
  const label =
    showLabel && shown && shown.kind !== "thinking"
      ? turnStatusLabel(shown)
      : null;
  return (
    <span
      className="inline-flex items-center gap-2"
      data-testid="turn-status-indicator"
      data-status-kind={shown?.kind ?? "none"}
      role="status"
      aria-live="polite"
    >
      <span
        className="flex gap-1.5"
        data-testid="typing-dots"
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 w-1.5 animate-pulse rounded-full motion-reduce:animate-none",
              speaking ? "bg-[rgba(255,190,140,0.9)]" : "bg-white/70",
            )}
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      {label ? (
        <span
          className={cn(
            "text-[13px] font-medium",
            speaking ? "text-[rgba(255,200,150,0.95)]" : "text-white/90",
          )}
          data-testid="turn-status-label"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The rich, phase-aware status row shown while the assistant works (#8813),
 * replacing the bare typing dots in the pre-placeholder gap. Wraps
 * TurnStatusInner in its own glass bubble + fade so it reads as a turn.
 */
function TurnStatusIndicator({
  status,
  reduce,
}: {
  status: ChatTurnStatus | null;
  reduce?: boolean;
}): React.JSX.Element {
  const speaking = status?.kind === "speaking";
  return (
    <motion.div
      className="mb-2.5 flex w-full justify-start"
      // Fade in/out so the row dissolves with the reply rather than popping.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.45, ease: OVERLAY_EASE }}
    >
      <div
        className={cn(
          "rounded-2xl rounded-bl-md border px-3.5 py-2",
          FLOAT_SHADOW,
          // Orange (the accent) ONLY for spoken replies; every other phase is
          // neutral white glass. No blue anywhere.
          // #10698: no own scrim — the shared panel glass carries the contrast;
          // keep only the tone border (orange when speaking) + FLOAT_SHADOW.
          speaking ? "border-[rgba(255,180,120,0.45)]" : "border-white/10",
        )}
      >
        <TurnStatusInner status={status} />
      </div>
    </motion.div>
  );
}

// After this long still booting, the banner escalates to a "taking longer than
// usual" state with a settings escape, so a stuck boot never reads as a silent
// hang. Exported for the unit test (see the __-seam note below).
export const BOOT_SLOW_AFTER_MS = 90_000;

// Grace before the banner appears: a warm agent leaves the "booting" phase
// within a frame, so only a real cold boot outlasts this and shows the banner
// — no flash on a first paint / warm reconnect.
const BOOT_BANNER_GRACE_MS = 600;

/**
 * Cold-start boot feedback (resting, pre-send): an indeterminate spinner + live
 * "Waking …" label, escalating after {@link BOOT_SLOW_AFTER_MS} to a "taking
 * longer than usual" state with an Open-settings escape. The parent gates
 * mounting on {@link BOOT_BANNER_GRACE_MS} (see the render site).
 *
 * Exported (with BOOT_SLOW_AFTER_MS) only as a unit-test seam — not part of the
 * public overlay API; cf. `__renderThreadLineForParity`.
 */
export function BootStatusIndicator({
  agentName,
  onOpenSettings,
  reduce,
}: {
  agentName: string;
  onOpenSettings?: () => void;
  reduce?: boolean;
}): React.JSX.Element {
  // Local elapsed timing is the only boot signal the overlay has (agentStatus
  // carries no boot-start timestamp), and it suffices: the parent unmounts this
  // the instant readiness flips, so the timer never outlives the boot.
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), BOOT_SLOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="chat-boot-status"
      data-aesthetic-audit-ignore-text-density="true"
      data-slow={slow ? "true" : undefined}
      className="pointer-events-none relative mb-2 flex w-full justify-center"
    >
      <span
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm font-medium text-white/85",
          FLOAT_SHADOW,
        )}
      >
        {slow ? (
          <>
            <RotateCcw
              className={cn(
                "h-3.5 w-3.5 text-accent",
                reduce ? "" : "animate-spin [animation-duration:2.4s]",
              )}
              aria-hidden="true"
            />
            <span>{agentName} is taking longer than usual to wake…</span>
            {onOpenSettings ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenSettings}
                data-testid="chat-boot-open-settings"
                className="pointer-events-auto ml-1 h-auto rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[12px] text-white/90 transition-colors hover:border-white/35 hover:bg-white/20"
              >
                Open settings
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Loader2
              className={cn(
                "h-3.5 w-3.5 text-accent",
                reduce ? "" : "animate-spin",
              )}
              aria-hidden="true"
            />
            <span>Waking {agentName}…</span>
          </>
        )}
      </span>
    </div>
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

/**
 * Render a user turn's text, bolding a leading slash command so a sent
 * `/command` reads as a command in the transcript (mirroring the composer's
 * inline autocomplete). Plain prose renders unchanged.
 */
function ThreadLineText({ content }: { content: string }): React.ReactNode {
  const slash = splitLeadingSlashCommand(content);
  if (!slash) return content;
  return (
    <>
      <span className="font-bold" data-testid="slash-command-token">
        {slash.command}
      </span>
      {slash.rest}
    </>
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
 * onboarding turn). Such a bubble must NOT be wrapped in the tap-to-reveal
 * `role="button"` container: WebKit exposes an ARIA button as an ATOMIC AX leaf
 * (its aria-label becomes the node's name and all descendants are dropped), so
 * the wrapper silently removes the choice buttons + text from the native
 * accessibility tree — invisible to VoiceOver AND to XCUITest. The parser
 * helpers reset their own regex lastIndex, so repeated calls are safe.
 */
function messageHasInteractiveWidget(content: string): boolean {
  return (
    findChoiceRegions(content).length > 0 ||
    findFormRegions(content).length > 0 ||
    findFollowupsRegions(content).length > 0
  );
}

/**
 * True while there's a live (non-collapsed) text selection. The
 * conversation-swipe binding lives on the transcript surface, which contains
 * the selectable message bubbles — so a MOUSE drag to highlight bubble text
 * travels horizontally and otherwise reads as a swipe, navigating away and
 * destroying the selection on release. The swipe handlers consult this to skip
 * navigation when the gesture was really a highlight, mirroring the ThreadLine
 * tap-reveal guard (`window.getSelection()` non-collapsed). Touch drags don't
 * create a selection, so a genuine finger swipe is unaffected.
 */
function hasLiveTextSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && sel.toString().trim().length > 0;
}

/**
 * One icon-only control in a message's click-to-reveal action row (#10713).
 * Overlay glass styling: no card fill, neutral resting → neutral-opacity hover;
 * an active (e.g. playing) control tints with the orange accent. `stopPropagation`
 * keeps a tap on the button from re-toggling the row or ending text selection.
 */
function ThreadLineActionButton({
  label,
  icon,
  onClick,
  active,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "h-7 w-7 rounded-full p-0 transition-colors",
        active
          ? "bg-[rgb(255,88,0)]/25 text-white"
          : "bg-white/10 text-white/80 hover:bg-white/20",
      )}
    >
      {icon}
    </Button>
  );
}

/**
 * Inline editor for a user message (#10713). Prefilled with the message text;
 * ⌘/Ctrl+Enter resends the edit, Escape cancels. The parent reveal handler
 * ignores events while editing.
 */
function ThreadLineEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        aria-label="Edit message"
        data-testid="thread-line-edit-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // Escape closes THIS editor only — stop it from bubbling to the
            // overlay's document-level Escape handler, which would otherwise
            // also collapse the whole chat sheet and discard the edit (#9148).
            e.stopPropagation();
            onCancel();
          }
        }}
        rows={Math.min(6, Math.max(1, value.split("\n").length))}
        className="min-h-0 w-full resize-none rounded-lg border-0 bg-white/10 px-2.5 py-1.5 text-[14px] text-white outline-none [overflow-wrap:anywhere]"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          data-testid="thread-line-edit-cancel"
          onClick={onCancel}
          className="h-auto rounded-full bg-white/10 px-3 py-1 text-[13px] font-medium text-white/80 transition-colors hover:bg-white/20"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          data-testid="thread-line-edit-save"
          onClick={onSave}
          className="h-auto rounded-full bg-[rgb(255,88,0)] px-3 py-1 text-[13px] font-medium text-white transition-colors hover:bg-[rgb(214,74,0)]"
        >
          Send
        </Button>
      </div>
    </div>
  );
}

const ThreadLine = React.memo(function ThreadLine({
  message,
  floating,
  reduce,
  onCopy,
  onSpeak,
  onEdit,
  onRetry,
  speaking,
  onOpenSettings,
  turnStatus,
  suppressReasoning,
  onAcceptSuggestion,
  onDismissSuggestion,
}: {
  message: ShellMessage;
  floating?: boolean;
  reduce?: boolean;
  /** Copy this message's text. Used by both the press-and-hold shortcut
   *  (assistant) and the reveal-row Copy control (both roles). Stable identity. */
  onCopy?: (text: string) => void;
  /** Speak an assistant message aloud (reveal-row Play). Receives the message
   *  id so the parent can track which bubble is playing. Stable identity. */
  onSpeak?: (id: string, text: string) => void;
  /** Save an edited user message and resend it (reveal-row Edit). Stable id. */
  onEdit?: (text: string) => void;
  /** Retry a failed/interrupted assistant turn — re-sends the preceding user
   *  turn. Receives the assistant turn's id so the parent can walk back to the
   *  user turn that produced it. Stable identity. */
  onRetry?: (assistantId: string) => void;
  /** True while assistant voice output is playing — drives Play↔Stop. */
  speaking?: boolean;
  /** Jump to Settings from the no_provider gate. Stable identity. */
  onOpenSettings?: () => void;
  /** Rich status for the in-flight (empty) assistant bubble (#8813). Only the
   *  last, content-less assistant turn reads this; settled turns ignore it. */
  turnStatus?: ChatTurnStatus | null;
  /** Hide reasoning while the assistant turn is still streaming. */
  suppressReasoning?: boolean;
  /** Accept ("Do it") a proactive suggestion (#8792) — sends the implied
   *  action as a real turn and clears the bubble. Stable identity. */
  onAcceptSuggestion?: (message: ShellMessage) => void;
  /** Dismiss a proactive suggestion (#8792) — removes the bubble locally; the
   *  server-side per-surface cooldown guards immediate re-noise. Stable id. */
  onDismissSuggestion?: (messageId: string) => void;
}): React.JSX.Element {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  // Proactive suggestion bubbles (#8792): distinct affordance (Suggestion chip
  // + "Do it" + dismiss) on assistant turns pushed by the interaction decider.
  const isSuggestion =
    isAssistant && message.source === PROACTIVE_SUGGESTION_SOURCE;

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
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          if (isNestedInteractiveTarget(e.currentTarget, e.target)) return;
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
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
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

  // Click-to-reveal per-message action row (#10713): tapping a bubble reveals
  // Copy + Play (assistant) or Copy + Edit (user) beneath it; an outside tap
  // dismisses. This is the primary extraction affordance on pointer devices; the
  // press-and-hold copy above stays as a secondary touch shortcut.
  const trimmed = message.content.trim();
  const lineRef = React.useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editDraft, setEditDraft] = React.useState("");
  const [rowCopied, setRowCopied] = React.useState(false);
  const rowCopiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (rowCopiedTimer.current !== null)
        window.clearTimeout(rowCopiedTimer.current);
    },
    [],
  );

  const canRowCopy = !!onCopy && trimmed.length > 0;
  const canSpeak = isAssistant && !!onSpeak && trimmed.length > 0;
  // A user turn is editable unless it's an optimistic (temp-) turn not yet
  // acknowledged by the server — mirrors the composite ChatMessage's canEdit.
  const canEdit =
    isUser && !!onEdit && trimmed.length > 0 && !message.id.startsWith("temp-");
  const hasActions = canRowCopy || canSpeak || canEdit;
  // An assistant turn that carries an inline choice/form/followups widget (every
  // first-run onboarding turn) must stay a plain container — never the
  // tap-to-reveal `role="button"` bubble, which WebKit collapses into a single
  // atomic AX node and thereby hides the choice buttons from VoiceOver + XCUITest.
  const hasInteractiveWidget = React.useMemo(
    () => isAssistant && messageHasInteractiveWidget(message.content),
    [isAssistant, message.content],
  );

  // A recoverable assistant failure (the agent was rate-limited or the provider
  // stalled / the stream was interrupted) gets a one-tap Retry that re-sends the
  // preceding user turn — mirroring ChatView's MessageContent gate. `no_provider`
  // (its own Settings gate above) and `insufficient_credits` are excluded: a
  // retry can't fix those.
  const canRetry =
    isAssistant &&
    !!onRetry &&
    (message.failureKind === "rate_limited" ||
      message.failureKind === "provider_issue");

  const toggleRevealed = React.useCallback(() => {
    if (!hasActions || editing) return;
    // Never hijack a text-selection drag: a click that finishes a highlight must
    // not also toggle the row (the bubble text stays selectable to copy).
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && sel.toString().trim().length > 0) return;
    setRevealed((v) => !v);
  }, [hasActions, editing]);
  const bubbleInteractive = hasActions && !editing && !hasInteractiveWidget;
  const handleBubbleClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!bubbleInteractive) return;
      if (isNestedInteractiveTarget(e.currentTarget, e.target)) return;
      toggleRevealed();
    },
    [bubbleInteractive, toggleRevealed],
  );
  const handleBubbleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!bubbleInteractive) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleRevealed();
    },
    [bubbleInteractive, toggleRevealed],
  );

  React.useEffect(() => {
    if (!revealed) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (lineRef.current && !lineRef.current.contains(e.target as Node)) {
        setRevealed(false);
        setEditing(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [revealed]);

  const handleRowCopy = React.useCallback(() => {
    onCopy?.(message.content);
    setRowCopied(true);
    if (rowCopiedTimer.current !== null)
      window.clearTimeout(rowCopiedTimer.current);
    rowCopiedTimer.current = window.setTimeout(() => setRowCopied(false), 1100);
  }, [onCopy, message.content]);

  const handleSpeak = React.useCallback(() => {
    onSpeak?.(message.id, message.content);
  }, [onSpeak, message.id, message.content]);

  const openEditor = React.useCallback(() => {
    setEditDraft(message.content);
    setEditing(true);
  }, [message.content]);

  const saveEdit = React.useCallback(() => {
    const next = editDraft.trim();
    setEditing(false);
    setRevealed(false);
    if (next && next !== message.content.trim()) onEdit?.(next);
  }, [editDraft, message.content, onEdit]);

  const cancelEdit = React.useCallback(() => {
    setEditing(false);
    setRevealed(false);
  }, []);

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
            // #10698: minimize the own scrim (0.60 → 0.35) now the shared glass
            // carries contrast, but keep a fill so this critical no-provider CTA
            // stays prominent over any wallpaper; structure/amber border kept.
            "max-w-[85%] rounded-2xl rounded-bl-md border border-amber-300/30 bg-black/35 px-3.5 py-3 text-white",
            FLOAT_SHADOW,
          )}
        >
          <div className="mb-1 text-[14px] font-medium">
            Connect a provider to chat
          </div>
          <div className="mb-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-white/80 [overflow-wrap:anywhere]">
            {message.content}
          </div>
          <Button
            variant="ghost"
            size="sm"
            data-testid="chat-no-provider-settings"
            onClick={() => onOpenSettings?.()}
            className="h-auto rounded-full border border-white/20 bg-white/15 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-white/25   "
          >
            Open Settings
          </Button>
        </div>
      </motion.div>
    );
  }

  const bubbleClassName = cn(
    // whitespace-pre-wrap keeps newlines; overflow-wrap breaks long URLs /
    // hashes / paths so they can't blow out the bubble width on a phone.
    "relative w-fit max-w-full whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed [overflow-wrap:anywhere]",
    // The chrome-free transcript renders floating: each bubble carries its
    // own dark glass so it stays legible directly over whatever view is
    // behind. The light tone is for any embedding that supplies its own
    // surrounding scrim.
    isUser ? "rounded-br-md" : "rounded-bl-md",
    // Message text must remain selectable for normal highlight/copy.
    // Assistant bubbles still keep the press-and-hold copy shortcut.
    "select-text [-webkit-touch-callout:default]",
    // Tapping a bubble with actions reveals its row (pointer affordance).
    bubbleInteractive && "cursor-pointer",
    // #10698: no per-message fill — text floats transparently on the one
    // shared panel glass. FLOAT_SHADOW + light text keep it legible; a
    // hairline edge remains to define the item boundary.
    floating
      ? cn("border border-white/15 text-white", FLOAT_SHADOW)
      : isUser
        ? "text-white"
        : "text-white/90",
    // Suggestion treatment (#8792): dashed accent edge + faint accent tint so
    // a proactive offer reads as a suggestion, not a normal reply — mirrors
    // the composite ChatMessage's affordance. Placed last so it wins over the
    // floating hairline.
    isSuggestion &&
      "border border-dashed border-[rgb(255,88,0)]/45 bg-[rgb(255,88,0)]/[0.06]",
  );
  const bubbleContent =
    isUser && editing ? (
      <ThreadLineEditor
        value={editDraft}
        onChange={setEditDraft}
        onSave={saveEdit}
        onCancel={cancelEdit}
      />
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
          {isAssistant &&
          !message.content.trim() &&
          !message.attachments?.length ? (
            // The in-flight assistant turn (kept by visibleMessages only while
            // responding): show dots INSIDE the bubble, anchored where the
            // streamed text fills in — then the text replaces them. Labels stay
            // in the standalone status row so the bubble never flashes
            // "Running …" text in place of the answer.
            <>
              <TurnStatusInner status={turnStatus ?? null} showLabel={false} />
              {message.attachments?.length ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}
            </>
          ) : isUser ? (
            // User turns stay raw text (slash command bolded); user uploads render
            // through the standalone attachment renderer.
            <>
              <ThreadLineText content={message.content} />
              {message.attachments?.length ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}
            </>
          ) : (
            // Settled assistant turn: render inline widgets (task/choice/form/
            // followups) instead of leaking raw `[TASK:…]`/`[CHOICE]`/… markers as
            // text (#8997); plain replies fall through the fast path unchanged.
            // Attachments, the secret/OAuth request, and the reasoning block render
            // alongside. The secret block is `pointer-events-auto` so it stays
            // clickable inside the open thread's scroll surface.
            <>
              <InlineWidgetText content={message.content} />
              {message.attachments?.length ? (
                <MessageAttachments attachments={message.attachments} />
              ) : null}
              {message.secretRequest ? (
                <div className="pointer-events-auto">
                  <SensitiveRequestBlock request={message.secretRequest} />
                </div>
              ) : null}
              {!suppressReasoning && message.reasoning?.trim() ? (
                <ThinkingBlock reasoning={message.reasoning} />
              ) : null}
            </>
          )}
        </div>
        <AnimatePresence>
          {copied ? (
            <motion.span
              key="copied"
              data-testid="thread-line-copied"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.18 }}
              className="pointer-events-none absolute -top-2 right-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-black"
            >
              Copied
            </motion.span>
          ) : null}
        </AnimatePresence>
      </>
    );
  return (
    <motion.div
      ref={lineRef}
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
      {/* Bubble + its click-to-reveal action row stack vertically, aligned to the
          turn's side (#10713). */}
      <div
        className={cn(
          "flex max-w-[80%] flex-col gap-1",
          isUser ? "items-end" : "items-start",
        )}
      >
        {bubbleInteractive ? (
          // biome-ignore lint/a11y/useSemanticElements: The message bubble can contain rich assistant content with nested controls; a native button wrapper would be invalid HTML.
          <div
            {...(copyHandlers ?? {})}
            role="button"
            tabIndex={0}
            aria-label={
              revealed ? "Hide message actions" : "Show message actions"
            }
            aria-expanded={revealed}
            onClick={handleBubbleClick}
            onKeyDown={handleBubbleKeyDown}
            className={bubbleClassName}
            data-proactive-suggestion={isSuggestion ? "true" : undefined}
          >
            {bubbleContent}
          </div>
        ) : (
          <div
            {...(copyHandlers ?? {})}
            className={bubbleClassName}
            data-proactive-suggestion={isSuggestion ? "true" : undefined}
          >
            {bubbleContent}
          </div>
        )}
        {revealed && !editing && hasActions ? (
          <div
            data-testid="thread-line-actions"
            className={cn(
              "flex items-center gap-1.5",
              isUser ? "pr-1" : "pl-1",
            )}
          >
            {canRowCopy ? (
              <ThreadLineActionButton
                label={rowCopied ? "Copied" : "Copy"}
                testId="thread-line-copy"
                icon={
                  rowCopied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )
                }
                onClick={handleRowCopy}
                active={rowCopied}
              />
            ) : null}
            {canSpeak ? (
              <ThreadLineActionButton
                label={speaking ? "Stop" : "Play audio"}
                testId="thread-line-speak"
                icon={
                  speaking ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )
                }
                onClick={handleSpeak}
                active={speaking}
              />
            ) : null}
            {canEdit ? (
              <ThreadLineActionButton
                label="Edit"
                testId="thread-line-edit"
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={openEditor}
              />
            ) : null}
          </div>
        ) : null}
        {/* Retry a recoverable failure by re-sending the preceding user turn.
            Always visible on the failed turn (not gated behind the reveal row)
            so a stalled turn isn't a dead end the user has to retype. */}
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
});

/**
 * Render a settled `ThreadLine` exactly as the overlay does (floating, with copy
 * + settings handlers, reasoning shown). Test-only seam for the component-tree
 * render-parity contract (render-parity.contract.test.tsx, #9954), which diffs
 * this surface's structure against ChatView's MessageContent over a shared
 * corpus, and for the proactive-suggestion affordance unit test (#8792 —
 * optional accept/dismiss handlers). Not part of the public overlay API — keep
 * usage to those tests.
 */
export function __renderThreadLineForParity(
  message: ShellMessage,
  handlers?: {
    onAcceptSuggestion?: (message: ShellMessage) => void;
    onDismissSuggestion?: (messageId: string) => void;
  },
): React.JSX.Element {
  return (
    <ThreadLine
      message={message}
      floating
      onCopy={() => {}}
      onOpenSettings={() => {}}
      onAcceptSuggestion={handlers?.onAcceptSuggestion}
      onDismissSuggestion={handlers?.onDismissSuggestion}
    />
  );
}

export function ContinuousChatOverlay({
  controller,
  agentName = "Eliza",
  slash: slashProp,
  firstRunOpen = false,
}: {
  controller: ShellController;
  /** Name shown in the composer placeholder ("Ask {agentName}"). Defaults to Eliza. */
  agentName?: string;
  /** Universal slash-command catalog + app-level nav effects. */
  slash?: SlashCommandController;
  /**
   * True while in-chat first-run onboarding is active (`firstRunComplete ===
   * false` upstream). The overlay opens to FULL and LOCKS there: every
   * collapse path (Escape, outside tap, grabber pull-down/close, header
   * launcher) is a no-op and the composer (text, attach, voice, send) is
   * disabled, so the seeded choice/OAuth widgets are the only input. On the
   * falling edge — onboarding just completed — the sheet auto-collapses to the
   * input bar, revealing the home screen.
   */
  firstRunOpen?: boolean;
}): React.JSX.Element {
  const {
    messages,
    phase,
    responding,
    turnStatus,
    send,
    canSend,
    recording,
    startRecording,
    stopRecording,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft,
    needsAudioUnlock,
    unlockAudio,
    openSettings,
    navigateHome,
    currentTab,
    clearConversation,
    stop,
    speak,
    stopSpeaking,
    speaking,
  } = controller;
  // True once the server has reported no LLM/model provider is configured (a
  // `no_provider` assistant turn). Defaulted for minimal mock controllers.
  const noProviderConfigured = controller.noProviderConfigured ?? false;
  // Defensive default so a minimal mock controller (stories/tests) that predates
  // the swipe-nav surface still renders without crashing.
  const conversationNav = controller.conversationNav ?? EMPTY_CONVERSATION_NAV;
  // True while a clear/swipe is fetching an uncached thread — gates the empty
  // thread's loading spinner. Defaulted for minimal mock controllers.
  const conversationLoading = controller.conversationLoading ?? false;

  // Horizontal swipe between conversations (#8929). `swipeDx` is the live
  // horizontal drag (+left toward the next/older chat, -right toward the
  // newer/previous chat) and drives the edge hint. The gesture defers pointer
  // capture until a horizontal commit, so vertical thread scrolling is
  // unaffected; it is only bound while the sheet is open (below).
  const [swipeDx, setSwipeDx] = React.useState(0);
  // Frame-budget telemetry scoped to the swipe gesture (#9954): begin sampling
  // on the first live drag and flush a dropped-frame/p95/fps summary into the
  // telemetry ring on release, so swipe jank is observable without the dev HUD.
  const swipeJank = useConversationSwipeJank();
  const conversationSwipe = usePullGesture({
    onDragX: (dx) => {
      // A non-zero offset means the gesture is actively dragging; 0 is the
      // settle/cancel reset the gesture emits on release. `begin` is idempotent,
      // so calling it every frame only starts one sampling window per gesture.
      if (dx !== 0) swipeJank.begin();
      else swipeJank.end();
      setSwipeDx(dx);
    },
    onSwipeLeft: () => {
      setSwipeDx(0);
      // A mouse highlight drag inside a bubble finishes here too; never switch
      // the conversation out from under a live text selection (destroying it).
      // Mirrors the ThreadLine tap-reveal selection guard.
      if (hasLiveTextSelection()) {
        swipeJank.end();
        return;
      }
      // Tag the flushed window with the committed direction so the ring shows
      // which way a janky swipe went (left → "next", the older conversation).
      swipeJank.end("next");
      conversationNav.goNext();
    },
    onSwipeRight: () => {
      setSwipeDx(0);
      if (hasLiveTextSelection()) {
        swipeJank.end();
        return;
      }
      swipeJank.end("prev");
      conversationNav.goPrev();
    },
  });

  // Copy a message (press-and-hold shortcut + reveal-row Copy). Stable identity
  // so the memoized ThreadLine isn't re-rendered every parent tick.
  const handleCopyMessage = React.useCallback((text: string) => {
    void copyTextToClipboard(text);
  }, []);

  // Which message initiated the current voice playback, so ONLY that bubble
  // shows Stop. The global `speaking` flag alone lit EVERY assistant bubble to
  // "Stop" at once; scope the playing state to the actual source message.
  // Cleared when playback ends (speaking true→false) so a stale id never
  // re-lights an old bubble during the next, unrelated playback.
  const [playingMessageId, setPlayingMessageId] = React.useState<string | null>(
    null,
  );
  const wasSpeakingRef = React.useRef(false);
  React.useEffect(() => {
    if (wasSpeakingRef.current && !speaking) setPlayingMessageId(null);
    wasSpeakingRef.current = speaking;
  }, [speaking]);

  // Play an assistant message aloud from its reveal row (#10713). Toggling: a tap
  // on the message currently playing stops it; any other tap speaks that message
  // (and marks it as the one playing, so only its bubble shows Stop).
  const handleSpeakMessage = React.useCallback(
    (id: string, text: string) => {
      if (speaking && playingMessageId === id) {
        stopSpeaking?.();
        setPlayingMessageId(null);
        return;
      }
      speak?.(text);
      setPlayingMessageId(id);
    },
    [speaking, playingMessageId, speak, stopSpeaking],
  );

  // Save an edited user message and resend it as a new turn (#10713) — the same
  // send path a typed turn uses, so the agent sees the corrected text.
  const handleEditResend = React.useCallback(
    (text: string) => {
      send(text);
    },
    [send],
  );

  // Retry a failed/interrupted assistant turn by re-sending its preceding user
  // turn — the SAME send() path the edit-resend action uses. (The ShellController
  // exposes no handleChatRetry, so the overlay owns the walk-back locally; a
  // truncating in-place retry would require a controller method we don't have.)
  // Reads the live message list through a ref so the callback keeps a stable
  // identity and the memoized ThreadLine isn't re-rendered on every tick.
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const handleRetry = React.useCallback(
    (assistantId: string) => {
      const list = messagesRef.current;
      const assistantIdx = list.findIndex(
        (m) => m.id === assistantId && m.role === "assistant",
      );
      if (assistantIdx < 0) return;
      for (let i = assistantIdx - 1; i >= 0; i -= 1) {
        if (list[i].role === "user") {
          const retryText = list[i].content.trim();
          if (retryText) send(retryText);
          return;
        }
      }
    },
    [send],
  );

  // Proactive suggestions (#8792) — same semantics as the composite ChatView:
  // dismiss removes the bubble from the live transcript only (the server-side
  // per-surface cooldown keeps the same offer from immediately re-appearing);
  // accept ("Do it") sends the implied action as a real turn through the SAME
  // send() path an edit-resend uses, then clears the bubble.
  const { removeConversationMessage } = useConversationMessages();
  const handleDismissSuggestion = React.useCallback(
    (messageId: string) => {
      removeConversationMessage(messageId);
    },
    [removeConversationMessage],
  );
  const handleAcceptSuggestion = React.useCallback(
    (m: ShellMessage) => {
      send("Yes, let's do it.");
      removeConversationMessage(m.id);
    },
    [send, removeConversationMessage],
  );

  const slash = slashProp ?? EMPTY_SLASH_CONTROLLER;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  const [draft, setDraft] = React.useState("");
  // Per-conversation composer draft persistence — the SAME localStorage-backed
  // store the desktop ChatView surface uses (readChatDraft/writeChatDraft via
  // useChatComposerDraftPersistence), keyed by the active conversation id. This
  // closes the platform gap where only ChatView restored a draft: on the ambient
  // overlay (mobile/web/default-desktop) a draft typed here now survives a reload
  // / navigation and follows the conversation across surfaces. Restore fires on
  // mount and on a conversation-id change; the persist is debounced. It coexists
  // with the prefill (CHAT_PREFILL / assistant-launch) and dictation paths: those
  // setDraft() edits are persisted like any keystroke, and restore only fires on a
  // conversation-id change — so a just-prefilled composer is never clobbered. The
  // successful-send path clears it (below).
  const activeConversationId = conversationNav.activeId;
  // Draft HANDOFF on conversation switch (mirrors ChatView's
  // handleSelectConversation fix in useChatCallbacks): swiping A→B must repaint
  // the composer for the TARGET. Flush the LEAVING conversation's in-progress
  // text under ITS OWN key first (the debounced persister's pending timer is
  // cancelled by the id change, so a fast edit would otherwise be lost), then
  // restore the target's own saved draft — or CLEAR the composer when it has
  // none. The explicit `?? ""` clear is load-bearing: the persistence hook's
  // restore only sets when a saved draft EXISTS, so without the clear a
  // draftless target inherits the previous conversation's composer text, which
  // the debounced persister then saves under the TARGET's key — the half-typed
  // message silently re-homes to (and would send to) the wrong conversation.
  //
  // The persistence hook is keyed by `persistedConversationId`, which trails
  // `activeConversationId` by exactly this handoff commit — so the hook never
  // observes the (new id, old conversation's draft) combination and never even
  // schedules a write of the old text under the new key. Exactly one
  // steady-state persistence path (the hook) remains; this effect only adds
  // the one-shot switch-time flush + repaint the hook cannot do.
  //
  // Both null transitions are deliberate no-repaints: on boot (null → id) the
  // composer may already hold a prefill (CHAT_PREFILL / assistant-launch) that
  // must NOT be clobbered, and on id → null there is no target to paint.
  const [persistedConversationId, setPersistedConversationId] = React.useState<
    string | null
  >(activeConversationId);
  // Live handle to the draft so the handoff effect keys off the id change
  // alone (a keystroke never re-runs it), same pattern as messagesRef above.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  React.useLayoutEffect(() => {
    if (persistedConversationId === activeConversationId) return;
    if (persistedConversationId !== null) {
      writeChatDraft(persistedConversationId, draftRef.current);
      if (activeConversationId !== null) {
        setDraft(readChatDraft(activeConversationId) ?? "");
      }
    }
    setPersistedConversationId(activeConversationId);
  }, [activeConversationId, persistedConversationId]);
  useChatComposerDraftPersistence({
    activeConversationId: persistedConversationId,
    chatInput: draft,
    setChatInput: setDraft,
  });
  // Live handle to the active conversation id for the send path's draft clear,
  // so submitText / pickSuggestion keep their stable identities.
  const activeConversationIdRef = React.useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  // The active view can take over the composer: override the placeholder and
  // receive the live draft (e.g. Help uses the chat as its search box).
  const viewChatBinding = useViewChatBinding();
  // Escape dismisses the slash menu without clearing the draft; typing reopens.
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  // The chat-history sheet: closed (composer + grabber) ↔ open (full scrollable
  // history). The ONLY open/close driver — opened by a pull-up drag, by focusing
  // the composer, or by sending; closed by a pull-down drag or Escape. Never by
  // click-out, scroll, or blur.
  // The sheet's vertical position is ONE ordinal — the single source of truth for
  // how far the chat is open: `input` (composer-only) → `half` (reading
  // height) → `full` (near-fullscreen). `sheetOpen`/`expanded` are derived
  // read-only views so the two can never disagree (no impossible "open but not
  // open" combos). `pilled` sits BELOW input; `maximized` drops the inset at full.
  // Grabber pulls step through the detents (each cross haptics); programmatic
  // opens (send/focus) go full.
  // ONE openness state machine (see ChatMode). pilled / sheetOpen / expanded /
  // detent are all DERIVED from it — so the impossible "open but not open" or
  // pilled-and-full combos can't exist and no transition has to hand-sync two
  // separate states (which is what bred the old stuck states).
  const [mode, setMode] = React.useState<ChatMode>(
    firstRunOpen ? "full" : "input",
  );
  // The pin-at-full + auto-collapse edge effect lives below `goToDetent` (it
  // needs the detent animator); the mount state above still opens FULL first.
  //
  // During onboarding the sheet MUST stay open — the seeded greeting + choices
  // are the only way forward and the composer is frozen behind them. Deriving
  // openness from the effect alone proved raceable on a home-view boot (the
  // sheet could settle collapsed with the options hidden behind the grabber and
  // only a misleading "tap an option above" hint showing). Pin it STRUCTURALLY:
  // while firstRunOpen, the derived openness is always FULL regardless of the
  // underlying `mode` transition state. The effect still drives the real `mode`
  // so the falling edge (onboarding done) collapses correctly.
  const effectiveMode: ChatMode = firstRunOpen ? "full" : mode;
  const pilled = effectiveMode === "pill";
  const sheetOpen = effectiveMode === "half" || effectiveMode === "full";
  const expanded = effectiveMode === "full";
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
  // dismissing the keyboard (tap the handle, tap the scrim, tap outside) returns
  // to the prior resting state (collapsed → input) instead of leaving the sheet
  // hanging open, while a sheet that was ALREADY open before focus stays open.
  const preFocusCollapsedRef = React.useRef(true);
  // Snapshot of "was the composer focused (keyboard up) at the last pointerdown".
  // The browser can auto-blur the input between a scrim pointerdown and its
  // click, so the scrim's click handler can't read live focus — it reads this to
  // tell a FIRST tap (keyboard up → just dismiss + restore) from a SECOND tap
  // (keyboard already down → close the chat).
  const composerFocusedAtPressRef = React.useRef(false);
  const outsideSheetPointerRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    composerFocusedAtPress: boolean;
    dragged: boolean;
  } | null>(null);
  const suppressNextOutsideClickRef = React.useRef(false);
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
  // Imperative animations triggered from gesture callbacks are outside React's
  // effect cleanup, so keep one owner per motion value and stop stale springs
  // before starting another.
  const threadAnimationRef = React.useRef<MotionControls | null>(null);
  const openProgressAnimationRef = React.useRef<MotionControls | null>(null);
  const delayedNavigationTimerRef = React.useRef<number | null>(null);
  const prefillFocusFrameRef = React.useRef<number | null>(null);
  const prefillFocusTimerRef = React.useRef<number | null>(null);
  const stopThreadAnimation = React.useCallback(() => {
    threadAnimationRef.current?.stop();
    threadAnimationRef.current = null;
  }, []);
  const stopOpenProgressAnimation = React.useCallback(() => {
    openProgressAnimationRef.current?.stop();
    openProgressAnimationRef.current = null;
  }, []);
  const animateThreadHeight = React.useCallback(
    (target: number) => {
      stopThreadAnimation();
      threadAnimationRef.current = animate(threadHeight, target, SHEET_SPRING);
    },
    [stopThreadAnimation, threadHeight],
  );
  const animateOpenProgress = React.useCallback(
    (target: number) => {
      stopOpenProgressAnimation();
      openProgressAnimationRef.current = animate(
        openProgress,
        target,
        OPEN_SPRING,
      );
    },
    [openProgress, stopOpenProgressAnimation],
  );
  const clearPrefillFocusSchedule = React.useCallback(() => {
    if (
      prefillFocusFrameRef.current !== null &&
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(prefillFocusFrameRef.current);
    }
    if (
      prefillFocusTimerRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(prefillFocusTimerRef.current);
    }
    prefillFocusFrameRef.current = null;
    prefillFocusTimerRef.current = null;
  }, []);
  React.useEffect(
    () => () => {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      if (delayedNavigationTimerRef.current !== null) {
        window.clearTimeout(delayedNavigationTimerRef.current);
        delayedNavigationTimerRef.current = null;
      }
      if (layoutShiftIntentTimerRef.current !== null) {
        window.clearTimeout(layoutShiftIntentTimerRef.current);
        layoutShiftIntentTimerRef.current = null;
      }
      overlayRef.current?.removeAttribute(LAYOUT_SHIFT_INTENT_ATTR);
      clearPrefillFocusSchedule();
    },
    [stopThreadAnimation, stopOpenProgressAnimation, clearPrefillFocusSchedule],
  );
  // Latest `settleDrag` (defined below) exposed to the viewport-resize effect
  // (which runs earlier). A rotation can orphan an in-flight drag — re-settling
  // the morph keeps the pill↔input crossfade from stranding both bars visible.
  const settleDragRef = React.useRef<(() => void) | null>(null);
  const draggingRef = React.useRef(false);
  // At rest the collapsed composer should not carry hidden transcript/header
  // DOM. During an upward pull, though, the sheet needs a mounted body so the
  // MotionValue-driven height can follow the finger before the release commits
  // to an open detent. This boolean changes only at gesture boundaries; the
  // per-frame drag still stays outside React.
  const [dragPreviewVisible, setDragPreviewVisible] = React.useState(false);
  const dragPreviewVisibleRef = React.useRef(false);
  const setDragPreviewMounted = React.useCallback((visible: boolean) => {
    if (dragPreviewVisibleRef.current === visible) return;
    dragPreviewVisibleRef.current = visible;
    setDragPreviewVisible(visible);
  }, []);
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
  // The transcript's inner content wrapper — measured to size the onboarding
  // sheet to its content (grow-from-the-bottom) instead of a tall empty panel.
  const threadContentRef = React.useRef<HTMLDivElement>(null);
  const layoutShiftIntentTimerRef = React.useRef<number | null>(null);
  const markLayoutShiftIntent = React.useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || typeof window === "undefined") return;
    overlay.setAttribute(
      LAYOUT_SHIFT_INTENT_ATTR,
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );
    if (layoutShiftIntentTimerRef.current !== null) {
      window.clearTimeout(layoutShiftIntentTimerRef.current);
    }
    layoutShiftIntentTimerRef.current = window.setTimeout(() => {
      layoutShiftIntentTimerRef.current = null;
      overlayRef.current?.removeAttribute(LAYOUT_SHIFT_INTENT_ATTR);
    }, 180);
  }, []);
  // Publish the RESTING composer footprint to --eliza-continuous-chat-clearance
  // so content below (home widgets, launcher tiles) always reserves exactly the
  // space the collapsed composer occupies. Without this the var was never set —
  // every surface rode the 5.25rem fallback, which a multi-line draft or pending
  // attachments overgrow, letting the composer cover content. Only measured
  // while collapsed: an expanded/full sheet covers the screen, so its height
  // must NOT become the reserved clearance.
  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const panel = panelRef.current;
    const root = document.documentElement;
    if (sheetOpen) return; // Keep the last resting value while the sheet is open.
    if (!panel) return;
    const publish = () => {
      const h = panel.getBoundingClientRect().height;
      if (h > 0)
        root.style.setProperty(
          "--eliza-continuous-chat-clearance",
          `${Math.ceil(h)}px`,
        );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [sheetOpen]);
  // The composer content (textarea + thread). Held so we can imperatively clear
  // its `inert` (set while pilled) the instant the pill is tapped open, before
  // React re-renders — iOS only raises the keyboard for a focus() that lands on
  // a non-inert element synchronously inside the originating tap gesture.
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Set for one focus() when we open the pill to the bare input bar: that focus
  // is only there to raise the iOS keyboard and must NOT trip the focus→expand
  // that the normal "tap the visible composer" path relies on (which would
  // fling a history thread open to half instead of resting on the input bar).
  const suppressExpandOnFocusRef = React.useRef(false);
  // A focus→expand that found nothing revealable yet (the boot race: composer
  // focused while the restored conversation's messages are still in flight)
  // parks its intent here. The reveal-edge effect below honors it — but only
  // while the composer is STILL focused — so focusing the composer opens the
  // chat even when the focus wins the race against the thread load. Consumed
  // on every reveal edge so a stale intent can never fling the sheet open long
  // after the user has moved on.
  const pendingExpandOnRevealRef = React.useRef(false);
  const focusThreadRef = React.useRef(false);
  // Recomputed only when the thread or phase changes — NOT on every drag/draft
  // re-render. Pure windowing (empty-turn filter + most-recent cap, with the
  // streaming-assistant exception) lives in shell-state so it's unit-tested.
  const visibleMessages = React.useMemo(
    () => selectVisibleShellMessages(messages, phase),
    [messages, phase],
  );
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values are the event keys for transient layout-motion intent.
  React.useEffect(() => {
    markLayoutShiftIntent();
  }, [
    visibleMessages.length,
    lastId,
    lastContent,
    responding,
    turnStatus?.kind,
    turnStatus?.label,
    turnStatus?.actionName,
    turnStatus?.toolName,
    markLayoutShiftIntent,
  ]);

  // The last line id the scroll effect pinned to — lets it tell a NEW line
  // (always pin to bottom) from streaming growth of the current line (follow
  // only when the reader is already at the bottom).
  const scrollPinnedIdRef = React.useRef(lastId);

  // Topic grouping + chips bar (#8928). Derived from the per-message Stage-1
  // topic tags; when no message is tagged the transcript renders flat (the
  // chips bar and groups simply don't appear), preserving the prior behavior.
  const channelTopics = React.useMemo(
    () => deriveChannelTopics(visibleMessages),
    [visibleMessages],
  );
  const topicSegments = React.useMemo(
    () => groupMessagesByTopic(visibleMessages),
    [visibleMessages],
  );
  const hasTopics = channelTopics.length > 0;
  const [collapsedTopics, setCollapsedTopics] = React.useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const setTopicCollapsed = React.useCallback(
    (key: string, collapsed: boolean) => {
      setCollapsedTopics((prev) => {
        if (collapsed === prev.has(key)) return prev;
        const next = new Set(prev);
        if (collapsed) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [],
  );
  // Tapping a chip expands its group and scrolls its header into view.
  const scrollToTopic = React.useCallback((topic: string) => {
    setCollapsedTopics((prev) => {
      if (!prev.has(topic)) return prev;
      const next = new Set(prev);
      next.delete(topic);
      return next;
    });
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(topic)
          : topic.replace(/"/g, '\\"');
      const el = threadRef.current?.querySelector(`[data-topic="${escaped}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);
  // Render one transcript line; shared by the flat and topic-grouped paths so
  // the in-flight-turn detection stays identical.
  const renderThreadLine = React.useCallback(
    (m: ShellMessage, index: number) => {
      const isLastAssistant =
        index === visibleMessages.length - 1 && m.role === "assistant";
      const isInFlight = isLastAssistant && !m.content.trim();
      return (
        <ThreadLine
          key={m.id}
          message={m}
          floating
          reduce={reduce}
          onCopy={handleCopyMessage}
          onSpeak={handleSpeakMessage}
          onEdit={handleEditResend}
          onRetry={handleRetry}
          speaking={speaking && playingMessageId === m.id}
          onOpenSettings={openSettings}
          turnStatus={isInFlight ? turnStatus : undefined}
          suppressReasoning={responding && isLastAssistant}
          onAcceptSuggestion={handleAcceptSuggestion}
          onDismissSuggestion={handleDismissSuggestion}
        />
      );
    },
    [
      visibleMessages.length,
      reduce,
      handleCopyMessage,
      handleSpeakMessage,
      handleEditResend,
      handleRetry,
      speaking,
      playingMessageId,
      openSettings,
      responding,
      turnStatus,
      handleAcceptSuggestion,
      handleDismissSuggestion,
    ],
  );

  const booting = phase === "booting";
  const listening = phase === "listening";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;

  // `booting` (= `phase === "booting"`) is true whenever the agent isn't ready
  // YET — including first paint before the status fetch resolves, even for a
  // warm agent. So require it to hold past BOOT_BANNER_GRACE_MS before showing
  // the banner: a warm agent flips ready within a frame and never crosses it.
  const [showBootBanner, setShowBootBanner] = React.useState(false);
  React.useEffect(() => {
    if (!booting) {
      setShowBootBanner(false);
      return;
    }
    const id = window.setTimeout(
      () => setShowBootBanner(true),
      BOOT_BANNER_GRACE_MS,
    );
    return () => window.clearTimeout(id);
  }, [booting]);

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
  // Coalesces the per-token streaming-follow scroll into one rAF so a burst of
  // tokens landing within a frame triggers at most one measure+write instead of
  // a forced reflow per token. New-line / first-open pins stay synchronous below.
  const followRafRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (followRafRef.current != null)
        cancelAnimationFrame(followRafRef.current);
    },
    [],
  );
  const threadPresented = sheetOpen || dragPreviewVisible;

  // biome-ignore lint/correctness/useExhaustiveDependencies: lastId/lastContent/sheetOpen/dragPreviewVisible are the triggers; the body reads refs
  React.useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const isNewLine = lastId !== scrollPinnedIdRef.current;
    scrollPinnedIdRef.current = lastId;

    if (!sheetOpen) {
      wasOpenRef.current = false;
      if (dragPreviewVisible) el.scrollTop = el.scrollHeight;
      return;
    }

    // OPEN: jump to the bottom on first open; a NEW line re-pins (smooth); while
    // already resting at the bottom, follow streaming growth — but never yank a
    // reader who has scrolled up to read history. Direct scrollTop assignment is
    // more reliable than scrollIntoView inside this clipped flex column.
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;

    // New line or first open: pin synchronously (pre-paint) so the thread never
    // flashes at the top. Infrequent — once per turn, not per token.
    if (isNewLine || justOpened) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      // Pin to the latest line ONLY on first open, or when the reader is already
      // resting at the bottom. If they have scrolled UP to read history, a new
      // line must NOT yank them down — the previous code force-pinned on every
      // new line (the `else` ran whenever !atBottom), which is exactly the
      // "scroll up to the first message and get snapped back to the bottom" bug.
      if (justOpened || atBottom) {
        if (isNewLine && !justOpened && !reduce) {
          endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        } else {
          el.scrollTop = el.scrollHeight;
        }
      }
      if (justOpened && focusThreadRef.current) {
        el.focus();
        focusThreadRef.current = false;
      }
      return;
    }

    // Streaming growth of the current line: coalesce the bottom-follow into a
    // single rAF (measure atBottom + write scrollTop at most once per frame).
    // Same semantics as before — only follows when the reader is at the bottom.
    if (followRafRef.current != null) return;
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = null;
      const node = threadRef.current;
      if (!node) return;
      const atBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      if (atBottom) node.scrollTop = node.scrollHeight;
    });
  }, [lastId, lastContent, sheetOpen, dragPreviewVisible]);

  // Send `text` (and optional images) through the normal chat pipeline, clearing
  // the composer. Shared by the send button, the slash menu (agent commands),
  // and suggestion taps.
  const submitText = React.useCallback(
    (text: string, images: ImageAttachment[] = []) => {
      const trimmed = text.trim();
      // An image-only turn is valid; only bail when there's nothing to send.
      if ((!trimmed && images.length === 0) || !canSend) return;
      // During onboarding the transcript is choice-driven: free text never
      // reaches the server. The composer controls are disabled too — this
      // guards the event-driven entry points (prefill, dictation, slash).
      if (firstRunOpen) return;
      // Successful submit: drop the persisted draft for this conversation NOW
      // (not just via the debounced persist of the now-empty draft) so a reload
      // in the debounce window can't restore an already-sent draft.
      clearChatDraft(activeConversationIdRef.current);
      // A bound view (e.g. the coding cockpit when a session is focused) can
      // claim the send to drive its OWN target instead of the host agent. If it
      // consumes the text, clear the composer and stop — do not fall through to
      // controller.send. Returns false/undefined → driver mode (host agent).
      // ONLY claim a text-only turn: the binding's onSubmit is text-only, so a
      // turn carrying images must fall through to the host agent (which can send
      // images) rather than have the images silently dropped.
      if (
        trimmed &&
        images.length === 0 &&
        viewChatBinding?.onSubmit?.(trimmed)
      ) {
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        return;
      }
      setDraft("");
      setSlashDismissed(false);
      setPendingImages([]);
      setImageError(null);
      if (images.length) {
        send(trimmed, { images });
      } else {
        send(trimmed);
      }
      // Open the thread to show the conversation + the streaming reply, the same
      // HALF detent focusing/typing uses — NOT a full-screen takeover on every
      // send (that shoved the messages up too high). Keep a taller detent if the
      // user already opened one; clear any free-rest so the height matches.
      setFreeH(null);
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
      // Sending COMMITS to the open chat: a deliberate message means this is now
      // an active conversation, so dismissing the keyboard afterwards keeps the
      // thread open (preFocusCollapsedRef gates that) instead of collapsing the
      // whole conversation back to the bare input bar — even when the chat was
      // opened by tapping the collapsed input.
      preFocusCollapsedRef.current = false;
      detentHaptic();
      inputRef.current?.focus();
    },
    [canSend, firstRunOpen, send, viewChatBinding],
  );

  // Tapping a suggestion sends it immediately (same path as submit), so the
  // strip is a one-tap shortcut, not just a draft pre-fill.
  const pickSuggestion = React.useCallback(
    (text: string) => {
      if (!canSend) return;
      setDraft("");
      clearChatDraft(activeConversationIdRef.current);
      send(text);
      // Open to HALF (conversation above the keyboard), not a full-screen jump.
      setFreeH(null);
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
      detentHaptic();
      inputRef.current?.focus();
    },
    [canSend, send],
  );

  const addImageFiles = React.useCallback((files: FileList | File[]) => {
    void intakeAttachmentFiles(files)
      .then(({ attachments, droppedTooLarge }) => {
        // The overlay is a pure component without an i18n translator, so it
        // surfaces the "kept N, dropped M" notice inline in English (matching
        // its other hardcoded strings) via the existing imageError channel.
        const summary = summarizeDroppedAttachments({
          acceptedCount: attachments.length,
          droppedTooLarge,
          droppedOverCount: [],
        });
        setImageError(
          summary
            ? `Kept ${summary.kept}, dropped ${summary.dropped} (too large — max ${summary.maxMb}MB)`
            : null,
        );
        if (attachments.length) {
          setPendingImages((prev) =>
            [...prev, ...attachments].slice(0, MAX_CHAT_IMAGES),
          );
        }
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
        transcriptionMode ||
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
    [hasDraft, recording, responding, startRecording, transcriptionMode],
  );

  // One funnel for BOTH pointerup (cancelled=false) and pointercancel
  // (cancelled=true). Always clears the pending timer + releases pointer capture
  // FIRST — before any early return — so a quick tap can never leak a stuck timer
  // or a captured pointer (the bug that mis-routed later events).
  const finishPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
      const phase = pttRef.current;
      if (phase.kind === "pending") window.clearTimeout(phase.timer);
      if (
        typeof event.currentTarget.hasPointerCapture === "function" &&
        event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
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
    // While transcribing, the mic is the master voice control: a tap turns the
    // mic OFF, which also ends transcription (mic = parent — turning off the mic
    // turns off transcript). This is distinct from the transcript button, which
    // turns transcript off but LEAVES THE MIC ON. The finished transcript still
    // drops into the composer as an attachment. This OFF path is checked FIRST
    // — never gated on `responding`: a wake-word inline reply (#9880) flips
    // `responding` true while `handsFree` stays false mid-transcription, and
    // gating it left a lit, dead "stop transcription" mic until the reply
    // finished.
    if (transcriptionMode) {
      stopTranscriptionAndMic();
      return;
    }
    // Voice can't be turned ON while a reply is in flight (it's gated until the
    // turn finishes), but an active hands-free session can always be turned OFF.
    if (responding && !handsFree) return;
    // Quick tap = hands-free conversation: the agent speaks its replies back and
    // the mic re-opens after each one. Tap again to end.
    toggleHandsFree();
  }, [
    responding,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    stopTranscriptionAndMic,
  ]);

  const hasThread = visibleMessages.length > 0;
  const hasRevealableThread = hasThread || conversationLoading;

  // Track the VISUAL viewport so the chat sizes to — and sits above — whatever
  // the mobile keyboard leaves visible. `height` shrinks when the keyboard opens
  // (on iOS innerHeight does not, so read visualViewport); `keyboardInset` is how
  // far the keyboard intrudes from the layout bottom, used to lift the whole
  // overlay above it. `bottomPad` is the overlay's own safe-area/nav padding,
  // reserved when bounding the panel height.
  const readViewport = React.useCallback(() => {
    if (typeof window === "undefined")
      return { height: 800, keyboardInset: 0, innerHeight: 800 };
    const vv = window.visualViewport;
    const innerHeight = window.innerHeight;
    const height = vv?.height ?? innerHeight;
    const keyboardInset = vv
      ? Math.max(0, innerHeight - vv.height - vv.offsetTop)
      : 0;
    // innerHeight is the LAYOUT viewport: on Android it shrinks (adjustResize)
    // when the keyboard opens, on iOS (`resize: "body"`) it does not. The lift
    // math below uses that to avoid double-counting the keyboard.
    return { height, keyboardInset, innerHeight };
  }, []);
  const [viewport, setViewport] = React.useState(readViewport);
  const [bottomPad, setBottomPad] = React.useState(0);
  // The real `env(safe-area-inset-top)` in px, so the panel's top clearance
  // reserves the actual notch/Dynamic-Island inset (not a fixed guess) and the
  // header buttons always sit below it. Re-measured on rotation (`resize`); it
  // never changes between resizes, so it stays off the high-rate vv `scroll`.
  const [safeAreaTop, setSafeAreaTop] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const measure = () =>
      setSafeAreaTop((prev) => {
        const next = measureSafeAreaInsetTop();
        return prev === next ? prev : next;
      });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const commit = () => {
      // Bail out of the re-render when the viewport values are unchanged — vv
      // `scroll` fires constantly while the keyboard animates but the height/
      // inset frequently don't actually move between events.
      setViewport((prev) => {
        const next = readViewport();
        return prev.height === next.height &&
          prev.keyboardInset === next.keyboardInset &&
          prev.innerHeight === next.innerHeight
          ? prev
          : next;
      });
      const el = overlayRef.current;
      if (el) {
        const pad = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
        setBottomPad((prev) => (prev === pad ? prev : pad));
      }
    };
    // Coalesce the high-rate vv `scroll` to at most one commit per frame so the
    // keyboard-animation storm can't drive >60 forced style reads + setStates/s.
    let rafId = 0;
    const sync = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        commit();
      });
    };
    // A real WINDOW resize (rotation/desktop resize) must never strand the
    // pill↔input morph mid-crossfade — rotation often cancels the in-flight
    // pointer with no pointerup, leaving the drag orphaned. Re-settle to a clean
    // 0/1 end there. `visualViewport.resize`, however, fires continuously during
    // soft-keyboard animation; settling on those events fights typing, detent
    // drags, and keyboard open/close. For vv resize/scroll, update measurements
    // only and let the current sheet state remain authoritative.
    const syncAndSettleWindow = () => {
      sync();
      settleDragRef.current?.();
    };
    syncAndSettleWindow();
    const vv = window.visualViewport;
    window.addEventListener("resize", syncAndSettleWindow);
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync, { passive: true });
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", syncAndSettleWindow);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, [readViewport]);
  const viewportH = viewport.height;
  const keyboardInset = viewport.keyboardInset;

  // iOS keyboard avoidance. With Capacitor `resize:"body"`, the software
  // keyboard shrinks the BODY but NOT the visual viewport's relationship to a
  // `position: fixed` element, and the visualViewport delta above frequently
  // reads 0 — so `keyboardInset` alone can't lift the fixed composer and it
  // ends up hidden BEHIND the keyboard (reported on device + simulator).
  // Subscribe to the Capacitor Keyboard plugin for the authoritative keyboard
  // height and lift by whichever inset is larger.
  const [nativeKeyboardHeight, setNativeKeyboardHeight] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    const handles: Array<{ remove: () => void }> = [];
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => {
        if (cancelled) return;
        void Keyboard.addListener("keyboardWillShow", (info) => {
          setNativeKeyboardHeight(info?.keyboardHeight ?? 0);
        })
          .then((handle) => {
            if (cancelled) handle.remove();
            else handles.push(handle);
          })
          .catch(() => {});
        void Keyboard.addListener("keyboardWillHide", () => {
          setNativeKeyboardHeight(0);
        })
          .then((handle) => {
            if (cancelled) handle.remove();
            else handles.push(handle);
          })
          .catch(() => {});
      })
      .catch(() => {
        // Web / non-native: no Keyboard plugin; visualViewport handles it.
      });
    return () => {
      cancelled = true;
      for (const handle of handles) handle.remove();
    };
  }, []);
  // Track the layout-viewport height with the keyboard DOWN. On Android the
  // WebView window shrinks (adjustResize) when the keyboard opens, so the fixed
  // overlay's `bottom: 0` already rises with it; on iOS (`resize: "body"`) the
  // layout height is unchanged and the fixed composer stays behind the keyboard.
  const baseInnerHeightRef = React.useRef(viewport.innerHeight);
  React.useEffect(() => {
    if (nativeKeyboardHeight === 0) {
      baseInnerHeightRef.current = viewport.innerHeight;
    }
  }, [nativeKeyboardHeight, viewport.innerHeight]);

  // Lift the composer above the keyboard by ONLY the part the layout didn't
  // already absorb. On Android the window shrank by ~the keyboard height
  // (layoutShrink ≈ keyboardHeight), so the extra native lift is ~0 — without
  // this the chat double-counts and jumps a whole keyboard height too high. On
  // iOS the layout doesn't shrink (layoutShrink = 0), so the full native height
  // lifts the fixed composer above the keyboard. Web (no native plugin) keeps
  // the visualViewport-derived inset.
  const layoutShrink = Math.max(
    0,
    baseInnerHeightRef.current - viewport.innerHeight,
  );
  const nativeLift = Math.max(0, nativeKeyboardHeight - layoutShrink);
  const effectiveKeyboardInset = Math.max(keyboardInset, nativeLift);
  const keyboardLiftActive = effectiveKeyboardInset > 0;

  // FULL-SCREEN derived gate: maximized only takes effect AT the full detent, so
  // a stale flag can never leak into half/collapsed/pill. Drives the edge-to-edge
  // panel styles + a zero top margin.
  const fullBleed = maximized && expanded && sheetOpen && !pilled;

  // Top clearance + max height come from the pure, unit-tested layout solver.
  // It reserves the real measured notch inset (`safeAreaTop`) above the panel,
  // and — critically — subtracts any keyboard lift the visual viewport did NOT
  // report (the iOS Capacitor `resize:"body"` case where `keyboardInset` reads 0
  // but the native Keyboard plugin still lifted the overlay): without that, the
  // panel is sized against the full height while ALSO being pushed up by the
  // keyboard, so its top edge — the header buttons — shoots above the notch and
  // off-screen. Full-bleed drops the top margin + the overlay's bottom padding
  // so the maximized panel fills the screen edge-to-edge.
  const { panelMaxH } = resolveChatPanelLayout({
    viewportH,
    bottomPad,
    keyboardInset,
    effectiveKeyboardInset,
    safeAreaTopPx: safeAreaTop,
    fullBleed,
  });

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
    (h: number) => threadPresented && !pilled && (fullBleed || h >= halfH - 1),
    [threadPresented, pilled, fullBleed, halfH],
  );
  const [headerVisible, setHeaderVisible] = React.useState(false);
  useMotionValueEvent(threadHeight, "change", (h) => {
    markLayoutShiftIntent();
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
  // At rest (threadHeight 0 = INPUT/CLOSED) the full-viewport dimming scrim sits
  // at opacity 0. Drive `visibility` off the SAME motion value so it drops out
  // of compositing/paint at rest (no reflow, compositor-only, zero re-render) and
  // flips back the instant the thread opens.
  const scrimVisibility = useTransform(threadHeight, (h) =>
    h > 0 ? "visible" : "hidden",
  );
  const suggestionsOpacity = useTransform(threadHeight, (h) =>
    Math.max(0, 1 - h / Math.max(1, openH * 0.5)),
  );
  const threadFlexBasis = useTransform(threadHeight, (h) => `${h}px`);
  // Corner radius tracks the live height with real pixel radii. `9999px` works
  // for a static pill, but while the panel grows the browser keeps reclamping it
  // against the changing box, so the corners visibly swim before snapping to the
  // sheet radius. A 32px radius still renders as a capsule for the collapsed
  // composer, then relaxes gradually into the open sheet.
  const panelRadius = useTransform(threadHeight, [0, 160], [32, 24], {
    clamp: true,
  });
  // --- Liquid-glass pill → input morph (driven by openProgress) ---------------
  // The panel is ONE persistent element; the pill capsule and the full
  // input crossfade by opacity (compositor-cheap) while the whole panel scales
  // up from a capsule. transform + opacity only.
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
  // Grabber clearance: when the chat is OPEN but BELOW the half detent the header
  // is hidden, so the thread viewport would start at the panel's very top —
  // tucking the topmost line under the floating drag handle (a partial bubble
  // pinned beneath the grabber at a small free-rest height). Inset the thread
  // down by the grabber's height in that window only: 0 in the collapsed state
  // (threadHeight ~0, so the closed input bar stays exactly its own height),
  // ramping to the inset once a thread is actually open, then back to 0 as the
  // header reveals at half+ (it provides the clearance itself).
  const threadGrabberClearance = useTransform(
    threadHeight,
    [0, 40, halfH - 64, halfH],
    [0, 20, 20, 0],
    { clamp: true },
  );
  // The glass should lead the gesture; transcript content fades in only after
  // there is enough vertical space to avoid clipped bubble slivers during the
  // first few pixels of a pull.
  const threadContentOpacity = useTransform(threadHeight, [72, 128], [0, 1], {
    clamp: true,
  });

  // Sub-threshold release: spring back to the current detent (no state change).
  // Also settles the pill→input morph to its resting end (0 while pilled, 1 once
  // open) so a half-finished pill drag springs cleanly back to the capsule.
  const settleDrag = React.useCallback(() => {
    draggingRef.current = false;
    setDragPreviewMounted(false);
    const open = pilled ? 0 : 1;
    if (reduce) {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      threadHeight.set(baseH);
      openProgress.set(open);
    } else {
      animateThreadHeight(baseH);
      animateOpenProgress(open);
    }
  }, [
    threadHeight,
    openProgress,
    baseH,
    pilled,
    reduce,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
    animateOpenProgress,
    setDragPreviewMounted,
  ]);
  // Keep the ref the (earlier-declared) viewport-resize effect calls pointing at
  // the latest settleDrag, so a rotation re-settles with current pilled/baseH.
  settleDragRef.current = settleDrag;

  // Drive openProgress from the pilled flag for NON-drag transitions (tap the
  // pill, programmatic open/close): a live finger drag owns openProgress itself
  // (draggingRef gates this so it never fights the gesture).
  React.useEffect(() => {
    if (draggingRef.current) return;
    const open = pilled ? 0 : 1;
    if (reduce) {
      stopOpenProgressAnimation();
      openProgress.set(open);
      return;
    }
    animateOpenProgress(open);
    return stopOpenProgressAnimation;
  }, [
    pilled,
    reduce,
    openProgress,
    animateOpenProgress,
    stopOpenProgressAnimation,
  ]);

  const closeSheet = React.useCallback(() => {
    draggingRef.current = false;
    stopOpenProgressAnimation();
    setFreeH(null);
    setMaximized(false);
    setMode("input");
    if (reduce) {
      stopThreadAnimation();
      threadHeight.set(0);
    } else {
      animateThreadHeight(0);
    }
  }, [
    reduce,
    threadHeight,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
  ]);

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
      if (delayedNavigationTimerRef.current !== null) {
        window.clearTimeout(delayedNavigationTimerRef.current);
      }
      delayedNavigationTimerRef.current = window.setTimeout(
        () => {
          delayedNavigationTimerRef.current = null;
          go();
        },
        reduce ? 0 : wasMaximized ? 260 : 190,
      );
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
      stopThreadAnimation();
      setMaximized(false);
      return;
    }
    // Snap the morph fully open BEFORE flipping to full-bleed so no in-flight
    // pill-open spring can leak a sub-1 scale into the maximized frame (top gap).
    draggingRef.current = false;
    stopThreadAnimation();
    stopOpenProgressAnimation();
    openProgress.set(1);
    setFreeH(null);
    setMode("full");
    setMaximized(true);
  }, [maximized, openProgress, stopThreadAnimation, stopOpenProgressAnimation]);

  // The single detent→detent animator: whenever the settled detent (or viewport)
  // changes and we're not mid finger-drag, spring the history height to it. The
  // gesture / open paths just flip sheetOpen/expanded and this reacts — no
  // per-frame React state, so the live drag stays buttery.
  React.useEffect(() => {
    if (draggingRef.current) return;
    if (reduce) {
      stopThreadAnimation();
      threadHeight.set(baseH);
      return;
    }
    animateThreadHeight(baseH);
    return stopThreadAnimation;
  }, [baseH, reduce, threadHeight, animateThreadHeight, stopThreadAnimation]);

  // Snap to one of the three iOS-style detents and settle the live drag. A
  // detent change fires a light haptic so the snap feels physical on device.
  // "collapsed" hides the history entirely (just the input); "half" is the
  // comfortable reading height; "full" the near-fullscreen reading mode.
  const goToDetent = React.useCallback(
    (to: "collapsed" | "half" | "full") => {
      // Flip the settled detent; the [baseH] effect springs the height to it.
      // A detent always clears any free-drag rest height and (since only FULL
      // can be maximized) drops full-bleed when stepping anywhere else.
      draggingRef.current = false;
      setFreeH(null);
      if (to !== "full") setMaximized(false);
      // "collapsed" is the input bar (sheet closed); half/full open the thread.
      setMode(to === "collapsed" ? "input" : to);
      const target = to === "collapsed" ? 0 : to === "half" ? halfH : openH;
      if (reduce) {
        stopThreadAnimation();
        threadHeight.set(target);
      } else {
        animateThreadHeight(target);
      }
      // Stepping all the way down closes the keyboard (the chat is dismissed).
      if (to === "collapsed") inputRef.current?.blur();
      detentHaptic();
    },
    [
      halfH,
      openH,
      reduce,
      threadHeight,
      stopThreadAnimation,
      animateThreadHeight,
    ],
  );

  // First-run onboarding pin + release. While onboarding is active the sheet
  // stays pinned FULL — the seeded greeting/choices must be visible and the
  // chat undismissable (every collapse path below is also gated on
  // `firstRunOpen`). On the FALLING edge — onboarding just completed — auto-
  // collapse to the input bar so the home screen underneath is revealed.
  // Edge-detected via a ref so an ordinary session (onboarding never active)
  // never triggers the collapse.
  const wasFirstRunOpenRef = React.useRef(firstRunOpen);
  React.useEffect(() => {
    const was = wasFirstRunOpenRef.current;
    wasFirstRunOpenRef.current = firstRunOpen;
    if (firstRunOpen) {
      setMode("full");
      return;
    }
    if (was) goToDetent("collapsed");
  }, [firstRunOpen, goToDetent]);

  // Onboarding grows from the BOTTOM: size the sheet to its content (capped at
  // full) via the freeH rest-height seam, so the greeting + choice widget sit
  // just above the composer instead of floating under a tall empty panel. Drags
  // are gated while onboarding, so nothing fights freeH; on completion
  // goToDetent("collapsed") clears it and collapses smoothly. `data-detent`
  // still reports "full" (the pinned-open contract) even when visually shorter.
  // jsdom has no layout (offsetHeight 0), so this no-ops there — the unit tests
  // keep the full-height pin.
  React.useLayoutEffect(() => {
    if (!firstRunOpen || typeof ResizeObserver === "undefined") return;
    const content = threadContentRef.current;
    if (!content) return;
    const measure = () => {
      const h = content.offsetHeight;
      if (h <= 0) return; // not laid out (jsdom) — leave the full-height pin
      const next = Math.min(h + 28, panelMaxH);
      setFreeH((prev) =>
        prev != null && Math.abs(prev - next) < 2 ? prev : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    return () => ro.disconnect();
  }, [firstRunOpen, panelMaxH]);

  const openFromGrabber = React.useCallback(() => {
    if (hasRevealableThread) {
      preFocusCollapsedRef.current = false;
      focusThreadRef.current = true;
      goToDetent("half");
      return;
    }
    inputRef.current?.focus();
  }, [goToDetent, hasRevealableThread]);

  // Collapsing always drops input focus, so the mobile keyboard goes away the
  // moment the chat is dismissed (pull-down, Escape, or click-out) — the chat is
  // no longer "focused". Blurring (rather than the old refocus dance) also means
  // there's no focus→expand bounce to guard against, so the model stays simple.
  const collapse = React.useCallback(() => {
    // Undismissable during onboarding: Escape (document, thread, composer),
    // outside taps, the grabber close, and the sheet-open grabber tap all
    // funnel here — every one is a no-op until first-run completes.
    if (firstRunOpen) return;
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
  }, [closeSheet, firstRunOpen]);

  // Dismiss the keyboard and return to the resting state from BEFORE the composer
  // was focused — the single restore path shared by every "drop the keyboard"
  // gesture (tap the grabber, tap the scrim, tap outside the panel). A sheet that
  // was COLLAPSED before focus re-collapses (back to the input bar); one that was
  // ALREADY OPEN stays open and springs back to its detent size as the keyboard
  // retracts (the viewport grows → the [baseH] effect re-animates the height).
  // Never a surprise full close.
  const dismissKeyboardToPriorState = React.useCallback(() => {
    inputRef.current?.blur();
    if (preFocusCollapsedRef.current) collapse();
  }, [collapse]);

  // The composer overlay floats over every view and survives tab changes, so
  // navigating away from a focused composer (chat → Settings / Home / …) would
  // otherwise leave the textarea holding DOM focus on the new view (its
  // collapsed/resting look is gated on sheet state, not on document focus). On
  // iOS that strands the keyboard input-accessory bar (the ‹ › chevrons +
  // "Done") at the bottom of the screen with no keyboard while the composer
  // reads as inactive. Drop composer focus whenever the active view changes to a
  // non-chat tab; an intentional tap to focus the composer on that view (no tab
  // change) is left untouched. Keyboard.hide() guarantees iOS dismisses the
  // accessory bar, not just the soft keyboard.
  React.useEffect(() => {
    if (currentTab === "chat") return;
    const input = inputRef.current;
    if (
      typeof document === "undefined" ||
      !input ||
      document.activeElement !== input
    ) {
      return;
    }
    input.blur();
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => Keyboard.hide())
      .catch(() => {
        // Web/desktop or no native bridge — blur() above already dropped focus.
      });
  }, [currentTab]);

  // Focusing or typing in the composer opens the chat (keyboard + history) when
  // there's a thread to show. Opens to HALF — the conversation is visible above
  // the keyboard without a full-screen takeover; the maximize button is for that.
  // Remember whether we opened from collapsed so dismissing the keyboard (tap the
  // handle) can return to that prior resting state. Clears any free-rest so the
  // height matches the detent (no stale freeH pinning it below half).
  const expand = React.useCallback(() => {
    if (!hasRevealableThread) {
      // Nothing to reveal YET — don't open an empty sheet, but remember the
      // intent: on boot the composer can gain focus while the restored
      // conversation's messages are still in flight, and dropping the expand
      // here made focus-to-open silently do nothing (#11112). The reveal-edge
      // effect below completes the open once the thread arrives, if the
      // composer is still focused.
      pendingExpandOnRevealRef.current = true;
      return;
    }
    pendingExpandOnRevealRef.current = false;
    preFocusCollapsedRef.current = !sheetOpen;
    setFreeH(null);
    // Open to at least HALF; if already at half/full, keep the taller mode.
    setMode((m) => (m === "half" || m === "full" ? m : "half"));
  }, [hasRevealableThread, sheetOpen]);

  // Reveal edge: the thread just became showable. If a focus→expand was parked
  // while there was nothing to reveal (see expand above), honor it now — but
  // only while the composer is STILL focused, so a long-abandoned focus can't
  // pop the sheet open. The intent is consumed either way (one-shot). A
  // pill-open keyboard-raise never parks an intent (its focus is suppressed
  // before expand runs), so the suppressExpandOnFocusRef contract holds.
  React.useEffect(() => {
    if (!hasRevealableThread || !pendingExpandOnRevealRef.current) return;
    pendingExpandOnRevealRef.current = false;
    if (
      typeof document === "undefined" ||
      document.activeElement !== inputRef.current
    ) {
      return;
    }
    expand();
  }, [hasRevealableThread, expand]);

  // Interactive tour control: the tutorial drives the chat into a clean, known
  // state at the start of each frame (so the spotlight always lands on the right
  // control) and pre-fills the composer for the guided "ask to navigate" demo.
  // Decoupled via a window event so the tour never reaches into these internals.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<TutorialChatControlDetail>).detail;
      if (!detail) return;
      // Defense-in-depth for the onboarding lock: while first-run pins the sheet
      // at FULL, a stray/adversarial tutorial-control event (rest/reset →
      // collapse, prefill → un-pill) must not move it. The tour only starts
      // AFTER completeFirstRun, so this never fires in the real flow — it just
      // closes the one collapse seam outside the gated funnel.
      if (firstRunOpen) return;
      switch (detail.action) {
        case "pill":
          setMode("pill");
          // Leaving FULL without goToDetent: drop full-bleed with it, or the
          // stale `maximized` re-applies on the NEXT return to full (surprise
          // edge-to-edge). Only the FULL detent may be maximized.
          setMaximized(false);
          inputRef.current?.blur();
          break;
        case "rest":
          // goToDetent("collapsed") → input mode, which un-pills.
          goToDetent("collapsed");
          break;
        case "expand":
          goToDetent("full");
          break;
        case "prefill":
          setMode((m) => (m === "pill" ? "input" : m));
          setDraft(detail.text ?? "");
          requestAnimationFrame(() => inputRef.current?.focus());
          break;
        case "reset":
          // Tour ended (cancel / complete): restore a normal interactive chat.
          // A frame may have collapsed it to the pill, where the composer is
          // `inert` — clear inert imperatively (React clears it only on the next
          // render, too late for the stranded input), drop the tour's prefilled
          // draft, and goToDetent("collapsed") un-pills back to the input bar.
          contentRef.current?.removeAttribute("inert");
          setDraft("");
          goToDetent("collapsed");
          break;
      }
    };
    window.addEventListener(TUTORIAL_CHAT_CONTROL_EVENT, onControl);
    return () =>
      window.removeEventListener(TUTORIAL_CHAT_CONTROL_EVENT, onControl);
  }, [goToDetent, firstRunOpen]);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPrefill = (event: Event) => {
      const detail = (event as CustomEvent<ChatPrefillEventDetail>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      if (!text.trim()) return;
      setMode((m) => (m === "pill" ? "input" : m));
      setDraft(text);
      const focusComposer = () => {
        prefillFocusFrameRef.current = null;
        prefillFocusTimerRef.current = null;
        const input = inputRef.current;
        input?.focus();
        if (detail?.select) {
          input?.setSelectionRange(0, text.length);
        }
      };
      clearPrefillFocusSchedule();
      if (typeof window.requestAnimationFrame === "function") {
        prefillFocusFrameRef.current =
          window.requestAnimationFrame(focusComposer);
      } else {
        prefillFocusTimerRef.current = window.setTimeout(focusComposer, 0);
      }
    };
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
  }, [clearPrefillFocusSchedule]);

  // OS assistant / deep-link entry (Siri, Shortcuts, App Actions, the assistant
  // entry point) routes into `#chat?text=…&source=…&voice=1`. On desktop the
  // detached window's ChatView claims it, but the ambient overlay (mobile, web,
  // default desktop bottom-bar) is the ONLY chat surface there — so it must
  // claim the launch payload itself. We PREFILL (never auto-send) the composer:
  // the `text` is attacker-authorable, so the user reviews it and presses send.
  // `claimAssistantLaunchPayloadFromHash` dedupes by launchId and clears the
  // hash, so a re-render / second mount never re-consumes the same launch.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const consumeFromHash = () => {
      const hash = window.location.hash;
      // Read the voice flag off the ORIGINAL hash first — claiming clears the
      // launch params (text/source/action/launchId) but leaves `voice`, and we
      // want the intent regardless of ordering.
      const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
      const wantsVoice = new URLSearchParams(query).get("voice") === "1";
      const payload = claimAssistantLaunchPayloadFromHash(hash, {
        allowedRoutes: ["chat"],
      });
      if (!payload) return;
      setMode((m) => (m === "pill" ? "input" : m));
      setDraft(payload.text);
      // Open the history sheet (no-op when there's no thread yet) and focus the
      // composer so the prefilled text is ready to review + send.
      expand();
      const focusComposer = () => {
        prefillFocusFrameRef.current = null;
        prefillFocusTimerRef.current = null;
        inputRef.current?.focus();
      };
      clearPrefillFocusSchedule();
      if (typeof window.requestAnimationFrame === "function") {
        prefillFocusFrameRef.current =
          window.requestAnimationFrame(focusComposer);
      } else {
        prefillFocusTimerRef.current = window.setTimeout(focusComposer, 0);
      }
      // A `voice=1` launch also starts hands-free voice capture (the same intent
      // a mic tap carries). Only when not already live, so it never toggles an
      // in-progress session off.
      if (wantsVoice && !handsFree && !recording) toggleHandsFree();
    };
    consumeFromHash();
    window.addEventListener("hashchange", consumeFromHash);
    return () => window.removeEventListener("hashchange", consumeFromHash);
  }, [
    clearPrefillFocusSchedule,
    expand,
    handsFree,
    recording,
    toggleHandsFree,
  ]);

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

  // A completed transcription SESSION drops its transcript into the composer as
  // an ATTACHMENT — it does NOT auto-send as a message. The user sends it (with
  // any typed text) when ready; the mic stays on the whole time, so transcribing
  // is an additive layer, not a mode that takes over the conversation. The
  // recording is also archived (Transcript record + audio + knowledge mirror)
  // for the Transcripts view, best-effort and silent.
  React.useEffect(() => {
    setTranscriptSessionSink((segments, startedAtMs, audioWav) => {
      if (segments.length === 0) return;
      const text = transcriptPlainText(segments);
      const stamp = new Date(startedAtMs)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      const attachmentName = `Transcript ${stamp}.md`;
      if (text) {
        const attachment: ImageAttachment = {
          data: textToBase64(text),
          mimeType: "text/markdown",
          name: attachmentName,
        };
        setPendingImages((prev) =>
          [...prev, attachment].slice(0, MAX_CHAT_IMAGES),
        );
        expand();
        inputRef.current?.focus();
      }
      void client
        .createTranscript({
          segments,
          createdAt: startedAtMs,
          ...(audioWav
            ? {
                audioBase64: wavBytesToBase64(audioWav),
                audioContentType: "audio/wav",
              }
            : {}),
        })
        .then(({ transcript }) => {
          // Link the pending attachment to the saved record so tapping it opens
          // the editable viewer and edits persist — both via the client-only
          // `transcriptId` field and a durable marker embedded in the markdown
          // (which survives the server round-trip in the attachment's text).
          if (!text) return;
          setPendingImages((prev) =>
            prev.map((a) =>
              a.name === attachmentName &&
              a.mimeType === "text/markdown" &&
              !a.transcriptId
                ? {
                    ...a,
                    transcriptId: transcript.id,
                    data: textToBase64(
                      withTranscriptMarker(transcript.id, text),
                    ),
                  }
                : a,
            ),
          );
        })
        .catch(() => {
          /* archival is best-effort; a failed save just skips the record */
        });
    });
    return () => setTranscriptSessionSink(null);
  }, [setTranscriptSessionSink, expand]);

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
      // The CommandPalette is a Radix dialog (Z_DIALOG=170) that paints UNDER
      // the open chat glass (Z_SHELL_OVERLAY=9000): opening it from the
      // composer left an invisible, focus-trapped dialog behind the sheet.
      // Collapse first so the palette opens over the pill, fully visible and
      // dismissible; skip the composer refocus so focus stays in the palette.
      const opensPalette =
        exec.kind === "client" &&
        (exec.clientAction === "open-command-palette" ||
          exec.clientAction === "show-commands");
      const openPaletteCollapsed = () => {
        collapse();
        slash.openCommandPalette();
      };
      runSlashExecution(exec, {
        navigateTab: slash.navigateTab,
        navigateSettings: slash.navigateSettings,
        navigateView: slash.navigateView,
        clearChat: slash.clearChat,
        newConversation: () => controller.clearConversation(),
        // The overlay owns full-screen via the `maximized` detent flag, not a
        // controller method, so toggle it directly here.
        toggleFullscreen: toggleMaximize,
        openCommandPalette: openPaletteCollapsed,
        showCommands: openPaletteCollapsed,
        toggleTranscription: toggleTranscriptionMode,
        send: (text) => submitText(text),
      });
      setDraft("");
      setSlashDismissed(true);
      if (!opensPalette) {
        inputRef.current?.focus();
      }
    },
    [
      slash,
      controller,
      submitText,
      toggleMaximize,
      toggleTranscriptionMode,
      collapse,
    ],
  );

  const submit = React.useCallback(() => {
    const shortcut =
      pendingImages.length === 0
        ? resolveClientShortcutExecution(
            slash.commands,
            draft,
            slash.resolveSection,
            {
              allowNatural: slash.naturalShortcutsEnabled,
              resolveChoices: slash.resolveChoices,
            },
          )
        : null;
    if (shortcut) {
      runExecution(shortcut);
      return;
    }
    submitText(draft, pendingImages);
  }, [draft, pendingImages, runExecution, slash, submitText]);

  const pickSlashItem = React.useCallback(
    (index: number) => {
      const exec = slashMenu.resolve(index);
      if (exec) runExecution(exec);
    },
    [slashMenu, runExecution],
  );

  // Whether a document-level pointer landed on one of the overlay's OWN
  // surfaces. CONTRACT: EVERY child of the overlay root counts as INSIDE the
  // chat for the outside-tap detectors below — the glass panel, the grabber,
  // AND the controls that render at the overlay root ABOVE the panel (the
  // audio-unlock chip, the live-transcript strip, the model-status pill). A
  // tap on any of them must never be swallowed as an outside tap nor collapse
  // the sheet; checking only `panelRef` made the audio-unlock chip unreachable
  // while the sheet was open. The single exception is the dimming backdrop:
  // it is pointer-transparent (`pointerEvents: "none"`), so a real tap "on"
  // it always lands on the view behind — an event that names it as target
  // (synthetic/test dispatch) stands in for tapping the dimmed background and
  // stays OUTSIDE.
  const isOverlayControlTarget = React.useCallback(
    (target: EventTarget | null): boolean => {
      if (!(target instanceof Node) || !overlayRef.current?.contains(target)) {
        return false;
      }
      return !(
        target instanceof Element &&
        target.closest('[data-testid="chat-sheet-backdrop"]')
      );
    },
    [],
  );

  // Tapping ANYWHERE outside the chat overlay drops the keyboard: if the
  // composer holds focus and the pointer lands outside the overlay, blur it.
  // This is the iOS-standard "tap the background to dismiss the keyboard"
  // behaviour and works whether the chat is open (over the scrim) or collapsed
  // (over the live view).
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const input = inputRef.current;
      const focused = !!input && document.activeElement === input;
      // Record the keyboard state at PRESS time: the scrim's click handler reads
      // this (focus may be gone by the time the click fires) to tell a first
      // "dismiss the keyboard" tap from a second "close the chat" tap.
      composerFocusedAtPressRef.current = focused;
      // Keyboard already down -> outside taps do nothing here; the grabber,
      // scrim, Escape key, and pull-down gesture own disclosure/collapse.
      if (!focused) return;
      // A tap on any overlay control (panel, grabber, audio-unlock chip, …)
      // is INSIDE — it must not dismiss the keyboard. The grabber in
      // particular is left to the gesture onTap; blurring here would preempt
      // the disclosure toggle and make press-time focus impossible to
      // distinguish from click-time focus.
      if (isOverlayControlTarget(event.target)) return;
      // Any other outside tap (incl. the dimming scrim) drops the keyboard and
      // returns to the pre-focus resting state — never a surprise full close.
      dismissKeyboardToPriorState();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismissKeyboardToPriorState, isOverlayControlTarget]);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onClick = (event: MouseEvent) => {
      if (!suppressNextOutsideClickRef.current) return;
      suppressNextOutsideClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  // The backdrop is visual-only while the sheet is open so launcher/home drags
  // can hit the real HomeLauncherSurface underneath. This document-level tap
  // detector preserves the old "tap outside to collapse" behavior without
  // stealing horizontal swipes or vertical scroll from the background.
  React.useEffect(() => {
    if (typeof document === "undefined" || !sheetOpen) {
      outsideSheetPointerRef.current = null;
      suppressNextOutsideClickRef.current = false;
      return undefined;
    }

    // Surfaces painted ABOVE the chat glass (notification sheet/panel at
    // Z_NOTIFICATION_OVERLAY, tutorial at Z_TUTORIAL, any open Radix dialog) must
    // win the tap — the
    // swallower otherwise eats their first tap AND collapses the chat under
    // them. "Tap outside collapses" is only for the background view.
    const isAboveShellOverlay = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest('[data-above-shell-overlay], [role="dialog"]');

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      // The whole overlay (panel, grabber, root-level controls like the
      // audio-unlock chip) is INSIDE — see isOverlayControlTarget's contract.
      if (
        isOverlayControlTarget(event.target) ||
        isAboveShellOverlay(event.target)
      ) {
        outsideSheetPointerRef.current = null;
        return;
      }
      outsideSheetPointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        composerFocusedAtPress: composerFocusedAtPressRef.current,
        dragged: false,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >
        OUTSIDE_SHEET_TAP_SLOP
      ) {
        start.dragged = true;
      }
    };

    const onPointerEnd = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      outsideSheetPointerRef.current = null;
      if (start.dragged) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      suppressNextOutsideClickRef.current = true;
      window.setTimeout(() => {
        suppressNextOutsideClickRef.current = false;
      }, 750);

      if (start.composerFocusedAtPress) {
        composerFocusedAtPressRef.current = false;
        return;
      }
      collapse();
    };
    const onPointerCancel = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      outsideSheetPointerRef.current = null;
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [sheetOpen, collapse, isOverlayControlTarget]);

  // Escape collapses the chat from ANY open state, even a free-drag open with no
  // focused element (the element-level handlers on the textarea/thread only fire
  // when one of them holds focus). Registered only while open.
  React.useEffect(() => {
    if (typeof document === "undefined" || !sheetOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open Radix dialog (data-state="open" — e.g. the command palette)
        // or a notification surface (the mobile pull-down sheet or the desktop
        // anchored panel — both mount only while open; the panel carries
        // role="dialog" with NO data-state="open") sits
        // above the chat: let ITS Escape handling win — collapsing here too
        // closed both at once (e.g. an invisible palette + the chat). Scoped
        // to exactly these; broad role="dialog" would match always-mounted
        // shell surfaces (AssistantOverlay, tutorial card) and permanently
        // disable Escape-collapse.
        //
        // Also defer while the transcript viewer is open or a per-message edit
        // is in progress: neither carries `[data-state="open"]`, so Escape must
        // close THAT first (the viewer's own handler / the editor's Cancel) and
        // NOT also collapse the whole sheet + discard the in-progress edit.
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [data-testid="notification-sheet"], [data-testid="notification-panel"], [data-testid="transcript-viewer"], [data-testid="thread-line-edit-input"]',
          )
        ) {
          return;
        }
        e.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen, collapse]);

  // Android hardware/gesture back closes the open chat sheet FIRST — the same
  // "dismiss the open surface" behavior desktop/web get from Escape (#9148).
  // `main.tsx` dispatches ELIZA_BACK_INTENT on the Capacitor `backButton` press;
  // while the sheet is open (and not pinned by onboarding) we collapse it via
  // the shared `collapse` path and flip `detail.handled` so native does NOT ALSO
  // run history.back()/minimizeApp() and navigate the app out from under it. At
  // rest (input/pill) — or while first-run pins the sheet open + undismissable —
  // we leave the intent unhandled so native falls through to its default back
  // (backgrounding the app instead of freezing). Web/desktop never dispatch the
  // event, so this is inert there.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onBackIntent = (event: Event) => {
      const detail = (event as CustomEvent<BackIntentEventDetail>).detail;
      if (!detail || detail.handled) return;
      if (!sheetOpen || firstRunOpen) return;
      // A notification sheet/panel painted ABOVE the chat is the topmost layer —
      // let it consume back first (independent of window-listener order), so
      // Android back never collapses the chat UNDERNEATH an open notification
      // shell. Mirrors the Escape deferral guard above.
      if (
        document.querySelector(
          '[data-testid="notification-sheet"], [data-testid="notification-panel"]',
        )
      ) {
        return;
      }
      detail.handled = true;
      collapse();
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
    return () =>
      window.removeEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
  }, [sheetOpen, firstRunOpen, collapse]);

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
    // A pill tap OPENS the chat. With a conversation to show, go straight to the
    // HALF detent — a tap reveals the thread/loader exactly like a flick-up, so a
    // SINGLE tap always opens the chat (never the old "tap lands on a bare input
    // bar, tap again to actually open" two-step). Mark it deliberately open so
    // dismissing the keyboard then KEEPS it at half (preFocusCollapsedRef gates
    // that). With no thread yet, there's nothing to open into — just form the
    // bare input bar, and treat a later keyboard dismiss as a re-collapse.
    if (hasRevealableThread) {
      goToDetent("half");
      preFocusCollapsedRef.current = false;
    } else {
      setMode("input");
      preFocusCollapsedRef.current = true;
      detentHaptic();
    }
    if (reduce) {
      stopOpenProgressAnimation();
      openProgress.set(1);
    } else animateOpenProgress(1);
    // Raise the keyboard on the SAME tap that opens the pill. While pilled, the
    // composer content is `inert`, and React only clears that on the next
    // render — too late for iOS WebKit, which honors focus() only synchronously
    // inside the originating user gesture AND only on a non-inert element. So
    // clear inert imperatively now and focus immediately; otherwise the first
    // tap opens a composer that silently refuses keyboard input until a second
    // tap (the reported "chat input doesn't accept text on iOS" bug). Suppress
    // the focus→expand: the target detent is already set above, and letting
    // expand run would clobber preFocusCollapsedRef with the (pre-render, still
    // pilled) sheet state and treat this deliberate open as a re-collapse.
    contentRef.current?.removeAttribute("inert");
    suppressExpandOnFocusRef.current = true;
    inputRef.current?.focus();
  }, [
    openProgress,
    reduce,
    hasRevealableThread,
    goToDetent,
    stopOpenProgressAnimation,
    animateOpenProgress,
  ]);

  // --- Pull gesture --------------------------------------------------------
  // The grabber is the draggable handle. A live drag sets the threadHeight motion
  // value DIRECTLY (no React state → no re-render per frame, so it tracks the
  // finger 1:1); release fires onPullUp/onPullDown (distance OR velocity, via
  // usePullGesture) to snap to a detent.
  const onDragOffset = React.useCallback(
    (offset: number) => {
      // Onboarding pins the sheet at FULL: the live drag must not move it.
      if (firstRunOpen) return;
      if (!draggingRef.current) {
        stopThreadAnimation();
        stopOpenProgressAnimation();
      }
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
        setDragPreviewMounted(excess > 0 && hasRevealableThread);
        threadHeight.set(excess > 0 ? clampHeight(excess) : 0);
        return;
      }
      // INPUT → PILL drag (collapsed, dragging DOWN): the mirror of the pill
      // drag — map the downward travel to the input→pill morph (openProgress
      // 1 → 0) so the input bar visibly scales down into the pill capsule under
      // the finger, instead of staying fully formed and snapping to the pill only
      // on release (the dead, unresponsive collapse gesture). The thread stays at
      // 0 (nothing to size below the input).
      if (!sheetOpen && offset < 0) {
        setDragPreviewMounted(false);
        const down = -offset;
        openProgress.set(Math.max(0, 1 - down / PILL_OPEN_DISTANCE));
        threadHeight.set(0);
        return;
      }
      if (!sheetOpen) {
        setDragPreviewMounted(offset > 0 && hasRevealableThread);
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
      firstRunOpen,
      pilled,
      hasRevealableThread,
      sheetOpen,
      expanded,
      baseH,
      clampHeight,
      threadHeight,
      openProgress,
      stopThreadAnimation,
      stopOpenProgressAnimation,
      setDragPreviewMounted,
    ],
  );

  const pullBinding: PullGestureBinding = usePullGesture({
    onDrag: onDragOffset,
    onDragReset: settleDrag,
    swipeEnabled: !sheetOpen,
    onSwipeLeft: () => {
      settleDrag();
      if (!sheetOpen) goLauncher();
    },
    onSwipeRight: () => {
      settleDrag();
      if (!sheetOpen) goHome();
    },
    // Flicks step one detent; released drags from the collapsed input honor the
    // live height so a long pull can land full instead of snapping back to half.
    // The inline closures are rebuilt every render, so they always read the
    // current detent.
    onPullUp: () => {
      setDragPreviewMounted(false);
      if (pilled) {
        // PILL → INPUT, or straight into the chat when there's history: a flick
        // up opens. Mirror the slow-drag path so a flick and a slow drag BOTH
        // reach the chat (no hard stop at the bare input). Releasing draggingRef
        // first lets the pilled→openProgress effect spring the morph 0→1.
        draggingRef.current = false;
        if (hasRevealableThread) {
          focusThreadRef.current = true;
          goToDetent("half");
        } else {
          // Pill → bare input bar (no thread to open into).
          setMode("input");
          if (reduce) {
            stopThreadAnimation();
            threadHeight.set(0);
          } else animateThreadHeight(0);
          detentHaptic();
        }
        return;
      }
      if (!sheetOpen) {
        if (!hasRevealableThread) return settleDrag();
        const releasedH = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (releasedH >= halfH + SHEET_DETENT_MAGNET) {
          goToDetent("full");
        } else {
          goToDetent("half");
        }
        focusThreadRef.current = true;
      } else if (!expanded) {
        goToDetent("full");
        focusThreadRef.current = true;
      } else {
        settleDrag();
      }
    },
    onPullDown: () => {
      setDragPreviewMounted(false);
      // Onboarding: a pull-down must not step the pinned-FULL sheet down.
      if (firstRunOpen) return settleDrag();
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
        setMode("pill");
        setMaximized(false);
        draggingRef.current = false;
        setDragPreviewMounted(false);
        inputRef.current?.blur();
        detentHaptic();
      }
    },
    // A tap (no drag) on the handle. A tap on the PILL brings the input back.
    // When OPEN, the grabber acts as a disclosure toggle: tap once to close.
    // When COLLAPSED, tap opens the thread or its loader; thread-less chats focus
    // the composer because there is nothing above the input to reveal.
    onTap: () => {
      if (pilled) {
        openFromPill();
        return;
      }
      if (sheetOpen) {
        if (composerFocusedAtPressRef.current) {
          composerFocusedAtPressRef.current = false;
          dismissKeyboardToPriorState();
          return;
        }
        collapse();
        return;
      }
      openFromGrabber();
    },
    // A deliberate (slow) drag: REST exactly where released instead of snapping
    // to a detent — drag the sheet to any size and it stays.
    onSettleFree: (direction) => {
      draggingRef.current = false;
      setDragPreviewMounted(false);
      // Onboarding: a released drag always springs back to the pinned FULL.
      if (firstRunOpen) return settleDrag();
      if (pilled) {
        // From the pill: a slow drag under the halfway-open mark (openProgress
        // < 0.5) springs back to the capsule; past it we commit to LEAVING the
        // pill — but we must NOT force the half detent. A short pull only forms
        // the input bar (threadHeight stays ~0 until the drag exceeds
        // PILL_OPEN_DISTANCE), so clear `pilled` and FALL THROUGH to the shared
        // detent magnetism below: a release near the input (threadHeight within
        // SHEET_DETENT_MAGNET of 0) settles at the INPUT state, and only a pull
        // that actually reached up into the thread opens to half/full. This is
        // what makes pill → input → chat one continuum instead of skipping the
        // input state straight to half on a short slow pull.
        const opened = direction === "up" && openProgress.get() >= 0.5;
        if (!opened) {
          settleDrag(); // springs openProgress → 0 (mode stays "pill") + thread → 0
          return;
        }
        // Leaving the pill: fall through to the magnetism below, which sets the
        // mode (input / half / full) from where the drag was released — so pill →
        // input → chat reads as one continuum.
        if (hasRevealableThread) focusThreadRef.current = true;
      }
      // From the collapsed input, a downward drag has nothing to "size" below
      // it. Require the input→pill morph to cross halfway before committing;
      // small thumb drift should spring back to the input, not collapse the chat.
      if (!sheetOpen && direction === "down") {
        if (openProgress.get() <= 0.5) {
          setMode("pill");
          inputRef.current?.blur();
          detentHaptic();
        } else {
          settleDrag();
        }
        return;
      }
      const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
      // DETENT MAGNETISM — the resting positions are the detents {collapsed:0,
      // half, full}; a release within SHEET_DETENT_MAGNET of one snaps to it
      // (deterministic, no janky near-detent slivers), and only the clear gaps
      // between them keep the free-drag rest height. goToDetent commits the
      // honest flags so data-detent + the maximize header match the height.
      if (h <= SHEET_DETENT_MAGNET) {
        // Near the bottom → collapse to the input bar.
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
        // open base; `freeH` overrides the actual height to where the finger
        // left. This leaves FULL without goToDetent, so drop full-bleed here
        // too — only the FULL detent may stay maximized (a stale flag would
        // re-maximize the next return to full).
        setFreeH(h);
        setMode("half");
        setMaximized(false);
      }
    },
  });

  // NOTE: outside pointerdown only drops the keyboard. Outside TAP collapse is
  // handled by the document-level tap detector above so drag gestures can still
  // pass through the visual backdrop to the launcher/home surface underneath.

  // The sheet's EFFECTIVE detent, shared by `data-detent` (DOM/e2e channel) and
  // the sr-only probe below (accessibility-tree channel — data attributes are
  // invisible to the native iOS/Android AX tree, so the on-device XCUITest
  // gesture suite reads this as a static text instead; see
  // packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift).
  // A free-rest at/near the top reads "full", a mid free-rest folds into
  // "half" — the label never disagrees with the rendered height.
  const detentLabel = pilled
    ? "pill"
    : !sheetOpen
      ? "collapsed"
      : // Onboarding is a pinned-open sheet even when sized to its content
        // (freeH); keep reporting "full" so the undismissable-onboarding
        // contract (unit + on-device gesture suites) stays honest.
        firstRunOpen
        ? "full"
        : freeH != null
          ? Math.min(freeH, panelMaxH) >= openH - 1
            ? "full"
            : "half"
          : expanded
            ? "full"
            : "half";

  // Onboarding-state probe: the newest first-run CHOICE turn's step id + option
  // values, surfaced as sr-only static AX text (mirrors chat-detent-probe /
  // home-launcher-page-probe) so an on-device XCUITest can observe and drive
  // first-run deterministically even where the WKWebView AX tree is imperfect.
  const firstRunProbe = React.useMemo(() => {
    if (!firstRunOpen) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const region = findChoiceRegions(messages[i].content).find(
        (r) => r.scope === "first-run" || r.scope.startsWith("first-run"),
      );
      if (region) {
        return {
          step: region.id,
          choices: region.options.map((o) => o.value).join(","),
        };
      }
    }
    return null;
  }, [firstRunOpen, messages]);

  return (
    <div
      ref={overlayRef}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 flex w-full min-w-0 flex-col items-center",
        // Full-bleed (maximized) removes the side inset so the chat is edge-to-edge.
        fullBleed ? "px-0" : "px-3 sm:px-4",
      )}
      // Lift the whole overlay above the on-screen keyboard (`bottom`); padding
      // below the composer is conditional on an actual keyboard lift, not focus
      // alone. With the keyboard up, only a small gap (0.75rem, matching the side
      // margin) sits between composer and keyboard. At rest, clear the
      // home-gesture zone (max safe-area / android inset) plus a hair, keeping the
      // chat low without touching that zone.
      style={{
        zIndex: Z_SHELL_OVERLAY,
        bottom: effectiveKeyboardInset,
        // Full-bleed fills the screen edge-to-edge: NO overlay bottom padding,
        // so the glass panel reaches the true bottom (no orange gap). The
        // gesture-zone clearance moves INSIDE the composer row (below) so the
        // input still sits above the home-gesture bar. Non-full-bleed keeps the
        // chat lifted off the gesture zone as before.
        paddingBottom: fullBleed
          ? 0
          : keyboardLiftActive
            ? "0.75rem"
            : "calc(var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.25rem)",
      }}
      data-testid="continuous-chat-overlay"
      data-open={sheetOpen ? "true" : undefined}
    >
      {/* Visual dimming scrim behind the open chat. It fades in WITH the reveal
          but never captures pointer events; outside taps are handled by the
          document-level detector above, and outside drags pass through to the
          launcher/home surface. */}
      <motion.div
        aria-hidden="true"
        data-testid="chat-sheet-backdrop"
        data-active={sheetOpen ? "true" : "false"}
        className="fixed inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.06)_0%,rgba(8,10,18,0.68)_46%,rgba(0,0,0,0.78)_100%)]"
        // Opacity follows the live history height (motion value) — no re-render
        // during a drag. Pointer events stay disabled so background gestures
        // keep their original targets while chat is open.
        style={{
          opacity: revealed,
          visibility: scrimVisibility,
          pointerEvents: "none",
        }}
      />

      {/* No live interim transcript is shown above the composer while
          listening — the spoken words land as the sent message when the turn
          completes. The mic being hot is confirmed by the pulsing speech glow
          on the input bar / grabber / collapsed pill instead of text. */}

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
          <Button
            variant="ghost"
            size="sm"
            onClick={unlockAudio}
            data-testid="overlay-voice-audio-unlock"
            className={cn(
              "pointer-events-auto h-auto gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              "border-warn/40 bg-warn/15 text-warn hover:bg-warn/25",
              "  ",
              FLOAT_SHADOW,
            )}
          >
            <Glyph d={SPEAKER_MUTED_GLYPH} />
            <span>Tap to enable sound</span>
          </Button>
        </div>
      ) : null}

      {/* Local model download/load status renders as the home-grid
          model-download widget only — no floating pill above the composer (the
          double status read as clutter). Send stays ungated; the server holds
          the turn until the model is ready. */}

      {/* Cold-start boot feedback — sibling of the model-download banner above.
          See BootStatusIndicator; `showBootBanner` is the grace-gated flag.
          Suppressed once we know no provider is configured: the agent will NEVER
          become ready, so "Waking …" would spin forever — the in-transcript
          no-provider gate is the honest error surface instead. */}
      {showBootBanner && !noProviderConfigured ? (
        <BootStatusIndicator
          agentName={agentName}
          onOpenSettings={openSettings}
          reduce={reduce}
        />
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
            <Button
              key={s}
              variant="ghost"
              size="sm"
              data-testid={`chat-suggestion-${i}`}
              aria-label={s}
              onClick={() => pickSuggestion(s)}
              className={cn(
                "h-auto max-w-full truncate rounded-full border border-white/15 bg-black/40 px-3 py-1.5",
                "text-[12px] text-white/80 transition-colors",
                "hover:border-white/30 hover:bg-white/15 hover:text-white",
                "  ",
              )}
            >
              {s}
            </Button>
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
            onOpen={openFromGrabber}
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
          data-detent={detentLabel}
          data-maximized={fullBleed ? "true" : undefined}
          data-revealed={threadPresented ? "true" : "false"}
          data-chat-state={chatState}
          data-header-shown={headerVisible ? "true" : "false"}
          // The active conversation id + its position in the most-recent-first
          // list, surfaced so flows like the tutorial can observe a new-chat or a
          // swipe-between-chats without reaching into controller internals.
          data-conversation-id={conversationNav.activeId ?? undefined}
          data-conversation-index={conversationNav.index}
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
            // overflow-VISIBLE on the outer fieldset: the pill's tall grab zone
            // must bleed past the box. The rounded thread-clip lives on the inner
            // content wrapper instead, so clipping the scroll never clips a hard
            // square edge over the content.
            "relative m-0 flex w-full min-w-0 flex-col overflow-visible border-0 p-0",
          )}
        >
          {/* SURFACE — absolute fill; the frosted-glass bg/border + the live
              corner radius. Crossfades in by openProgress (compositor opacity). */}
          <motion.div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-0",
              // Frosted-glass chat panel: a blurred, dark-tinted scrim behind the
              // whole conversation so the white transcript + composer text stays
              // legible over ANY surface — the warm ambient home, a photo
              // wallpaper, or a live view. Fades in with the panel (glassOpacity)
              // so the collapsed pill stays chrome-free. Hairline edge catches the
              // light; full-bleed drops the border for a true edge-to-edge sheet.
              fullBleed ? "border-0" : "border border-white/22",
            )}
            style={{
              opacity: glassOpacity,
              borderRadius: fullBleed ? 0 : panelRadius,
              // Soft glass WITHOUT a GPU backdrop blur (#10698, #9141 battery
              // gate): a dark translucent tint carries the contrast the removed
              // blur used to add (bumped a touch to compensate), and a faint
              // top-sheen gradient reads as glass. The battery gate bans the GPU
              // backdrop blur, so it is intentionally absent. Inline (not a
              // Tailwind class) so it renders identically in the raw-esbuild e2e.
              backgroundColor: fullBleed
                ? "rgba(10,10,12,0.7)"
                : threadPresented
                  ? "rgba(10,10,12,0.68)"
                  : "rgba(10,10,12,0.52)",
              backgroundImage:
                "linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 24%)",
              // Full-bleed: extend the glass UP through the safe-area-top so the
              // dark background reaches the true top of the screen. The panel
              // height comes from visualViewport (which excludes the Android
              // status bar) while the panel sits in a screen-top fixed container,
              // so without this the glass starts a status-bar-height below the top
              // (the "safe-area gap" above maximized chat). overflow-visible on the
              // panel lets it bleed up; content (header, with its own safe-area
              // padding) is untouched. Harmless when the inset is 0.
              ...(fullBleed
                ? { top: "calc(-1 * env(safe-area-inset-top, 0px))" }
                : null),
            }}
          />
          {/* AX-tree mirror of data-detent: the native gesture e2e suites
              (XCUITest) can only observe web state through the accessibility
              tree, and data attributes never surface there. sr-only text does.
              Not aria-live — it never announces on its own. Keep it after the
              visual surface so DOM e2e helpers that inspect the first child
              still read the glass layer. */}
          <span className="sr-only" data-testid="chat-detent-probe">
            {`chat-detent:${detentLabel}`}
          </span>
          {firstRunProbe ? (
            <span className="sr-only" data-testid="onboarding-state-probe">
              {`onboarding-step:${firstRunProbe.step} onboarding-choices:${firstRunProbe.choices}`}
            </span>
          ) : null}
          {/* CONTENT — sheen, glow, thread, composer. Crossfades with the glass
              and goes fully inert while pilled (opacity 0 + `inert` removes it
              from pointer, tab order, and the a11y tree) so it can't be reached
              behind the pill capsule. */}
          <motion.div
            ref={contentRef}
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
            // Drag-and-drop attachment intake (#10722). The old ChatView chat
            // surface accepted file drops; the overlay replaced it with only
            // paste + the attach button. Dropped files run the SAME intake
            // pipeline as both of those (addImageFiles → intakeAttachmentFiles),
            // so size caps, type support, and the pending-attachment strip all
            // behave identically. dragover must preventDefault for the browser
            // to allow the drop at all; only file drags are claimed so
            // text-selection drags keep their native behavior.
            onDragOver={(event) => {
              if (event.dataTransfer?.types?.includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              // preventDefault for ANY claimed file drag (dragover advertised
              // droppability): bailing on an empty file list would hand the
              // drop to the browser default — navigating to the local file.
              if (!event.dataTransfer?.types?.includes("Files")) return;
              event.preventDefault();
              const files = event.dataTransfer.files;
              if (files.length > 0) {
                addImageFiles(files);
              }
            }}
          >
            {/* Conversation-swipe edge hints (#8929): glow the edge the next /
                previous conversation will slide in from as the user drags. */}
            {sheetOpen ? (
              <>
                <SwipeEdgeHint
                  side="left"
                  active={swipeDx < 0 && conversationNav.hasPrev}
                  amount={-swipeDx}
                />
                <SwipeEdgeHint
                  side="right"
                  active={swipeDx > 0 && conversationNav.hasNext}
                  amount={swipeDx}
                />
              </>
            ) : null}
            {/* Specular sheen — a soft light from the top edge, the liquid-glass
            highlight. Subtle + non-interactive. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-0 h-20 bg-gradient-to-b from-white/[0.07] to-transparent"
            />

            {/* Sheet header — shown at the HALF detent and up (not just FULL).
              Left: Maximize (toggle edge-to-edge full-screen) + Clear (reset to
              a fresh greeted thread, RotateCcw — it resets, it doesn't delete).
              Right: one Launcher/Home launcher. Settings lives inside the
              Launcher grid, so the chat header stops acting like a second app
              nav bar. */}
            {threadPresented ? (
              <motion.div
                // Mounted while the sheet is open, or while an upward drag is
                // previewing the sheet before release. It can FADE + LERP its
                // space as the live height crosses the header threshold.
                // `headerVisible` gates interactivity + the a11y tree.
                inert={!sheetOpen || !headerVisible || undefined}
                style={{
                  // Full-bleed is always fully open: show the header at full
                  // opacity and UNCAP its height. The reveal lerp tops out at
                  // 100px, but the safe-area top padding (status-bar height +
                  // 0.5rem) plus the button row exceeds that, so a 100px cap
                  // clipped the buttons — uncap it edge-to-edge.
                  opacity: fullBleed ? 1 : headerOpacity,
                  maxHeight: fullBleed ? "none" : headerMaxH,
                  // Collapsed → 0 top padding (no leaked margin above the
                  // composer); opens to ~10px as the header reveals. Maximized
                  // goes edge-to-edge under the status bar, so the header insets
                  // its buttons below the safe area (the clock/battery) while the
                  // sheet bg stays full-bleed — set inline (not a Tailwind
                  // arbitrary class, whose env(...,0px) comma breaks the parser
                  // so no padding was generated and the buttons sat under the
                  // status bar).
                  paddingTop: fullBleed
                    ? "calc(var(--safe-area-top, 0px) + 0.5rem)"
                    : headerPadTop,
                }}
                className={cn(
                  "relative z-20 flex shrink-0 items-center justify-between gap-1.5 overflow-hidden px-3",
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
                    // Clearing mid-onboarding would wipe the seeded first-run
                    // choices and strand the flow — inert until it completes.
                    disabled={firstRunOpen}
                    onClick={() => clearConversation()}
                    testId="chat-full-clear"
                  />
                </div>
                {transcriptionMode ? (
                  <div
                    data-testid="chat-transcribing-badge"
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-medium text-accent"
                  >
                    Transcribing — say “exit transcription mode” to stop
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5">
                  <HeaderButton
                    icon={LayoutGrid}
                    label="launcher"
                    // A close-and-navigate control — locked while onboarding
                    // pins the sheet (the chat must stay front and center).
                    disabled={firstRunOpen}
                    onClick={() => navigateAndClose(() => navigateHome?.())}
                    testId="chat-full-launcher"
                  />
                </div>
              </motion.div>
            ) : null}

            {/* The conversation. Height animates 0 (collapsed) → half → full; the
            inner log scrolls. The grabber owns the drag, so dragging the messages
            just scrolls them. Rendered while the sheet is open or while an
            upward drag is actively previewing the sheet; at rest collapsed it
            is unmounted, so there is no hidden transcript layer. */}
            {threadPresented ? (
              <motion.div
                data-testid="chat-thread"
                className={cn(
                  "relative z-10 min-h-0 w-full shrink grow-0 overflow-hidden",
                  // When open, fade the top edge into the glass so the topmost
                  // message dissolves under the drag handle instead of butting
                  // against it.
                  threadPresented &&
                    "[mask-image:linear-gradient(to_bottom,transparent_0,#000_34px)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_34px)]",
                )}
                // Flex-basis IS the motion value (px string) — set 1:1 during a drag,
                // spring-animated to a detent on release; no `animate`/`transition`,
                // so no re-render. `shrink min-h-0` lets the panel's `maxHeight` cap
                // win: a tall detent (or the keyboard) shrinks the thread (it
                // scrolls) instead of pushing the panel off-screen. paddingTop
                // insets the scroll viewport below the floating grabber while the
                // header is hidden (0 once the header reveals at half+).
                style={{
                  flexBasis: threadFlexBasis,
                  paddingTop: threadGrabberClearance,
                }}
              >
                <motion.div
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
                  // Horizontal-swipe navigation between conversations, sheet-open
                  // only (#8929). Deferred capture keeps vertical scroll native.
                  // Gated during onboarding so a swipe can't leave the seeded
                  // first-run transcript.
                  {...(sheetOpen && !firstRunOpen ? conversationSwipe : {})}
                  className="relative flex h-full w-full touch-pan-y flex-col overflow-y-auto px-5 [scrollbar-width:none]  [&::-webkit-scrollbar]:hidden"
                  style={{ opacity: threadContentOpacity }}
                >
                  {/* Empty-thread loading: a fresh/cleared chat awaiting its
                      greeting, or a swipe past the prefetch window. Centered
                      spinner so the open sheet reads as "loading," never as a
                      broken empty box. Cache-hit swipes paint instantly, so this
                      only shows on a genuine network wait. */}
                  {visibleMessages.length === 0 && conversationLoading ? (
                    <div
                      data-testid="chat-thread-loading"
                      className="pointer-events-none absolute inset-0 grid place-items-center"
                    >
                      <Loader2 className="h-6 w-6 animate-spin text-accent" />
                    </div>
                  ) : null}
                  {/* Topic chips bar (#8928): the channel's current topics,
                      sticky above the scrolling transcript. Tap a chip to jump
                      to (and expand) its group. Hidden when nothing is tagged. */}
                  {hasTopics ? (
                    <TopicChipsBar
                      topics={channelTopics}
                      onSelectTopic={scrollToTopic}
                      className="sticky top-0 z-[2] -mx-5 mb-1 bg-gradient-to-b from-black/40 to-transparent px-5"
                    />
                  ) : null}
                  {/* `mt-auto` keeps the latest line at the bottom (nearest the input)
                  until the thread overflows, then it scrolls. The ref measures
                  this content so onboarding can size the sheet to it (grow from
                  the bottom). */}
                  <div
                    ref={threadContentRef}
                    className="mt-auto flex flex-col pb-3 pt-1"
                  >
                    {hasTopics
                      ? // Topic-grouped transcript: each cluster collapses via a
                        // gesture on its header (no visible buttons).
                        (() => {
                          let lineIndex = 0;
                          return topicSegments.map((segment) => {
                            const lines = segment.messages.map((m) =>
                              renderThreadLine(m, lineIndex++),
                            );
                            return (
                              // The React key is the segment's first message id
                              // (stable + unique) because a topic can recur in a
                              // non-adjacent run (A → B → A). Collapse state stays
                              // keyed by topic (`segment.key`) so a chip tap
                              // expands every run of that topic.
                              <TopicGroup
                                key={segment.messages[0]?.id ?? segment.key}
                                topic={segment.topic}
                                count={segment.messages.length}
                                collapsed={collapsedTopics.has(segment.key)}
                                onCollapsedChange={(collapsed) =>
                                  setTopicCollapsed(segment.key, collapsed)
                                }
                              >
                                <AnimatePresence initial={false}>
                                  {lines}
                                </AnimatePresence>
                              </TopicGroup>
                            );
                          });
                        })()
                      : // Flat transcript (no topic tags) — unchanged behavior.
                        // Only the LAST, content-less assistant turn (the
                        // in-flight one) reads turnStatus — every settled bubble
                        // gets undefined so its memo identity is unchanged.
                        null}
                    {hasTopics ? null : (
                      <AnimatePresence initial={false}>
                        {visibleMessages.map((m, i) => renderThreadLine(m, i))}
                      </AnimatePresence>
                    )}
                    <AnimatePresence>
                      {/* Rich status row (#8813): what the agent is doing —
                          thinking / running an action / waking / speaking — for
                          the brief window where we're responding but the assistant
                          placeholder turn isn't in the thread yet. Once the
                          in-flight assistant bubble exists it carries the same
                          status row inline (anchored where the reply fills in),
                          so don't double up. */}
                      {responding &&
                      !(
                        visibleMessages.at(-1)?.role === "assistant" &&
                        !visibleMessages.at(-1)?.content.trim()
                      ) ? (
                        <TurnStatusIndicator
                          status={turnStatus}
                          reduce={reduce}
                        />
                      ) : null}
                    </AnimatePresence>
                    <div ref={endRef} />
                  </div>
                </motion.div>
              </motion.div>
            ) : null}
            {/* Pending image attachments + any read error, just above the input. */}
            {hasImages || imageError ? (
              <div className="relative z-10 flex shrink-0 flex-col gap-1.5 px-3 pt-2">
                {hasImages ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingImages.map((img, i) => {
                      const kind = chatUploadKind(img.mimeType);
                      const removeButton = (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`remove ${img.name}`}
                          onClick={() => removeImage(i)}
                          // Small visual disc, but a 44px-class hit zone via the
                          // invisible `before` overlay so it's thumb-tappable
                          // without crowding the tile.
                          className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-white/20 bg-black/70 p-0 text-xs text-white/90 transition-colors before:absolute before:-inset-3 before:content-[''] hover:bg-black/90"
                        >
                          ×
                        </Button>
                      );
                      const tileKey = `${img.name}-${img.mimeType}-${img.data.length}`;
                      if (kind === "image") {
                        return (
                          <div
                            key={tileKey}
                            className="group relative h-14 w-14 shrink-0"
                          >
                            <img
                              src={`data:${img.mimeType};base64,${img.data}`}
                              alt={img.name}
                              className="h-14 w-14 rounded-lg border border-white/20 object-cover"
                            />
                            {removeButton}
                          </div>
                        );
                      }
                      const KindIcon =
                        kind === "audio"
                          ? Music
                          : kind === "video"
                            ? Film
                            : FileText;
                      return (
                        <div
                          key={tileKey}
                          className="group relative flex h-14 min-w-[3.5rem] max-w-[10rem] shrink-0 items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-2.5 text-white/90"
                          title={img.name}
                        >
                          <KindIcon className="h-5 w-5 shrink-0 text-white/70" />
                          <span className="min-w-0 truncate text-[11px] leading-tight">
                            {img.name}
                          </span>
                          {removeButton}
                        </div>
                      );
                    })}
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
            <Input
              ref={fileInputRef}
              type="file"
              accept={CHAT_UPLOAD_ACCEPT}
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
                // No divider above the composer — spacing separates it from the
                // thread; the sheet is one continuous glass surface (#10710).
                "relative z-10 flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-2 sm:gap-2",
              )}
              // Full-bleed has no overlay bottom padding (the panel is
              // edge-to-edge), so the composer carries the home-gesture
              // clearance itself — except while the keyboard is up, which
              // already covers that zone.
              style={
                fullBleed && !keyboardLiftActive
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
                disabled={
                  firstRunOpen || pendingImages.length >= MAX_CHAT_IMAGES
                }
                onClick={() => fileInputRef.current?.click()}
                testId="chat-composer-attach"
              />
              <Textarea
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
                  // A pill-open focus only raises the keyboard; it must not
                  // expand a history thread (see suppressExpandOnFocusRef).
                  if (suppressExpandOnFocusRef.current) {
                    suppressExpandOnFocusRef.current = false;
                  } else {
                    expand();
                  }
                }}
                onPaste={(e) => {
                  // Shared with the desktop composer: a pasted image/file
                  // attaches, a large plain-text paste becomes a collapsed
                  // text-attachment chip, and small text falls through to the
                  // textarea as normal.
                  const intent = classifyComposerPaste({
                    files: Array.from(e.clipboardData?.files ?? []),
                    text: e.clipboardData?.getData("text") ?? "",
                  });
                  if (intent.kind === "files") {
                    e.preventDefault();
                    addImageFiles(intent.files);
                    return;
                  }
                  if (intent.kind === "text-attachment") {
                    e.preventDefault();
                    setPendingImages((prev) =>
                      [...prev, intent.attachment].slice(0, MAX_CHAT_IMAGES),
                    );
                  }
                }}
                onKeyDown={(e) => {
                  // Never treat the Enter that COMMITS an IME composition as a
                  // command/send key: while a CJK/other IME is composing, the
                  // browser fires this keydown with `isComposing` true (legacy
                  // engines report keyCode 229) and the Enter only accepts the
                  // candidate. Guard BOTH the slash-resolve and the submit below
                  // so committing a candidate never fires either (#9148). Let it
                  // fall through to the textarea/IME as its default.
                  if (
                    e.key === "Enter" &&
                    (e.nativeEvent.isComposing || e.keyCode === 229)
                  ) {
                    return;
                  }
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
                  // (An IME-composition Enter was already filtered out above.)
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "Escape" && sheetOpen) {
                    e.preventDefault();
                    collapse();
                  }
                }}
                // During onboarding the transcript's choice widgets are the
                // only input: typing is disabled until first-run completes.
                // (This surface's strings are plain literals by design — see
                // the imageError note above.)
                disabled={firstRunOpen}
                placeholder={
                  firstRunOpen
                    ? "Pick an option to continue"
                    : noProviderConfigured
                      ? "Connect a model provider in Settings to chat"
                      : booting
                        ? `Ask ${agentName} — waking up…`
                        : (viewChatBinding?.placeholder ?? `Ask ${agentName}`)
                }
                aria-label="message"
                data-testid="chat-composer-textarea"
                aria-describedby={
                  booting && !noProviderConfigured
                    ? "cc-booting-hint"
                    : undefined
                }
                // Combobox semantics (role + aria-*) are applied as one spread,
                // and only when a slash catalog is wired in — a plain message
                // box otherwise.
                {...comboboxAria}
                // During onboarding the composer is frozen (choice widgets are
                // the only input), so brighten the placeholder from the resting
                // 45% to 70% — a directive hint the user can actually read,
                // rather than a greyed-out box that reads as dead.
                className={`max-h-[8.5rem] min-h-8 min-w-0 flex-1 resize-none self-center border-none bg-transparent px-1.5 py-1 text-left text-sm leading-relaxed text-white/[0.92] outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
                  firstRunOpen
                    ? "placeholder:text-white/70"
                    : "placeholder:text-white/45"
                }`}
              />
              <span id="cc-booting-hint" className="sr-only">
                {agentName} is waking up — you can type now; your message sends
                and the reply arrives in a moment.
              </span>
              {/* Trailing controls. */}
              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                {/* Transcription start/stop — only in voice mode (hands-free /
                recording), sitting next to the mic. The mic stays the master
                voice control (a mic tap ends both); this button starts/stops the
                record-only transcription layer and LEAVES THE MIC ON, matching
                toggleTranscriptionMode's off-path (#10699). Hidden when a
                send/stop control is showing (a draft or a streaming reply). */}
                {(handsFree || recording || transcriptionMode) &&
                !((hasDraft || hasImages) && !recording) &&
                !(!recording && responding) ? (
                  <SoftButton
                    icon={FileText}
                    label={
                      transcriptionMode
                        ? "stop transcription"
                        : "start transcription"
                    }
                    active={transcriptionMode}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={toggleTranscriptionMode}
                    testId="chat-composer-transcribe"
                  />
                ) : null}
                {/* One trailing control, ChatGPT-style: mic when there's nothing
                to send (or while recording, to stop), swapping to send once the
                user starts typing or attaches an image. It morphs IN PLACE (one
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
                      disabled={!canSend || firstRunOpen}
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
                          ? // Press-and-hold dictates into the composer draft; a
                            // release drops the transcript into the text box and
                            // does NOT send (see beginPushToTalkPress /
                            // setDictationSink). Label the real behavior.
                            "release to insert"
                          : transcriptionMode
                            ? "stop transcription"
                            : handsFree
                              ? "end conversation"
                              : recording
                                ? "stop listening"
                                : "talk"
                      }
                      // Voice input is free text too — locked with the rest of
                      // the composer while onboarding is choice-driven.
                      disabled={firstRunOpen}
                      active={recording || handsFree || transcriptionMode}
                      onClick={handleMicClick}
                      onPointerDown={beginPushToTalkPress}
                      onPointerUp={(e) => finishPushToTalkPress(e, false)}
                      onPointerCancel={(e) => finishPushToTalkPress(e, true)}
                      testId="chat-composer-mic"
                    />
                  )}
                </div>
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
              pilled={pilled}
            />
          </motion.div>
        </motion.fieldset>
      </div>
    </div>
  );
}
