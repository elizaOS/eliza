/**
 * Renders the continuous chat overlay that keeps the composer and transcript
 * available across views.
 */
import { logger } from "@elizaos/logger";
import { MAX_CHAT_MEDIA_RAW_BYTES } from "@elizaos/shared";
import { transcriptPlainText } from "@elizaos/shared/transcripts";
import {
  ArrowDown,
  AudioLines,
  Camera,
  Captions,
  FileText,
  Film,
  Loader2,
  Mic,
  Music,
  Paperclip,
  Search,
  SendHorizontal,
} from "lucide-react";
import {
  AnimatePresence,
  animate,
  type MotionValue,
  motion,
  useMotionTemplate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from "motion/react";
import * as React from "react";

import { client } from "../../api/client";
import type {
  ChatTurnStatus,
  ConversationMessageSearchResult,
  ImageAttachment,
} from "../../api/client-types-chat";
import { useComposerKeydown, useComposerPaste } from "../../chat/composer-core";
import { reportComposerActivity } from "../../chat/report-composer-activity";
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
  CHAT_OPEN_EVENT,
  CHAT_PREFILL_EVENT,
  type ChatPrefillEventDetail,
  ELIZA_BACK_INTENT_EVENT,
} from "../../events";
import {
  TOUCH_TAP_MOVE_SLOP as OUTSIDE_SHEET_TAP_SLOP,
  useRafCoalescer,
} from "../../gestures";
import { useConversationRenderWindow } from "../../hooks/useConversationRenderWindow";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { useLoadOlderOnScroll } from "../../hooks/useLoadOlderOnScroll";
import { usePushToTalk } from "../../hooks/usePushToTalk";
import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { claimAssistantLaunchPayloadFromHash } from "../../platform/assistant-launch-payload";
import { isIOS, isNative, isStandalonePwa } from "../../platform/init";
import {
  KEYBOARD_INTRUSION_THRESHOLD_PX,
  STANDALONE_BOTTOM_RECLAIM_OFFSET,
  shouldInstallStandaloneBottomReclaim,
} from "../../platform/standalone-bottom-reclaim";
import { useAppSelectorShallow } from "../../state";
import {
  clearChatDraft,
  useChatComposerOrLocal,
} from "../../state/ChatComposerContext.hooks";
import { useConversationMessages } from "../../state/ConversationMessagesContext.hooks";
import { loadOlderConversationMessages } from "../../state/load-older-conversation-messages";
import { goHome, goLauncher } from "../../state/shell-surface-store";
import { useViewChatBinding } from "../../state/view-chat-binding";
import { tryHandleTutorialText } from "../../tutorial/tutorial-action-channel";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  bytesToMb,
  CHAT_UPLOAD_ACCEPT,
  chatUploadKind,
  intakeAttachmentFiles,
  MAX_CHAT_IMAGES,
  summarizeDroppedAttachments,
} from "../../utils/image-attachment";
import { voiceCaptureDebug } from "../../utils/voice-capture-debug";
import { InlineWidgetText } from "../chat/InlineWidgetText";
import { MessageAttachments } from "../chat/MessageAttachments";
import {
  FormSubmitReceipt,
  SensitiveRequestBlock,
} from "../chat/MessageContent";
import { findChoiceRegions } from "../chat/message-choice-parser";
import { parseFormSubmitDisplay } from "../chat/message-parser-helpers";
import { MessageSearchPanel } from "../chat/message-search/MessageSearchPanel";
import { ThinkingBlock } from "../chat/ThinkingBlock";
import { AgentProvisioningWidget } from "../chat/widgets/agent-provisioning";
import {
  buildReplyTargetFromMessage,
  ChatMessage,
  getChatMessageAnchorId,
} from "../composites/chat/chat-message";
import { ChatReplyPill } from "../composites/chat/chat-reply-pill";
import type {
  ChatMessageData,
  ChatMessageRenderContext,
} from "../composites/chat/chat-types";
import { TurnStatus } from "../composites/chat/chat-typing-indicator";
import { ToolCallEventLog } from "../tool-events/ToolCallEventLog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  isShortLandscapeViewport,
  measureSafeAreaInsetTop,
  resolveChatPanelLayout,
} from "./chat-panel-layout";
import { LIQUID_GLASS_EDGE_SHADOW, LIQUID_GLASS_SHEEN } from "./liquid-glass";
import { withPressLatch } from "./press-latch";
import { SlashCommandMenu, useSlashMenu } from "./SlashCommandMenu";
import {
  filterRenderableShellMessages,
  type ShellMessage,
} from "./shell-state";
import { TopicChipsBar } from "./TopicChipsBar";
import { TopicGroup } from "./TopicGroup";
import {
  deriveChannelTopics,
  groupMessagesByTopic,
  hasMultipleTopicGroups,
} from "./topic-grouping";
import { type PullGestureBinding, usePullGesture } from "./use-pull-gesture";
import type { ConversationNav, ShellController } from "./useShellController";
import { WALLPAPER_FLOAT_SHADOW, WALLPAPER_TEXT } from "./wallpaper-idiom";

/** No-op slash controller so the overlay renders without a provider (stories). */
const EMPTY_SLASH_CONTROLLER: SlashCommandController = {
  commands: [],
  loading: false,
  error: false,
  naturalShortcutsEnabled: false,
  isAuthorized: false,
  isElevated: false,
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

// The chat floats over arbitrary app surfaces, including theme-app where
// `--card` is brand orange. Keep the sheet's local tokens dark, neutral, and
// self-owned so open/maximized chat never turns into a transparent-looking
// orange overlay.
const CHAT_PANEL_THEME = {
  "--bg": "#101114",
  "--bg-hover": "rgba(255, 255, 255, 0.08)",
  "--bg-muted": "rgba(255, 255, 255, 0.06)",
  "--card": "#181a20",
  "--card-foreground": "#f4f5f7",
  "--surface": "rgba(255, 255, 255, 0.07)",
  "--txt": "#f4f5f7",
  "--text": "#f4f5f7",
  "--text-strong": "#ffffff",
  "--foreground": "#f4f5f7",
  "--muted": "rgba(244, 245, 247, 0.68)",
  "--muted-strong": "rgba(244, 245, 247, 0.86)",
  "--muted-foreground": "rgba(244, 245, 247, 0.68)",
  "--border": "rgba(255, 255, 255, 0.18)",
  "--border-strong": "rgba(255, 255, 255, 0.34)",
  "--ring": "rgba(244, 245, 247, 0.8)",
  "--accent": "#ff7a3d",
  "--accent-foreground": "#101114",
} as React.CSSProperties;

// The drag-handle bar color. Set EXPLICITLY (not `bg-muted-strong`) because the
// SheetGrabber renders OUTSIDE the fieldset that scopes CHAT_PANEL_THEME, so a
// token-based color there resolves to the ambient app theme — which is dark on a
// light surface, making the handle render BLACK (the "handle is black sometimes"
// bug: the open-sheet grabber was black while the in-panel pill bar was white).
// This warm near-white matches the panel's `--muted-strong` in every context.
const HANDLE_BAR_COLOR = "rgba(255, 247, 240, 0.86)";

// Shared easing for the overlay's cheap motion path. Open/close must stay
// opacity/translate only: animating blur/filter or scaling a scrollable
// transcript repaints too much of the viewport and visibly janks on laptops.
const OVERLAY_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// `screen.height` is a useful keyboard-down reference only on the iOS
// standalone/native surfaces that own the collapsed-viewport reclaim. On
// desktop and Android it describes the monitor or physical device rather than
// the layout viewport, so using it there would create false keyboard lifts.
const SCREEN_KEYBOARD_SIGNAL_ACTIVE =
  typeof window !== "undefined" &&
  shouldInstallStandaloneBottomReclaim({
    standalonePwa: isStandalonePwa(),
    isNative,
    isIOS,
  });

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

type MotionControls = { stop: () => void };

const SHEET_HALF_VH = 0.46; // fraction of viewport height at the HALF detent
// Ceiling (px) for the composer-footprint clearance the chat reserves in the
// home/launcher layout. The panel can momentarily measure its OPEN/animating
// height on the drag-down→collapse edge; publishing that as the reserved space
// would push the launcher's top row off-screen (it lays out against this
// padding). A tall composer — 3-line draft + a couple of attachment chips — is
// well under this, so the cap only ever clips the bogus open-height reading.
const CHAT_CLEARANCE_MAX_PX = 220;
// Restore-from-maximized grab zone (#13531): while full-bleed, a downward pull
// that STARTS within this fraction of the panel height from the top drops
// full-bleed and tracks the finger. 0.9 = "top 90%" — nearly the whole panel is
// grabbable (only the bottom composer strip is excluded), and it sits UNDER the
// top bar whose empty space is pointer-transparent so pulls there reach it too.
// The pull-down-to-restore grab zone is scoped to the TOP BAR only (safe-area +
// this many px), NOT the whole panel. A full-height strip stole the transcript's
// scroll (every touch-drag/wheel over the messages read as a restore pull) and
// made an accidental tap twitch the sheet out of full-screen. Confining it to
// the top leaves the transcript freely scrollable and makes "exit full-screen"
// an explicit drag from the top edge.
const MAXIMIZE_RESTORE_ZONE_PX = 72;
// The panel's top clearance + max height (which decide how the full-bleed header
// clears the notch) live in the pure, unit-tested `resolveChatPanelLayout` — see
// chat-panel-layout.ts.
// Detent magnetism: on a deliberate (non-flick) drag release, a height within
// this many px of a detent (collapsed/half/full) snaps to that detent instead
// of resting free — so near-detent releases are deterministic + clean, and only
// the clear gaps between detents keep the free-drag rest height.
const SHEET_DETENT_MAGNET = 64;
// Over-pull past the FULL detent morphs the inset sheet to edge-to-edge
// full-bleed across the REAL pixel gap between the two solved heights
// (`fullPanelMaxH - insetPanelMaxH`, see maxOverPull) — 1:1 with the finger,
// no fixed range constant. The maximize tracks the finger over that gap
// instead of springing on release, so pulling past full reads as one continuous
// expand-to-maximize — and dragging back down within the same gesture reverses
// it. Release commits the maximize once the morph is at least half-complete.
const COMPOSER_TYPING_PAUSE_MS = 2_000;
const COMPOSER_ACTIVITY_SURFACE = "continuous_chat_overlay";

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
// Downward finger travel PAST the bottom (thread height 0) at which releasing an
// OPEN-sheet drag commits the pill. Deliberately smaller than the halfway mark
// of the input→pill morph (PILL_OPEN_DISTANCE / 2): a drag that consumed the
// whole thread height ends with the finger near the screen edge, so only
// ~50–80px of physical travel can exist past the bottom — requiring the full
// half-morph would make "drag from full screen down to the pill" physically
// unreachable on shorter panels. The short input→pill gesture (which has the
// whole screen of room) keeps the stricter halfway rule.
const PILL_COMMIT_OVERSHOOT = 40;
const PILL_COMMIT_PROGRESS = 1 - PILL_COMMIT_OVERSHOOT / PILL_OPEN_DISTANCE;

// The panel's resting corner radius. ONE constant for every height — the pill
// capsule, the collapsed input bar, and the open sheet all share it, so the
// corners never animate while the sheet grows (only the maximize morph squares
// them off toward edge-to-edge).
const PANEL_RADIUS_PX = 32;

// Maximize is a DISCRETE STATE, not a finger-tracked lerp. As a drag carries the
// panel up through the over-pull gap (inset FULL → edge-to-edge), the height
// tracks the finger 1:1 but the SHAPE (border, radius, side inset, width,
// composer capsule) stays the inset chat shape until the over-pull crosses
// MAXIMIZE_COMMIT_T — then the whole shape SPRINGS to full-bleed at once. Pulling
// back down below MAXIMIZE_RELEASE_T springs it back to the inset shape. The
// commit fraction is LOW so a small pull into the over-pull "top zone" snaps to
// full promptly (the panel is pinned at the inset ceiling through the zone — it
// does not stretch 1:1 with the finger — so a high threshold reads as a long
// dead pull before anything happens). The same fraction gates the release-time
// maximize and the peak-void so a mid-drag commit and a release commit agree on
// where the zone begins; the hysteresis gap below keeps the state from flapping.
const MAXIMIZE_COMMIT_T = 0.3;
const MAXIMIZE_RELEASE_T = 0.15;

// Finger travel (px) below the restore drag's upward peak at which the panel
// drops full-bleed and starts tracking the finger down out of maximize. Sized
// so an accidental TAP or a few px of pointer jitter is a no-op (only the drag
// exits full-screen, per product direction) while a deliberate downward pull
// still un-maximizes promptly.
const RESTORE_UNMAX_SLOP = 24;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// Panel scale at the PILL end of the pill↔input morph. The collapse must read
// as the whole chat shrinking down into the capsule — a hard, visible scale
// lerp — not a near-imperceptible 0.9 nudge (the "barely animates down" bug).
// The glass crossfades out over the same progress, so the deep scale never
// shows a crumpled composer: by the time content would distort it has faded.
export const PILL_MORPH_MIN_SCALE = 0.45;
/** Panel scale for a pill↔input morph progress (0 = pill, 1 = input). */
export function pillMorphScale(progress: number): number {
  return PILL_MORPH_MIN_SCALE + (1 - PILL_MORPH_MIN_SCALE) * clamp01(progress);
}

/**
 * Grabber-bar opacity from the two morphs that own it. It fades IN only after
 * the pill capsule has fully faded out (strict anti-phase over [0.55, 0.95] of
 * the pill→input open — the "two pills" guard), and back OUT as the over-pull
 * shape morph (`fullBleedT`) approaches edge-to-edge — so the handle dissolves
 * under the finger through the top ~10% of the pull instead of popping away
 * the frame the maximize commits (which unmounts it for the restore strip).
 */
export function grabberBarOpacity(
  openProgress: number,
  fullBleedT: number,
): number {
  const openFade = clamp01((openProgress - 0.55) / 0.4);
  return openFade * (1 - clamp01(fullBleedT));
}

// Glyphs (viewBox 0 0 36 36), rendered in currentColor inside a soft chip. Send
// + mic now use lucide icons (SendHorizontal / Mic); the rest stay hand-drawn.
// The plus fills nearly the whole 36-unit box (arms 3→33) so, rendered at the
// full button size, it carries the same optical weight as the lucide mic/send
// marks — a tighter path would read as a small, over-padded glyph beside them.
const PLUS_GLYPH = "M15 3H21V15H33V21H21V33H15V21H3V15H15Z";
// Stop generating: a centered square (the universal "stop" affordance), sized to
// sit between the plus arms and the mic in weight.
const STOP_GLYPH = "M8 8H28V28H8Z";

/** Base64-encode WAV bytes in chunks (avoids the apply() arg-count limit). */
function wavBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
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
  onPointerLeave,
  disabled,
  active,
  pulse,
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
  onPointerLeave?: React.PointerEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  /** Breathe the accent glyph while a live capture is hot. */
  pulse?: boolean;
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
      onPointerLeave={disabled ? undefined : onPointerLeave}
      className={cn(
        // Icon-only control: transparent, borderless, no capsule — just the
        // glyph. Hover and active express through icon color alone — neutral
        // resting → neutral hover, accent for active — never a background/
        // border, never blue.
        //
        // Visible box 40px with a 20px mark (`[&_svg]:size-5` OVERRIDES the kit
        // Button's base `[&_svg]:size-4`): the composer marks sit quiet beside
        // the text instead of dominating the row. The 44×44 hit target (WCAG
        // 2.5.5) is preserved by the invisible `before` overlay that pads the
        // pointer zone back out past the visible box.
        "relative grid h-10 w-10 shrink-0 place-items-center bg-transparent p-0 transition-colors before:absolute before:-inset-0.5 before:content-[''] hover:bg-transparent [&_svg]:size-5",
        active ? "text-accent" : "text-muted-strong hover:text-txt",
        // Pulse the accent glyph while capture is hot; reduced-motion falls back
        // to the static accent without adding background or border chrome.
        pulse && "animate-pulse motion-reduce:animate-none",
        // Blocked controls (e.g. voice/transcript during sign-in-first
        // onboarding) read as inert: dimmed AND non-interactive to the pointer
        // (no hover color shift, no cursor) — matching the attachment "+".
        // Keyboard focus is unaffected, so the aria-disabled label still
        // announces.
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {Icon ? (
        <Icon aria-hidden={true} />
      ) : glyph ? (
        // Match the lucide marks: the parent [&_svg] rule governs the box, and
        // the widened glyph paths fill the same fraction of it.
        <Glyph d={glyph} className="size-5" />
      ) : null}
    </Button>
  );
}

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
  inert,
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
  // Inert while collapsed attachment controls are visible; their tap targets sit
  // in the same top edge zone the broad swipe handle normally owns.
  inert?: boolean;
}): React.JSX.Element {
  const disabled = pilled || inert;
  return (
    <motion.button
      style={{ opacity, pointerEvents: disabled ? "none" : "auto" }}
      // Invisible + inert while pilled: the pill capsule below owns the drag, so
      // keep this out of the tab order and the a11y tree until it's the handle.
      tabIndex={disabled ? -1 : undefined}
      aria-hidden={disabled || undefined}
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
        // input bar). The grab target is WIDE (a swipe-up from anywhere across
        // the composer's top edge opens the chat — the lock-screen "swipe up to
        // open" affordance) but STAYS ABOVE the input row so it never steals
        // taps meant for the textarea / +/mic controls below it.
        // z-20 keeps it above the input row (z-10) so it always wins the drag.
        "absolute inset-x-6 top-0.5 z-20 flex cursor-grab touch-none select-none items-center justify-center py-2 active:cursor-grabbing",
        // The invisible hit target reaches a comfortable distance ABOVE the
        // panel (a swipe-up begun in the empty field just over the composer is
        // caught) and STOPS at the handle's own bottom, so it never overlaps the
        // interactive composer row beneath — taps fall through to the input.
        "before:absolute before:-inset-x-2 before:-top-6 before:bottom-0 before:content-['']",
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
          "h-1.5 w-12 rounded-full opacity-100 transition-colors duration-300",
          // Pulse while the mic is hot / a reply is speaking: the warm bar
          // breathes instead of sitting static, the "audio is on" cue.
          glow && "animate-pulse bg-accent motion-reduce:animate-none",
        )}
        // Explicit fixed color (see HANDLE_BAR_COLOR) so the grabber — rendered
        // outside the panel theme — never inherits a dark ambient token.
        style={glow ? undefined : { backgroundColor: HANDLE_BAR_COLOR }}
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
        // floating mid-air; the tall pt + full width keep a generous upward grab/
        // flick zone so a swipe-up from anywhere across the bottom opens the chat
        // (the lock-screen affordance). Flex-center keeps the capsule centred
        // while the invisible hit area spans wide.
        "flex h-auto w-full cursor-grab touch-none select-none items-end justify-center rounded-none bg-transparent px-8 pb-1.5 pt-10 hover:bg-transparent active:cursor-grabbing",
        // Interactive only while pilled. When NOT pilled the (faded) handle must
        // let taps fall through to the composer textarea below it — otherwise its
        // tall hit zone steals the tap and the keyboard never opens.
        pilled ? "pointer-events-auto" : "pointer-events-none",
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
          "h-1.5 w-12 rounded-full opacity-100 transition-colors duration-300",
          // Same pulse as the SheetGrabber bar: while audio is on and the chat
          // is collapsed to the pill, the pill itself pulses.
          glow && "animate-pulse bg-accent motion-reduce:animate-none",
        )}
        // Same explicit color as the grabber bar so the two are pixel-identical
        // through the crossfade (HANDLE_BAR_COLOR).
        style={glow ? undefined : { backgroundColor: HANDLE_BAR_COLOR }}
      />
    </Button>
  );
}

/**
 * The rich, phase-aware status row shown while the assistant works (#8813),
 * replacing the bare typing dots in the pre-placeholder gap. Wraps the
 * canonical TurnStatus in its own glass bubble + fade so it reads as a turn.
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
          WALLPAPER_FLOAT_SHADOW,
          // Orange (the accent) ONLY for spoken replies; every other phase is
          // neutral white glass. No blue anywhere.
          // #10698: no own scrim — the shared panel glass carries the contrast;
          // keep only the tone border (orange when speaking) + WALLPAPER_FLOAT_SHADOW.
          speaking ? "border-accent/45" : "border-border",
        )}
      >
        <TurnStatus status={status} />
      </div>
    </motion.div>
  );
}

/**
 * Render a user turn's text, bolding a leading slash command so a sent
 * `/command` reads as a command in the transcript (mirroring the composer's
 * inline autocomplete). Plain prose renders unchanged.
 */
function ThreadLineText({ content }: { content: string }): React.ReactNode {
  const formSubmit = parseFormSubmitDisplay(content);
  if (formSubmit) return <FormSubmitReceipt label={formSubmit.label} />;
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

/**
 * The overlay's message BODY — everything rendered inside the canonical
 * ChatMessage glass row: the no-provider recovery gate, the in-flight breathing
 * dots (TurnStatus), a user turn's slash-bolded text, and a settled assistant
 * turn's inline widgets + attachments + secret request + reasoning. Kept
 * structurally identical to the ChatView (MessageContent) paths for the
 * affordances the render-parity contract pins; the row chrome (bubble,
 * tap-reveal actions, copy-hold, retry, suggestion) lives in ChatMessage.
 * `onOpenSettings` reaches only the no-provider gate.
 */
function renderOverlayMessageBody(
  message: ChatMessageData,
  ctx: ChatMessageRenderContext | undefined,
  onOpenSettings: (() => void) | undefined,
): React.ReactNode {
  const isUser = message.role === "user";
  const attachmentsNode = message.attachments?.length ? (
    <MessageAttachments attachments={message.attachments} />
  ) : null;

  if (!isUser && message.failureKind === "no_provider") {
    // A failure the user can't recover from without wiring a provider: a
    // structured gate (not the raw error text) with a one-tap jump to Settings.
    // #10698: minimize the own scrim now the shared glass carries contrast, but
    // keep a fill so this critical CTA stays prominent over any wallpaper.
    return (
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-bl-md border border-accent/30 bg-scrim px-3.5 py-3 text-txt",
          WALLPAPER_FLOAT_SHADOW,
        )}
      >
        <div className="mb-1 text-[14px] font-medium">
          Connect a provider to chat
        </div>
        <div className="mb-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-strong [overflow-wrap:anywhere]">
          {message.text}
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="chat-no-provider-settings"
          onClick={() => onOpenSettings?.()}
          className="h-auto rounded-full border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-txt transition-colors hover:bg-bg-hover"
        >
          Open Settings
        </Button>
      </div>
    );
  }

  if (!isUser && !message.text.trim() && !message.attachments?.length) {
    // The in-flight assistant turn: dots INSIDE the bubble, anchored where the
    // streamed text fills in — then the text replaces them. Labels stay in the
    // standalone status row so the bubble never flashes "Running …" text.
    return (
      <>
        <TurnStatus status={ctx?.turnStatus ?? null} showLabel={false} />
        {attachmentsNode}
      </>
    );
  }

  if (isUser) {
    // User turns stay raw text (leading slash command bolded).
    return (
      <>
        <ThreadLineText content={message.text} />
        {attachmentsNode}
      </>
    );
  }

  // Settled assistant turn: render inline widgets (task/choice/form/followups)
  // instead of leaking raw markers as text (#8997); plain replies fall through
  // the fast path unchanged. Attachments, the secret/OAuth request, and the
  // reasoning block render alongside. The secret block is pointer-events-auto so
  // it stays clickable inside the open thread's scroll surface.
  return (
    <>
      <InlineWidgetText content={message.text} />
      {attachmentsNode}
      {message.secretRequest ? (
        <div className="pointer-events-auto">
          <SensitiveRequestBlock request={message.secretRequest} />
        </div>
      ) : null}
      {message.toolEvents?.length ? (
        <div className="pointer-events-auto mt-2 flex flex-col gap-1.5">
          {message.toolEvents.map((event) => (
            <ToolCallEventLog key={event.callId ?? event.id} event={event} />
          ))}
        </div>
      ) : null}
      {!ctx?.suppressReasoning && message.reasoning?.trim() ? (
        <ThinkingBlock reasoning={message.reasoning} />
      ) : null}
    </>
  );
}

/** Project a shell transcript turn onto the canonical row's data shape. The
 *  body renderer reads the passthrough fields (reasoning/secretRequest/
 *  attachments/failureKind) straight off it, so the row stays presentation-only.
 *  Cached per ShellMessage identity so a live drag (which re-renders the overlay
 *  every pointer-move frame) reuses the same object — keeping ChatMessage's memo
 *  on its `prev.message === next.message` fast path. Shell turns are immutable
 *  (a streamed update replaces the object), so a changed turn misses the cache. */
const shellMessageDataCache = new WeakMap<ShellMessage, ChatMessageData>();
function shellToChatMessageData(m: ShellMessage): ChatMessageData {
  const cached = shellMessageDataCache.get(m);
  if (cached) return cached;
  const data: ChatMessageData = {
    id: m.id,
    role: m.role,
    text: m.content,
    ...(m.source ? { source: m.source } : {}),
    ...(m.failureKind ? { failureKind: m.failureKind } : {}),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolEvents?.length ? { toolEvents: m.toolEvents } : {}),
    ...(m.attachments ? { attachments: m.attachments } : {}),
    ...(m.secretRequest ? { secretRequest: m.secretRequest } : {}),
  };
  shellMessageDataCache.set(m, data);
  return data;
}

const FIRST_RUN_SIGN_IN_FALLBACK_MESSAGE: ShellMessage = {
  id: "first-run:cloud-signin-fallback",
  role: "assistant",
  source: "first_run",
  createdAt: 0,
  content: [
    "Hi — I'm Eliza.",
    "",
    "[CHOICE:first-run id=runtime]",
    "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
    "[/CHOICE]",
  ].join("\n"),
};
const FIRST_RUN_SIGN_IN_FALLBACK_DELAY_MS = 600;

function isFirstRunShellMessage(m: ShellMessage): boolean {
  return (
    m.id.startsWith("first-run:") ||
    m.source === "first_run" ||
    m.source === "first-run"
  );
}

function selectFirstRunDisplayMessages(
  messages: readonly ShellMessage[],
  showFallback: boolean,
): ShellMessage[] {
  const firstRunMessages = messages.filter(isFirstRunShellMessage);
  if (firstRunMessages.length === 0) {
    return showFallback ? [FIRST_RUN_SIGN_IN_FALLBACK_MESSAGE] : [];
  }

  const latest = firstRunMessages.at(-1);
  if (!latest) return [];

  const previous = firstRunMessages.at(-2);
  if (
    previous?.id === "first-run:appearance" &&
    latest.id === "first-run:tutorial"
  ) {
    return [previous, latest];
  }

  return [latest];
}

/**
 * Render a settled transcript row exactly as the overlay does (glass chrome,
 * settled body). Test-only seam for the component-tree render-parity contract
 * (render-parity.contract.test.tsx, #9954), which diffs this surface's
 * structure against ChatView's MessageContent over a shared corpus, and for the
 * proactive-suggestion affordance unit test (#8792 — optional accept/dismiss
 * handlers). Not part of the public overlay API — keep usage to those tests.
 */
export function __renderThreadLineForParity(
  message: ShellMessage,
  handlers?: {
    onAcceptSuggestion?: (message: ShellMessage) => void;
    onDismissSuggestion?: (messageId: string) => void;
  },
): React.JSX.Element {
  return (
    <ChatMessage
      appearance="glass"
      message={shellToChatMessageData(message)}
      onCopy={() => {}}
      onLongPressCopy={() => {}}
      renderContent={(m, ctx) => renderOverlayMessageBody(m, ctx, () => {})}
      onAcceptSuggestion={
        handlers?.onAcceptSuggestion
          ? () => handlers.onAcceptSuggestion?.(message)
          : undefined
      }
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
   * false` upstream). The overlay opens as the normal full-screen chat and pins
   * there: every collapse path (Escape, outside tap, drag/close) is a no-op,
   * the drag handle is hidden, and the backdrop is OPAQUE (`bg-bg`) so the
   * launcher/home behind is hidden. The composer is sign-in-first and locked;
   * the seeded transcript choice/OAuth widget is the only input until setup
   * completes. On the falling edge — onboarding just completed — the sheet
   * settles to half and the opaque backdrop fades to the normal scrim,
   * revealing the home screen.
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
    currentTab,
    stop,
    speak,
    stopSpeaking,
    speaking,
  } = controller;
  // True once the server has reported no LLM/model provider is configured (a
  // `no_provider` assistant turn). Defaulted for minimal mock controllers.
  const noProviderConfigured = controller.noProviderConfigured ?? false;
  // Local text-model readiness (#12178 WI-4). While it `blocksSend`, the
  // composer stays usable and the in-chat model-status card carries progress +
  // cancel/switch controls; the placeholder tells the user they can keep typing.
  const modelStatus = controller.modelStatus;
  const modelBlocksSend = modelStatus?.blocksSend ?? false;
  // App-level chat handlers shared with the desktop chat surface. The first-run
  // transcript's CHOICE widgets still use the action funnel inside their own
  // renderer; this overlay-level selection only needs message-management
  // handlers.
  const {
    handleChatDelete,
    handleSelectConversation,
    loadConversationMessagesAround,
  } = useAppSelectorShallow((s) => ({
    // Persistent per-message delete (#13533): server DELETE + optimistic
    // removal with rollback. Inert no-op in stories/tests with no AppContext.
    handleChatDelete: s.handleChatDelete,
    // Search-jump (#14279): select the hit's conversation, then (if the hit is
    // older than the loaded recent window) load a window centered on it before
    // scrolling. Inert no-ops in stories/tests with no AppContext.
    handleSelectConversation: s.handleSelectConversation,
    loadConversationMessagesAround: s.loadConversationMessagesAround,
  }));
  // Defensive default so a minimal mock controller (stories/tests) that predates
  // the swipe-nav surface still renders without crashing.
  const conversationNav = controller.conversationNav ?? EMPTY_CONVERSATION_NAV;
  // True while a clear/swipe is fetching an uncached thread — gates the empty
  // thread's loading spinner. Defaulted for minimal mock controllers.
  const conversationLoading = controller.conversationLoading ?? false;

  // Copy a message (reveal-row Copy). Stable identity so the memoized row isn't
  // re-rendered every parent tick. Copy is fire-and-forget UX, but the promise
  // must still be OBSERVED: an unhandled writeText rejection (permission-denied
  // environments) surfaces as a pageerror, which the ui-smoke diagnostics gate
  // rightly fails.
  const handleCopyMessage = React.useCallback((text: string) => {
    copyTextToClipboard(text).catch((err: unknown) => {
      // error-policy:J7 best-effort copy — the failure is logged, never thrown
      // into the gesture handler.
      logger.warn({ err }, "[ContinuousChatOverlay] copy to clipboard failed");
    });
  }, []);
  // Press-and-hold copy adds a light haptic on top of the copy (the only
  // extraction affordance on touch, where there is no hover row).
  const handleLongPressCopy = React.useCallback((text: string) => {
    copyTextToClipboard(text).catch((err: unknown) => {
      // error-policy:J7 best-effort copy — logged, never thrown (see above).
      logger.warn({ err }, "[ContinuousChatOverlay] copy to clipboard failed");
    });
    detentHaptic();
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
  // send path a typed turn uses, so the agent sees the corrected text. Adapts
  // the row's (id, text) → bool save contract onto the overlay's text-only
  // send; returning true tells the row the edit committed.
  const handleEditResend = React.useCallback(
    (_id: string, text: string): boolean => {
      send(text);
      return true;
    },
    [send],
  );

  // Persistent per-message delete from the glass row (#13533). Routes through
  // the app-level handler so the server DELETE + optimistic removal + rollback
  // are identical to the panel (ChatView) surface; the shell transcript mirrors
  // conversationMessages, so the row disappears optimistically and re-appears
  // if the DELETE fails.
  const handleDeleteMessage = React.useCallback(
    (id: string) => {
      void handleChatDelete?.(id);
    },
    [handleChatDelete],
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
  const {
    removeConversationMessage,
    conversationMessages,
    prependConversationMessages,
  } = useConversationMessages();
  const handleDismissSuggestion = React.useCallback(
    (messageId: string) => {
      removeConversationMessage(messageId);
    },
    [removeConversationMessage],
  );
  const handleAcceptSuggestion = React.useCallback(
    (m: ChatMessageData) => {
      send("Yes, let's do it.");
      removeConversationMessage(m.id);
    },
    [send, removeConversationMessage],
  );

  const slash = slashProp ?? EMPTY_SLASH_CONTROLLER;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  // The composer draft + pending attachments are the SHARED ChatComposerContext
  // slot (one draft per active conversation, edited by every surface): under
  // the app provider, AppContext owns the debounced per-conversation
  // persistence and useChatCallbacks.handleSelectConversation owns the
  // switch-time flush/restore handoff — a swipe here routes through
  // conversationNav → selectConversation → that same handoff, which repaints
  // this composer because it reads the context. The overlay keeps NO private
  // draft copy (#12188 Phase 3); stories/e2e fixtures without a provider fall
  // back to live local state inside useChatComposerOrLocal. Prefill
  // (CHAT_PREFILL / assistant-launch) and dictation setDraft() writes are
  // persisted upstream like any keystroke; the successful-send path clears the
  // stored draft immediately (below).
  const {
    chatInput: draft,
    setChatInput: setDraft,
    chatPendingImages: pendingImages,
    setChatPendingImages: setPendingImages,
    chatReplyTarget,
    setChatReplyTarget,
  } = useChatComposerOrLocal();
  const activeConversationId = conversationNav.activeId;
  // Live handle to the draft for callbacks that must read the current text
  // without subscribing (dictation append), same pattern as messagesRef above.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  // Live handle to the active conversation id for the send path's draft clear,
  // so submitText keeps its stable identity.
  const activeConversationIdRef = React.useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const composerHadDraftRef = React.useRef(draft.trim().length > 0);
  const composerPauseTimerRef = React.useRef<number | null>(null);
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
  // Onboarding openness pin: while first-run is active the sheet is
  // structurally FULL and undismissable (see firstRunOpen docs above).
  const pinnedOpen = firstRunOpen;
  const [mode, setMode] = React.useState<ChatMode>(
    pinnedOpen ? "full" : "input",
  );
  // The pin-at-full + auto-collapse edge effect lives below `goToDetent` (it
  // needs the detent animator); the mount state above still opens FULL first.
  //
  // During onboarding the sheet MUST stay open — the seeded greeting + choices
  // are the only way forward and the composer is frozen behind them. Deriving
  // openness from the effect alone proved raceable on a home-view boot (the
  // sheet could settle collapsed with the options hidden behind the grabber and
  // only a misleading "tap an option above" hint showing). Pin it STRUCTURALLY:
  // while onboarding is active, the derived openness is always FULL regardless
  // of the underlying `mode` transition state. The effect still drives the real
  // `mode` so the falling edge collapses correctly.
  const effectiveMode: ChatMode = pinnedOpen ? "full" : mode;
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
  // leave-full transition resets it. Pinned sessions start here: first-run opens
  // edge-to-edge full-screen, then its falling edge collapses to half.
  const [maximized, setMaximized] = React.useState(pinnedOpen);
  // A restore drag is in flight (pull-down out of full-bleed). Declared up here
  // (not by the restore binding) because `fullBleedFrame` below reads it to keep
  // the panel MAX-HEIGHT full-screen-sized for the drag (so the height can track
  // the finger without clamping), and that feeds `panelMaxH` computed before the
  // binding. Keeping the strip mounted while true also preserves the pointer
  // capture across the un-maximize (the "can't collapse" bug). See the binding.
  const [restoreDragging, setRestoreDragging] = React.useState(false);
  // Whether the in-flight restore drag has turned downward and dropped
  // full-bleed. A ref (not the `maximized` state) because the release handler
  // runs in the SAME event as the drop and would otherwise read the stale,
  // pre-re-render `maximized` and snap back instead of resting where released.
  const restoreDidUnmaximizeRef = React.useRef(false);
  // Highest (most-upward) offset the current restore drag has reached. The
  // ceiling-consumption rebase in onDragOffset absorbs any upward drift while
  // the panel sits at the full-bleed ceiling, so a raw `offset < 0` test fires
  // late: the sheet already follows the finger DOWN off the ceiling (its
  // fullBleedT un-morphs) for the first N px while `offset` is still positive,
  // and a release in that window would snap back to full-bleed. Un-maximize the
  // instant the finger nets downward from this peak instead.
  const restorePeakOffsetRef = React.useRef(0);
  // Reactive composer-focus flag. Only the short-landscape compact resting
  // affordance reads it (#14173): focusing the field lifts the compact treatment
  // so the composer widens to full BEFORE the first keystroke, and blurring an
  // empty composer settles it back to compact. Elsewhere focus is tracked via
  // refs (composerFocusedAtPressRef) that must not trigger a re-render.
  const [composerFocused, setComposerFocused] = React.useState(false);
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
  const prefillFocusFrameRef = React.useRef<number | null>(null);
  const prefillFocusTimerRef = React.useRef<number | null>(null);
  // A GPU-compositing hint scoped to an ACTIVE drag/settle only. While the
  // finger drives the panel (`scale`/`flexBasis` change every frame) and while
  // the release spring runs, we set `will-change: transform` on the panel (and
  // suppress the thread's edge mask) so iOS Safari/WebKit promotes the morph to
  // its own compositor layer up front — it then composites without a per-frame
  // repaint of the frosted glass + content (the visible micro-stutter on the
  // installed PWA). Deliberately NOT permanent: `will-change` keeps a promoted
  // layer (and its memory) resident, so we drop it the instant the release
  // spring settles. A ref mirrors it for the guarded setter so per-frame drag
  // updates never cause a redundant re-render.
  const [isDragging, setDragging] = React.useState(false);
  const isDraggingRef = React.useRef(false);
  const setDraggingState = React.useCallback((dragging: boolean) => {
    if (isDraggingRef.current === dragging) return;
    isDraggingRef.current = dragging;
    setDragging(dragging);
  }, []);
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
      const controls = animate(threadHeight, target, SHEET_SPRING);
      threadAnimationRef.current = controls;
      // Drop the drag-scoped GPU promotion only once the RELEASE spring has come
      // to rest — clearing it on release itself would strip `will-change` mid
      // settle-spring and repaint exactly when the panel is still moving. A stop
      // (a new gesture interrupting) rejects `.finished`, so keep the layer for
      // the incoming drag; only a clean finish drops it.
      controls.finished
        .then(() => {
          if (!isDraggingRef.current) return;
          if (draggingRef.current) return; // a new drag started meanwhile
          setDraggingState(false);
        })
        .catch(() => {
          // Interrupted by a fresh gesture (stop) — keep the promotion resident.
        });
      return controls;
    },
    [stopThreadAnimation, threadHeight, setDraggingState],
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
  // A pointer is pressed on the open-sheet grabber / the maximize-restore strip
  // RIGHT NOW. Each gates ITS element's mount (below) so the handle survives any
  // re-render between the pointerdown and the gesture's first integrated frame.
  // The mount gates otherwise keep an element alive only once `draggingRef` /
  // `restoreDragging` go live — which happens on that first frame, not the press
  // — leaving a window where a re-render (a late settle landing under a loaded
  // main thread) unmounts the element UNDER the captured pointer. Chromium then
  // fires pointercancel + lostpointercapture on the dead node and the gesture's
  // release never runs its settle: the grabber drag dies mid-morph, and worse,
  // the restore strip strands `restoreDragging`/`draggingRef` true (freezing the
  // sheet's settle springs — the desktop-held FULL→bottom drain then reads the
  // corrupted sheet and never engages, stuck at scale 1.00). Held deliberately
  // OUT of the settle-suppression guards (unlike `draggingRef`): they only keep
  // the element mounted. Each ref holds the ACCEPTED pointer's id (#15824), not
  // a boolean: only an eligible primary press latches (the browser guarantees a
  // terminal for a captured press — an ineligible one gets no capture and no
  // such guarantee), and only that pointer's own terminal clears it, so a
  // secondary finger's up can never unlatch a still-held primary drag.
  const grabberPressRef = React.useRef<number | null>(null);
  const restorePressRef = React.useRef<number | null>(null);
  // Peak RAW (pre-clamp) pull height reached during the current upward drag
  // (#13531). The visible `threadHeight` is rubber-band-clamped at `openH`, so a
  // deliberate over-pull past FULL is invisible to a `threadHeight.get()` read on
  // release. This ref records the true finger height each frame so the release
  // path can tell an over-pull past the 80%-viewport maximize threshold from a
  // plain release at FULL. Reset to 0 at the start of every gesture.
  const maxPullRawRef = React.useRef(0);
  // Thread height at the START of the current gesture. Release paths that land
  // at the bottom use it to tell a big yank (started at/above the half detent →
  // the user is putting the chat away → PILL) from a short close (started low →
  // INPUT). Distance-past-the-bottom alone can't make that call: a maximized
  // sheet fills the screen, so the finger physically runs out of room to
  // overshoot below it.
  const dragStartHRef = React.useRef(0);
  // THE drag integrator. The whole pill → input → chat → full-bleed continuum
  // is ONE coordinate: -PILL_OPEN_DISTANCE (pill capsule) through 0 (input bar)
  // up to the full-bleed ceiling. Each pointer frame integrates the frame's
  // delta into it and clamps at both ends, so the sheet follows the pointer's
  // POSITION exactly — travel past an edge is consumed (not banked), and a
  // reversal moves the sheet on its very first pixel. Because the value is a
  // per-frame integral (not baseH + total offset), an up-down-up mouse drag can
  // never drift out of sync with the cursor, and mode/maximize state flips
  // mid-gesture never re-base anything.
  const dragContRef = React.useRef(0);
  // The last integrated gesture offset (px, up-positive, 0 at pointerdown);
  // per-frame delta = offset - this.
  const dragLastOffsetRef = React.useRef(0);
  // Continuum position at gesture start (< 0 when the gesture began on the
  // pill). Release intent maths (peak TRAVEL for the long-haul maximize) need
  // it: a pull from the pill spends PILL_OPEN_DISTANCE of travel forming the
  // input before any height exists.
  const dragStartContRef = React.useRef(0);
  // Maximize-morph tracking. Raw height is the deterministic source while the
  // sheet is already open; measured top-edge pinning supplements it for long
  // pill/input hauls where the visual panel reaches its inset ceiling before the
  // raw travel has consumed the whole morph budget. These latch that pin phase.
  const dragMinTopRef = React.useRef(Number.POSITIVE_INFINITY);
  const dragPinnedRef = React.useRef(false);
  const dragOffAtPinRef = React.useRef(0);
  const dragPinTopRef = React.useRef(0);

  const resetPullPeak = React.useCallback(() => {
    maxPullRawRef.current = 0;
  }, []);
  const dragStartTopRef = React.useRef(0);
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
  // Push-to-talk is a label-only mirror of the shared hold hook's holding phase.
  const [pttHolding, setPttHolding] = React.useState(false);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLFieldSetElement>(null);
  const [panelElement, setPanelElement] =
    React.useState<HTMLFieldSetElement | null>(null);
  const bindPanelRef = React.useCallback((node: HTMLFieldSetElement | null) => {
    panelRef.current = node;
    setPanelElement(node);
  }, []);
  const getPanelElement = React.useCallback(() => {
    if (panelElement) return panelElement;
    if (panelRef.current) return panelRef.current;
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLFieldSetElement>(
      '[data-testid="chat-sheet"]',
    );
  }, [panelElement]);
  // The transcript's inner content wrapper — measured to size the onboarding
  // sheet to its content (grow-from-the-bottom) instead of a tall empty panel.
  const threadContentRef = React.useRef<HTMLDivElement>(null);
  const layoutShiftIntentTimerRef = React.useRef<number | null>(null);
  const layoutShiftIntentLastMotionRef = React.useRef(0);
  const markLayoutShiftIntent = React.useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || typeof window === "undefined") return;
    // Arm ONCE per motion burst (#15257): this fires on EVERY threadHeight
    // tick (60+/s across a whole drag or settle spring). While armed, a tick
    // only refreshes the last-motion timestamp — no attribute write, no timer
    // churn. The single clear timer extends itself while motion continues and
    // removes the marker ~180ms after the last tick.
    layoutShiftIntentLastMotionRef.current = performance.now();
    if (layoutShiftIntentTimerRef.current !== null) return;
    overlay.setAttribute(
      LAYOUT_SHIFT_INTENT_ATTR,
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );
    const scheduleClear = (delay: number) => {
      layoutShiftIntentTimerRef.current = window.setTimeout(() => {
        const since =
          performance.now() - layoutShiftIntentLastMotionRef.current;
        if (since < 180) {
          scheduleClear(180 - since);
          return;
        }
        layoutShiftIntentTimerRef.current = null;
        overlayRef.current?.removeAttribute(LAYOUT_SHIFT_INTENT_ATTR);
      }, delay);
    };
    scheduleClear(180);
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
    const panel = getPanelElement();
    const root = document.documentElement;
    if (sheetOpen) return; // Keep the last resting value while the sheet is open.
    if (!panel) return;
    const publish = () => {
      const h = panel.getBoundingClientRect().height;
      // Cap it: a mid-collapse frame can report the open panel height, and
      // reserving that in the home/launcher layout clips the top apps off-screen.
      if (h > 0)
        root.style.setProperty(
          "--eliza-continuous-chat-clearance",
          `${Math.min(Math.ceil(h), CHAT_CLEARANCE_MAX_PX)}px`,
        );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [sheetOpen, getPanelElement]);
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
  // re-render. Pure windowing (empty-turn filter, with the streaming-assistant
  // exception) lives in shell-state so it's unit-tested; the count of renderable
  // turns drives the scroll-up reveal-before-fetch policy.
  const renderableMessages = React.useMemo(
    () => filterRenderableShellMessages(messages, phase),
    [messages, phase],
  );
  // Mirror the active id so an async older-page result is dropped after a
  // mid-flight conversation switch: a page fetched for the previous thread must
  // never prepend into the newly active one.
  const loadOlderConversationIdRef = React.useRef(activeConversationId);
  loadOlderConversationIdRef.current = activeConversationId;
  const fetchOlder = React.useCallback(async () => {
    const conversationId = activeConversationId;
    if (!conversationId) return { hasMore: false, prependedCount: 0 };
    return await loadOlderConversationMessages({
      client,
      conversationId,
      currentMessages: conversationMessages,
      prependMessages: (older) => {
        if (loadOlderConversationIdRef.current === conversationId) {
          prependConversationMessages(older);
        }
      },
    });
  }, [activeConversationId, conversationMessages, prependConversationMessages]);
  // The render window slides UP as the reader scrolls into history (#14329,
  // #15281): it opens at MAX_RENDERED_SHELL_MESSAGES (lean idle/drag DOM) and
  // grows a page per scroll-to-top — first revealing already-loaded turns, then
  // paging older ones in — bounded by MAX_LOADED_SHELL_WINDOW so a long thread
  // never unbounds the DOM. The one shared engine (also drives ChatView),
  // reset when the active conversation changes.
  const renderWindow = useConversationRenderWindow({
    renderableCount: renderableMessages.length,
    conversationKey: activeConversationId,
    fetchOlder,
  });
  const hasFirstRunMessages = React.useMemo(
    () => renderableMessages.some(isFirstRunShellMessage),
    [renderableMessages],
  );
  const [firstRunFallbackReady, setFirstRunFallbackReady] =
    React.useState(false);
  React.useEffect(() => {
    if (!firstRunOpen || hasFirstRunMessages) {
      setFirstRunFallbackReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setFirstRunFallbackReady(true);
    }, FIRST_RUN_SIGN_IN_FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [firstRunOpen, hasFirstRunMessages]);
  const visibleMessages = React.useMemo(() => {
    if (firstRunOpen)
      return selectFirstRunDisplayMessages(
        renderableMessages,
        firstRunFallbackReady,
      );
    return renderableMessages.length > renderWindow.windowSize
      ? renderableMessages.slice(-renderWindow.windowSize)
      : renderableMessages;
  }, [
    firstRunFallbackReady,
    firstRunOpen,
    renderableMessages,
    renderWindow.windowSize,
  ]);
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  // The thread body is mounted while the sheet is open OR during an upward
  // drag's inert preview; the auto-scroll engine runs exactly then.
  const threadPresented = sheetOpen || dragPreviewVisible;
  // Keep the transcript pinned to the latest line via the one shared
  // thread-scroll engine (useThreadAutoScroll): first reveal pins instantly
  // (pre-paint — the thread never flashes at the top), a NEW line re-pins with
  // a smooth glide while the reader rests at the bottom, streaming growth
  // follows in a single rAF, and a reader who scrolled up is never yanked.
  const {
    scrollRef: threadRef,
    atBottom: threadAtBottom,
    jumpToLatest,
  } = useThreadAutoScroll<HTMLDivElement>({
    growthKey: `${visibleMessages.length}:${lastId ?? ""}:${lastContent.length}`,
    lineKey: lastId ?? "",
    enabled: threadPresented,
    reduceMotion: reduce,
  });
  // Focus the thread for keyboard scrolling when an opener requested it —
  // consumed on the reveal edge, separate from the scroll engine above.
  React.useLayoutEffect(() => {
    if (sheetOpen && focusThreadRef.current) {
      threadRef.current?.focus();
      focusThreadRef.current = false;
    }
  }, [sheetOpen, threadRef]);
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

  // Topic grouping + chips bar (#8928). Derived from the per-message Stage-1
  // topic tags. The chips rail and dividers ONLY earn their pixels once a
  // transcript genuinely spans MULTIPLE topics — a fresh/single-subject thread
  // renders flat so the lock-screen chat opens clean (no machine-topic pill
  // top-left, no "— GREETING —" divider above the only group). See
  // `hasMultipleTopicGroups`. Chip labels are humanized from the tagger's
  // machine slugs (`user_greeting` → "User Greeting").
  const topicSegments = React.useMemo(
    () => groupMessagesByTopic(visibleMessages),
    [visibleMessages],
  );
  const hasTopics = React.useMemo(
    () => hasMultipleTopicGroups(topicSegments),
    [topicSegments],
  );
  const channelTopics = React.useMemo(
    () => deriveChannelTopics(visibleMessages),
    [visibleMessages],
  );

  // ── Infinite upward scroll (#13532/#14329), wired into the overlay per #14279
  // The overlay is the primary mobile/PWA chat surface. Share the SAME scroller
  // (`threadRef`, owned by useThreadAutoScroll for bottom-follow) plus a top
  // sentinel so a scroll toward the oldest line seamlessly reveals/prepends an
  // older page — viewport anchored (no jump) by useLoadOlderOnScroll. Paging +
  // windowing state lives in the shared useConversationRenderWindow above.
  const topSentinelRef = React.useRef<HTMLDivElement>(null);
  useLoadOlderOnScroll<HTMLDivElement>({
    scrollRef: threadRef,
    sentinelRef: topSentinelRef,
    onLoadOlder: renderWindow.onLoadOlder,
    // Topic grouping wraps rows in collapsible segments, which breaks the
    // sentinel's flat-prepend anchor math; restrict load-older to the flat
    // transcript (the common case). A topic-grouped thread still shows its
    // recent window; scroll-up paging there is a follow-up.
    hasMore: !hasTopics && renderWindow.canLoadOlder,
    topItemKey: visibleMessages[0]?.id ?? "",
    enabled: threadPresented && !hasTopics,
  });

  // ── Message search across previous chats (#9955, wired into the overlay per
  //    #14279) ─────────────────────────────────────────────────────────
  // A quiet search entry point in the sheet header opens the shared
  // MessageSearchPanel. Search runs against the server keyword endpoint (ranked
  // by relevance then recency — already smarter than a naive substring scan);
  // a hit jumps to its conversation + message, loading a centered window if the
  // hit predates the loaded recent window, then scroll-flashes the anchor.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const openSearch = React.useCallback(() => {
    // Grow the sheet to FULL when search opens so the results region has the
    // most room above a raised keyboard (the panel bottom-anchors its input
    // right above the keyboard; the taller the sheet, the more results are
    // visible in the space above it). The header — hence the search control —
    // only exists at half+, so this only ever grows the sheet, never shrinks it.
    setFreeH(null);
    setMode("full");
    setSearchOpen(true);
  }, []);
  const closeSearch = React.useCallback(() => setSearchOpen(false), []);
  // Collapse search when the sheet closes so a re-open lands on the transcript.
  React.useEffect(() => {
    if (!sheetOpen) setSearchOpen(false);
  }, [sheetOpen]);
  const runMessageSearch = React.useCallback(
    async (query: string, signal: AbortSignal) => {
      const { results } = await client.searchConversationMessages(query, {
        signal,
      });
      return results;
    },
    [],
  );
  // Poll a bounded number of frames for the anchor to mount (the thread
  // re-renders asynchronously after a selection / window load), then resolve it
  // or null once the frame budget is spent.
  const waitForSearchAnchor = React.useCallback(
    (anchorId: string, maxFrames: number): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        if (typeof requestAnimationFrame === "undefined") {
          resolve(document.getElementById(anchorId));
          return;
        }
        let frames = 0;
        const step = () => {
          const el = document.getElementById(anchorId);
          if (el) {
            resolve(el);
            return;
          }
          if (frames++ < maxFrames) {
            requestAnimationFrame(step);
            return;
          }
          resolve(null);
        };
        requestAnimationFrame(step);
      }),
    [],
  );
  const scrollAndFlashSearchAnchor = React.useCallback((el: HTMLElement) => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.style.transition = "outline-color 0.5s ease-out";
    el.style.outline = "2px solid var(--primary)";
    el.style.outlineOffset = "2px";
    el.style.borderRadius = "8px";
    window.setTimeout(() => {
      el.style.outline = "2px solid transparent";
    }, 1200);
    window.setTimeout(() => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.style.removeProperty("transition");
    }, 1800);
  }, []);
  const handleSearchJump = React.useCallback(
    (result: ConversationMessageSearchResult) => {
      const anchorId = getChatMessageAnchorId(result.messageId);
      void (async () => {
        // Select the hit's conversation and let its recent window load first, so
        // the in-window case (the common one) scrolls without a second fetch.
        await handleSelectConversation(result.conversationId);
        let el = await waitForSearchAnchor(anchorId, 20);
        if (!el) {
          // The hit predates the loaded recent window: load a window CENTERED on
          // it, then reveal the full loaded set so the centered pivot is not
          // sliced out of the render window (#15281) — without the reveal a
          // windowed transcript drops the anchor and the jump silently no-ops.
          const loaded = await loadConversationMessagesAround(
            result.conversationId,
            result.messageId,
          );
          if (loaded) {
            renderWindow.revealFullWindow();
            el = await waitForSearchAnchor(anchorId, 20);
          }
        }
        if (el) scrollAndFlashSearchAnchor(el);
      })();
    },
    [
      handleSelectConversation,
      loadConversationMessagesAround,
      waitForSearchAnchor,
      scrollAndFlashSearchAnchor,
      renderWindow.revealFullWindow,
    ],
  );

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadRef is the stable ref object returned by useThreadAutoScroll (a useRef); reading .current in the rAF is not a dependency.
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
  // The single, stable body renderer handed to every row (see
  // renderOverlayMessageBody). Stable identity keeps ChatMessage's memo intact;
  // per-row volatile values (turnStatus/suppressReasoning) flow via renderContext.
  const renderRowBody = React.useCallback(
    (m: ChatMessageData, ctx: ChatMessageRenderContext | undefined) =>
      renderOverlayMessageBody(m, ctx, openSettings),
    [openSettings],
  );
  // Reply arms the shared composer reply target so the next send() stamps
  // replyToMessageId (attached at the sendChatText chokepoint → REPLY_CONTEXT)
  // and the pill renders above the input. Opens the sheet so the reply is typed
  // against the visible thread, not the bare collapsed bar.
  const handleReplyMessage = React.useCallback(
    (message: ChatMessageData) => {
      setChatReplyTarget(buildReplyTargetFromMessage(message, agentName));
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
      inputRef.current?.focus();
    },
    [setChatReplyTarget, agentName],
  );
  // Render one transcript line as the canonical ChatMessage (glass chrome);
  // shared by the flat and topic-grouped paths so the in-flight-turn detection
  // stays identical.
  const renderThreadLine = React.useCallback(
    (m: ShellMessage, index: number) => {
      const isLastAssistant =
        index === visibleMessages.length - 1 && m.role === "assistant";
      const isInFlight = isLastAssistant && !m.content.trim();
      // Only the last assistant turn reads volatile status; every settled row
      // gets no renderContext so its memo identity is unchanged.
      const renderContext: ChatMessageRenderContext | undefined =
        isLastAssistant
          ? {
              turnStatus: isInFlight ? turnStatus : null,
              suppressReasoning: responding,
            }
          : undefined;
      return (
        <ChatMessage
          key={m.id}
          // Always the app's canonical glass chrome — onboarding included. The
          // first-run greeting used to force "panel" (a bordered card), a
          // different, duplicate-looking bubble from the real in-app chat; glass
          // is the chromeless bubble with the same rise/fade entrance, matching
          // the app and the documented first-run intent (agent prose floats as
          // plain wallpaper text with its CTA beneath).
          appearance="glass"
          agentName={agentName}
          message={shellToChatMessageData(m)}
          reduceMotion={reduce}
          onCopy={handleCopyMessage}
          onLongPressCopy={handleLongPressCopy}
          onSpeak={handleSpeakMessage}
          onEdit={handleEditResend}
          onDelete={handleDeleteMessage}
          onReply={handleReplyMessage}
          onRetry={handleRetry}
          playing={speaking && playingMessageId === m.id}
          renderContent={renderRowBody}
          renderContext={renderContext}
          onAcceptSuggestion={handleAcceptSuggestion}
          onDismissSuggestion={handleDismissSuggestion}
        />
      );
    },
    [
      visibleMessages.length,
      agentName,
      reduce,
      handleCopyMessage,
      handleLongPressCopy,
      handleSpeakMessage,
      handleEditResend,
      handleDeleteMessage,
      handleReplyMessage,
      handleRetry,
      speaking,
      playingMessageId,
      responding,
      turnStatus,
      renderRowBody,
      handleAcceptSuggestion,
      handleDismissSuggestion,
    ],
  );

  const booting = phase === "booting";
  const listening = phase === "listening";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;
  React.useEffect(() => {
    const draftLength = draft.trim().length;
    if (composerPauseTimerRef.current !== null) {
      window.clearTimeout(composerPauseTimerRef.current);
      composerPauseTimerRef.current = null;
    }
    if (draftLength === 0) {
      composerHadDraftRef.current = false;
      return;
    }
    if (!composerHadDraftRef.current) {
      reportComposerActivity({
        activity: "typing_started",
        surface: COMPOSER_ACTIVITY_SURFACE,
        conversationId: activeConversationId,
        draftLength,
      });
      composerHadDraftRef.current = true;
    }
    composerPauseTimerRef.current = window.setTimeout(() => {
      reportComposerActivity({
        activity: "typing_paused",
        surface: COMPOSER_ACTIVITY_SURFACE,
        conversationId: activeConversationIdRef.current,
        draftLength: draftRef.current.trim().length,
        idleForMs: COMPOSER_TYPING_PAUSE_MS,
      });
      composerPauseTimerRef.current = null;
    }, COMPOSER_TYPING_PAUSE_MS);
    return () => {
      if (composerPauseTimerRef.current !== null) {
        window.clearTimeout(composerPauseTimerRef.current);
        composerPauseTimerRef.current = null;
      }
    };
  }, [activeConversationId, draft]);

  // Send `text` (and optional images) through the normal chat pipeline, clearing
  // the composer. Shared by the send button and the slash menu (agent commands).
  const submitText = React.useCallback(
    (text: string, images: ImageAttachment[] = []) => {
      const trimmed = text.trim();
      // An image-only turn is valid; only bail when there's nothing to send.
      if (!trimmed && images.length === 0) return;
      // During onboarding the composer is sign-in-first and locked. Ignore any
      // synthetic draft entry point that reaches submit, and keep setup choice
      // handling inside the transcript widgets.
      if (firstRunOpen) {
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        inputRef.current?.focus();
        return;
      }
      // Explicit tutorial commands ("start/stop/restart tutorial") drive the
      // chat-native tour locally — never an agent turn. Text-only: a turn
      // carrying images is a real message, not a command. Sits BEFORE the
      // canSend gate because the tour is fully client-side and must work with
      // the agent stopped.
      if (trimmed && images.length === 0 && tryHandleTutorialText(trimmed)) {
        clearChatDraft(activeConversationIdRef.current);
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        inputRef.current?.focus();
        return;
      }
      // Post-onboarding: a stopped agent can't take a turn.
      if (!canSend) return;
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
    [canSend, firstRunOpen, send, setDraft, setPendingImages, viewChatBinding],
  );

  const addImageFiles = React.useCallback(
    (files: FileList | File[]) => {
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
    },
    [setPendingImages],
  );

  const removeImage = React.useCallback(
    (index: number) => {
      setPendingImages((prev) => prev.filter((_, i) => i !== index));
    },
    [setPendingImages],
  );

  // ── Push-to-talk ────────────────────────────────────────────────────────────
  // Press-and-hold on the mic dictates into the composer draft (no send); a
  // quick tap falls through to handleMicClick → toggleHandsFree. The hold/tap/
  // slide-off/click-suppression machine is the shared usePushToTalk hook — the
  // overlay only supplies its can-begin guard and the dictation start/stop.
  const { handlers: micHoldHandlers, shouldSuppressClick } = usePushToTalk({
    // Arm only when idle with no draft and no capture already live (a tap while
    // hands-free toggles it off — handleMicClick). Voice input is gated while a
    // reply is in flight; type + send to queue another turn instead.
    canBegin: () =>
      !hasDraft && !recording && !transcriptionMode && !responding,
    onHoldStart: () => {
      setPttHolding(true);
      startRecording("dictate");
    },
    onHoldEnd: () => {
      // Dictation always inserts into the draft; there is no submit-on-release,
      // so a clean release and a slide-off both just stop the capture.
      stopRecording();
      setPttHolding(false);
    },
  });

  const handleMicClick = React.useCallback(() => {
    // Trace the home-overlay mic tap BEFORE any branching so the on-screen HUD
    // captures the tap even when this handler early-returns short of capture.
    voiceCaptureDebug("mic:tap", {
      surface: "overlay",
      transcriptionMode,
      responding,
      handsFree,
    });
    // Swallow exactly the one click that follows a held PTT release.
    if (shouldSuppressClick()) {
      voiceCaptureDebug("mic:noop", { reason: "suppress-click" });
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
      voiceCaptureDebug("mic:branch", { action: "stop-transcription" });
      stopTranscriptionAndMic();
      return;
    }
    // Voice can't be turned ON while a reply is in flight (it's gated until the
    // turn finishes), but an active hands-free session can always be turned OFF.
    if (responding && !handsFree) {
      voiceCaptureDebug("mic:noop", { reason: "responding-not-handsfree" });
      return;
    }
    // Quick tap = hands-free conversation: the agent speaks its replies back and
    // the mic re-opens after each one. Tap again to end.
    voiceCaptureDebug("mic:branch", { action: "toggle-handsfree" });
    toggleHandsFree();
  }, [
    responding,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    stopTranscriptionAndMic,
    shouldSuppressClick,
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
      return {
        height: 800,
        keyboardInset: 0,
        innerHeight: 800,
        innerWidth: 1280,
      };
    const vv = window.visualViewport;
    const innerHeight = window.innerHeight;
    const height = vv?.height ?? innerHeight;
    // On iOS standalone/native, the soft keyboard can shrink innerHeight and
    // visualViewport.height together, making their delta read as zero. The
    // gated screen-height signal recovers that keyboard intrusion on the same
    // surfaces that install the bottom reclaim. The threshold filters the
    // smaller resting collapse band so it is never treated as a keyboard.
    let keyboardInset = 0;
    if (vv) {
      const insetFromInner = Math.max(
        0,
        innerHeight - vv.height - vv.offsetTop,
      );
      let screenKeyboard = 0;
      if (SCREEN_KEYBOARD_SIGNAL_ACTIVE) {
        const screenHeight =
          typeof window.screen?.height === "number" && window.screen.height > 0
            ? window.screen.height
            : 0;
        const insetFromScreen =
          screenHeight > 0
            ? Math.max(0, screenHeight - vv.height - vv.offsetTop)
            : 0;
        // Only trust the screen-based signal once it clears the resting-collapse
        // band (so the ~59px fixed-body ICB collapse is never a keyboard).
        screenKeyboard =
          insetFromScreen >= KEYBOARD_INTRUSION_THRESHOLD_PX
            ? insetFromScreen
            : 0;
      }
      keyboardInset = Math.max(insetFromInner, screenKeyboard);
    }
    // innerHeight is the LAYOUT viewport: on Android it shrinks (adjustResize)
    // when the keyboard opens, on iOS (`resize: "body"`) it does not. The lift
    // math below uses that to avoid double-counting the keyboard. innerWidth +
    // innerHeight also drive the short-landscape compact treatment (#14173) —
    // the LAYOUT viewport so a raised keyboard never flips the orientation read.
    return {
      height,
      keyboardInset,
      innerHeight,
      innerWidth: window.innerWidth,
    };
  }, []);
  const [viewport, setViewport] = React.useState(readViewport);
  const [bottomPad, setBottomPad] = React.useState(0);
  // The real `env(safe-area-inset-top)` in px, so the full-bleed header reserves
  // the actual notch/Dynamic-Island inset instead of a fixed guess. Re-measured
  // on rotation (`resize`); it never changes between resizes, so it stays off the
  // high-rate vv `scroll`.
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
  // Coalesce the high-rate vv `scroll` to at most one commit per frame (shared
  // useRafCoalescer) so the keyboard-animation storm can't drive >60 forced
  // style reads + setStates/s.
  const viewportSync = useRafCoalescer<void>(() => {
    // Bail out of the re-render when the viewport values are unchanged — vv
    // `scroll` fires constantly while the keyboard animates but the height/
    // inset frequently don't actually move between events.
    setViewport((prev) => {
      const next = readViewport();
      return prev.height === next.height &&
        prev.keyboardInset === next.keyboardInset &&
        prev.innerHeight === next.innerHeight &&
        prev.innerWidth === next.innerWidth
        ? prev
        : next;
    });
    const el = overlayRef.current;
    if (el) {
      const pad = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
      setBottomPad((prev) => (prev === pad ? prev : pad));
    }
  });
  // Depend on the coalescer's stable methods, NOT the wrapper object (which is a
  // fresh literal each render) — otherwise this effect re-runs every render and
  // re-fires settleDragRef mid-drag, stranding an in-progress sheet gesture.
  const scheduleViewportSync = viewportSync.schedule;
  const cancelViewportSync = viewportSync.cancel;
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => scheduleViewportSync(undefined);
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
      cancelViewportSync();
      window.removeEventListener("resize", syncAndSettleWindow);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, [scheduleViewportSync, cancelViewportSync]);
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
          // error-policy:J6 best-effort native listener registration; the
          // visualViewport path (outer catch) covers keyboard insets otherwise.
          .catch(() => {});
        void Keyboard.addListener("keyboardWillHide", () => {
          setNativeKeyboardHeight(0);
        })
          .then((handle) => {
            if (cancelled) handle.remove();
            else handles.push(handle);
          })
          // error-policy:J6 best-effort native listener registration; the
          // visualViewport path (outer catch) covers keyboard insets otherwise.
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
  // A REAL keyboard (not the few-px inset mobile emulation reports) blocks the
  // over-pull maximize: the edge-to-edge panel is sized against the LAYOUT
  // viewport, so with the keyboard up it would spill above the shrunk visual
  // viewport. Gating on the same intrusion threshold the keyboardInset math uses
  // keeps a genuine keyboard from over-maximizing while never tripping on the
  // sub-threshold inset a touch page carries at rest.
  const keyboardBlocksMaximize =
    effectiveKeyboardInset >= KEYBOARD_INTRUSION_THRESHOLD_PX;

  // FULL-SCREEN derived gate: maximized only takes effect AT the full detent, so
  // a stale flag can never leak into half/collapsed/pill. Drives the edge-to-edge
  // panel styles + a zero top margin.
  const fullBleed = maximized && expanded && sheetOpen && !pilled;
  // Only the panel MAX-HEIGHT stays full-screen-sized for the whole restore drag,
  // so the height can track the finger without the max-height clamping it shorter
  // on the first frame (a vertical pop). Every other property (side inset, bottom
  // padding, corner radius, bg) returns to its INSET value the moment the drag
  // drops `maximized`, so the panel becomes the real chat shape live and there is
  // nothing left to snap into place on release.
  const fullBleedFrame = fullBleed || restoreDragging;

  // #14173: on a wide-but-short landscape viewport the bottom-anchored composer
  // spans nearly the full width (max-w-3xl, centered) as a ~full-width band, and
  // in the short height that band sits on top of the view's own controls (the
  // audit's `overlayClearanceIssues`, e.g. builtin-browser). Shrink the RESTING
  // overlay to a compact bottom-corner affordance so it clears them; the moment
  // it is opened, focused, composing, or working, the normal centered composer
  // returns (so the reading/typing surface is never cramped). Portrait phones
  // and desktop/tablet never satisfy `shortLandscape`, so they are untouched.
  const shortLandscape = isShortLandscapeViewport(
    viewport.innerWidth,
    viewport.innerHeight,
  );
  const compactLanding =
    shortLandscape &&
    !sheetOpen &&
    !fullBleed &&
    !composerFocused &&
    !hasDraft &&
    !hasImages &&
    !recording &&
    !responding &&
    !pinnedOpen;

  // In short landscape the resting composer moves to the bottom inline-end
  // corner. Publish that footprint separately from bottom clearance so hosted
  // app/plugin views can keep right-edge content out from under the corner bar.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const reset = () => {
      root.style.setProperty("--eliza-continuous-chat-side-clearance", "0px");
    };
    if (!compactLanding) {
      reset();
      return;
    }
    const panel = getPanelElement();
    if (!panel) {
      reset();
      return;
    }
    const publish = () => {
      const width = panel.getBoundingClientRect().width;
      root.style.setProperty(
        "--eliza-continuous-chat-side-clearance",
        width > 0 ? `${Math.ceil(width + 24)}px` : "0px",
      );
    };
    publish();
    if (typeof ResizeObserver === "undefined") {
      return () => reset();
    }
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    return () => {
      ro.disconnect();
      reset();
    };
  }, [compactLanding, getPanelElement]);

  // Top clearance + max height come from the pure, unit-tested layout solver.
  // It reserves the real measured notch inset (`safeAreaTop`) above the panel,
  // and — critically — subtracts any keyboard lift the visual viewport did NOT
  // report (the iOS Capacitor `resize:"body"` case where `keyboardInset` reads 0
  // but the native Keyboard plugin still lifted the overlay): without that, the
  // panel is sized against the full height while ALSO being pushed up by the
  // keyboard, so its top edge shoots above the notch and off-screen. Full-bleed
  // drops the top margin + the overlay's bottom padding
  // so the maximized panel fills the screen edge-to-edge.
  // Solve BOTH shapes: the inset overlay height (detent target) and the
  // edge-to-edge full-bleed height. Their difference is the REAL pixel gap the
  // maximize morph travels — the over-pull past FULL grows the panel 1:1 with
  // the finger across exactly this gap (no arbitrary morph constant), so the
  // panel top tracks the pointer all the way to the screen edge.
  const layoutInput = {
    viewportH,
    bottomPad,
    keyboardInset,
    effectiveKeyboardInset,
    safeAreaTopPx: safeAreaTop,
  };
  const { panelMaxH: insetPanelMaxH } = resolveChatPanelLayout({
    ...layoutInput,
    fullBleed: false,
  });
  const { panelMaxH: fullPanelMaxH } = resolveChatPanelLayout({
    ...layoutInput,
    fullBleed: true,
  });
  // Use the frame (not just `maximized`) so the max-height stays full for the
  // whole restore drag — otherwise frame 1 clamps the panel to the inset height
  // and it pops shorter before the finger has moved.
  const panelMaxH = fullBleedFrame ? fullPanelMaxH : insetPanelMaxH;
  const maxOverPull = Math.max(1, fullPanelMaxH - insetPanelMaxH);

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
  //                       pull rested here); the status header stays hidden
  //   OPEN_HALF_OR_OVER — at the half detent or taller (status header shows)
  //   MAXIMIZED         — full-bleed edge-to-edge
  // Transitions: pill tap / flick-up → INPUT; focus·type·flick·send → an OPEN_*
  // state; pull-down → INPUT → CLOSED; maximize toggle ↔ MAXIMIZED.
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
  // The status header is gated on the LIVE rendered height, NOT the settled enum
  // — otherwise dragging the panel below half keeps the top strip mounted on a
  // too-short panel. It shows only when the panel actually renders at/over half
  // (or is full-bleed), tracking the finger frame-by-frame; the prev===next guard
  // keeps re-renders to the two threshold crossings.
  const evalHeaderVisible = React.useCallback(
    (h: number) => threadPresented && !pilled && (fullBleed || h >= halfH - 1),
    [threadPresented, pilled, fullBleed, halfH],
  );
  const [headerVisible, setHeaderVisible] = React.useState(false);
  useMotionValueEvent(threadHeight, "change", (h) => {
    markLayoutShiftIntent();
    const next = evalHeaderVisible(h);
    setHeaderVisible((prev) => (prev === next ? prev : next));
    // Unmount the collapse-preview transcript once the height has actually
    // sprung to rest at 0 — closeSheet keeps it mounted so the panel follows the
    // spring down instead of snapping. Gated so it never fires mid-drag (a
    // pill-drag sits at h=0 while dragging) or while the sheet is open.
    if (
      h <= 1 &&
      !draggingRef.current &&
      !sheetOpen &&
      dragPreviewVisibleRef.current
    ) {
      setDragPreviewMounted(false);
    }
  });
  // Re-evaluate on settled-state changes that don't tick the height (programmatic
  // pill/maximize/open with the spring already at rest).
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadHeight is a stable motion ref
  React.useEffect(() => {
    setHeaderVisible(evalHeaderVisible(threadHeight.get()));
  }, [evalHeaderVisible]);
  // The thread's flex-basis is the live height as a px string. At rest
  // (threadHeight 0 = INPUT/CLOSED) the structural backdrop marker drops out of
  // compositing via `visibility` — compositor-only, no reflow, no re-render —
  // and flips back the instant the thread opens.
  const scrimVisibility = useTransform(threadHeight, (h) =>
    h > 0 ? "visible" : "hidden",
  );
  const threadFlexBasis = useTransform(threadHeight, (h) => `${h}px`);
  // Full-screen SHAPE spring (0 = inset chat shape, 1 = edge-to-edge). It springs
  // between the two whenever `maximized` flips, so a maximize ANIMATES out to full
  // screen instead of jumping, and a restore drag ANIMATES back to the exact inset
  // shape instead of popping/snapping. Only the SHAPE eases (side inset, corner
  // radius, composer bottom-inset); the height is still the finger/detent spring,
  // so the two read as one motion. Reduced-motion sets it instantly.
  // Start at the committed shape so pinned first paint does not flash the inset
  // panel before the full-screen morph effect catches up.
  const fullBleedT = useMotionValue(fullBleed ? 1 : 0);
  // Live over-pull fraction the FINGER drives every drag frame (0 = at/below the
  // inset ceiling, 1 = full over-pull). It supplements the height cap through the
  // inset-ceiling DEAD ZONE: the FULL-detent thread flex-basis deliberately
  // OVERSHOOTS the visible thread by the composer/header chrome (~48px), so the
  // panel content reaches `insetPanelMaxH` — and the panel visually PINS at the
  // inset ceiling — while `cont` is still ~chrome px BELOW `insetPanelMaxH`.
  // `threadHeight` alone can't lift the cap there (it's < insetPanelMaxH), so the
  // panel froze under a still-rising finger. This value carries the measured pin
  // over-pull (`onDragOffset`'s `overpullT`), lifting the cap 1:1 through that gap
  // — and because the pin height ≈ `maxOverPull` (both are the dropped top
  // margin), `insetPanelMaxH + maxOverPull * overpullT == cont + chrome`, i.e. the
  // panel edge tracks the finger exactly. It is SET-only (never `animate()`d) so
  // it can never linger a spring that reflows the panel mid-pointer and cancels a
  // live drag; off-drag it stays 0 and `threadHeight`/`fullBleedT` own the cap.
  // Rests at 0 even when maximized (the maximized detent settles `threadHeight`
  // to `fullPanelMaxH`, which owns the cap) so a PROGRAMMATIC maximize animates
  // the height with `fullBleedT`/`threadHeight` instead of a `pin=1` forcing the
  // cap to full instantly.
  const overpullCapT = useMotionValue(0);
  // Mirror the settled full-bleed flag so release handlers can settle the morph
  // toward the committed shape without waiting for a re-render.
  const fullBleedRef = React.useRef(fullBleed);
  fullBleedRef.current = fullBleed;
  const fullBleedAnimRef = React.useRef<MotionControls | null>(null);
  const stopFullBleedAnimation = React.useCallback(() => {
    fullBleedAnimRef.current?.stop();
    fullBleedAnimRef.current = null;
  }, []);
  // Settle the shape morph to an explicit target. Used on release because a
  // finger-driven over-pull that is released WITHOUT changing `fullBleed` (an
  // over-pull-then-return, or a restore that lands back at full) never re-fires
  // the state effect below — the morph would otherwise strand mid-way.
  const animateFullBleedTo = React.useCallback(
    (target: number) => {
      stopFullBleedAnimation();
      if (reduce) {
        fullBleedT.set(target);
        return;
      }
      fullBleedAnimRef.current = animate(fullBleedT, target, SHEET_SPRING);
    },
    [fullBleedT, reduce, stopFullBleedAnimation],
  );
  const settleFullBleed = React.useCallback(
    () => animateFullBleedTo(fullBleedRef.current ? 1 : 0),
    [animateFullBleedTo],
  );
  // State-driven flips (programmatic maximize/restore, keyboard, onboarding)
  // spring the shape. Skipped while a finger owns the morph — the live drag
  // sets `fullBleedT` directly and the release path settles it explicitly.
  React.useEffect(() => {
    if (reduce) {
      fullBleedT.set(fullBleed ? 1 : 0);
      return;
    }
    if (draggingRef.current) return;
    stopFullBleedAnimation();
    const controls = animate(fullBleedT, fullBleed ? 1 : 0, SHEET_SPRING);
    fullBleedAnimRef.current = controls;
    return () => controls.stop();
  }, [fullBleed, reduce, fullBleedT, stopFullBleedAnimation]);
  // Side inset (12→0px), corner radius (inset radius→0), and the composer bottom
  // inset (full→0), each scaled by the spring so they collapse/return together.
  const overlayPadX = useTransform(fullBleedT, [0, 1], [12, 0]);
  // The panel WRAPPER's max-width rides the same morph: 48rem (max-w-3xl; the
  // compact landscape affordance is 13rem) widening to the full viewport as the
  // shape goes edge-to-edge. Discrete classes popped the width only when the
  // maximize COMMITTED — on desktop the background jumped 768px → viewport on
  // release instead of growing under the finger. The content columns inside
  // stay pinned at the reading width, so only the glass grows.
  const wrapperBaseMaxW = compactLanding ? 208 : 768;
  const wrapperMaxW = useTransform(
    fullBleedT,
    (t) =>
      `${wrapperBaseMaxW + Math.max(0, viewport.innerWidth - wrapperBaseMaxW) * t}px`,
  );
  // The panel's height CAP is the HIGHER of two ceilings: the over-pull ceiling
  // (inset at 0 growing to full-bleed) and the LIVE finger height (`threadHeight`).
  // Taking the max lets an upward over-pull grow past the inset ceiling 1:1 UNDER
  // THE FINGER: while the SHAPE (`fullBleedT`) still snaps discretely at the
  // commit threshold (`Maximize is a DISCRETE STATE`), the cap follows the finger
  // every frame with no freeze. Two finger-tracked inputs feed the over-pull
  // ceiling: `threadHeight` (== cont, so once `cont > insetPanelMaxH` the cap is
  // cont) and `overpullCapT` (the live pin fraction, which lifts the cap through
  // the inset-ceiling flex-overshoot dead zone BELOW `insetPanelMaxH` — see its
  // declaration). Both are SET each frame (no separate spring to desync, reflow,
  // or cancel a live pointer); off-drag they rest at the committed 0/1 and
  // `threadHeight`/the settle spring own the cap. Resting inset detents stay
  // clamped: at the FULL detent `overpullCapT` is 0 and `threadHeight` settles to
  // `insetPanelMaxH`, so the max is exactly `insetPanelMaxH` and the deliberately
  // overshooting flex-basis is still capped. Clamped to `fullPanelMaxH` so a
  // spring overshoot can never balloon the panel past the screen.
  const panelCapH = useTransform(
    [threadHeight, fullBleedT, overpullCapT] as MotionValue<number>[],
    ([h, t, pin]: number[]) =>
      Math.min(
        fullPanelMaxH,
        Math.max(insetPanelMaxH + maxOverPull * Math.max(t, pin), h),
      ),
  );
  // Corner radius is CONSTANT at every sheet height (no swim while the panel
  // grows); only the maximize shape morph squares it toward edge-to-edge.
  const morphRadius = useTransform(
    fullBleedT,
    (t: number) => PANEL_RADIUS_PX * (1 - t),
  );
  const bottomInsetFactor = useTransform(fullBleedT, [0, 1], [1, 0]);
  const overlayPadBottom = useMotionTemplate`calc(${bottomInsetFactor} * (var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem))`;
  // Full-bleed extends the glass UP under the status bar; riding the shape
  // spring (instead of a discrete swap at commit) keeps the top edge from
  // popping a safe-area-height on notch devices. 0px at rest (t=0).
  const glassTopExtension = useMotionTemplate`calc(${fullBleedT} * -1 * env(safe-area-inset-top, 0px))`;
  // At full-bleed the composer floats as its OWN glass capsule — the exact
  // chrome of the resting input bar (frosted fill, hairline border, capsule
  // radius) — instead of dissolving into the edge-to-edge panel. All of it
  // rides the shape morph so the chrome fades in/out with the maximize
  // gesture, never popping at commit:
  //  - the home-gesture clearance moves OUTSIDE the capsule (a bottom margin,
  //    0 at rest) so the capsule floats above the gesture bar;
  //  - a small side inset (width shrinks by 24px at t=1) keeps the capsule off
  //    the screen edges on narrow viewports;
  //  - border + frosted fill alphas scale with the morph.
  // A comfortable float above the bottom edge: the home-gesture inset PLUS a
  // base 0.75rem, so the capsule never sits flush against the screen bottom in
  // full-screen (the "margin goes away in fullscreen" complaint) even on a
  // device with no safe-area inset.
  const composerCapsuleMarginBottom = useMotionTemplate`calc(${fullBleedT} * (max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.75rem))`;
  const composerCapsuleWidth = useMotionTemplate`calc(100% - ${fullBleedT} * 24px)`;
  const composerCapsuleBorder = useMotionTemplate`color-mix(in srgb, var(--border-strong) calc(${fullBleedT} * 100%), transparent)`;
  const composerCapsuleBg = useMotionTemplate`color-mix(in srgb, var(--card) calc(${fullBleedT} * 86%), transparent)`;
  // --- Liquid-glass pill → input morph (driven by openProgress) ---------------
  // The panel is ONE persistent element; the pill capsule and the full
  // input crossfade by opacity (compositor-cheap) while the whole panel scales
  // up from a capsule. transform + opacity only. The scale runs the full
  // pillMorphScale lerp (down to PILL_MORPH_MIN_SCALE) so collapsing to the
  // pill reads as the chat HARD-shrinking into the capsule, not a 10% nudge.
  const panelScale = useTransform(openProgress, pillMorphScale);
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
  // pill was still fading out → two bars = the "two pills" bug.) It ALSO fades
  // back OUT with the over-pull shape morph (`fullBleedT`), so dragging up
  // through the top ~10% dissolves the handle instead of popping it away when
  // the maximize commits — see grabberBarOpacity.
  const grabberOpacity = useTransform(
    [openProgress, fullBleedT] as MotionValue<number>[],
    ([p, t]: number[]) => grabberBarOpacity(p, t),
  );
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
  // The header carries NO top padding of its own — the transcript runs to the
  // panel's top edge at every inset height. Only full-bleed pads the top, to
  // clear the status bar (safe-area top + 8px), EASED with the shape morph
  // instead of swapping discretely at commit — the discrete swap popped the
  // header down a status-bar height on notch devices the frame `fullBleed`
  // flipped. The safe-area term stays a CSS `var(--safe-area-top)` INSIDE the
  // calc (not a JS-measured number): the host seeds that var on native — and
  // the e2e harness drives it — so the padding must honor it even where the
  // env() probe reads 0.
  const headerPadTopMorph = useMotionTemplate`calc(${fullBleedT} * (var(--safe-area-top, 0px) + 0.5rem))`;
  const headerMaxHMorph = useTransform(
    [headerMaxH, fullBleedT] as MotionValue<number>[],
    // 400px stands in for "uncapped": the safe-area inset + badge row is well
    // under it, and a finite target lets the cap lerp instead of jumping to
    // `none`.
    ([mh, t]: number[]) => mh + (400 - mh) * clamp01(t),
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
    // Return the shape morph to its committed end (inset unless still maximized):
    // a released over-pull that did not commit maximize must un-morph the edges.
    settleFullBleed();
    // Hand the height cap back to `threadHeight`/`fullBleedT` (the settle springs):
    // the live pin fraction is finger-only and must rest at 0 off-drag.
    overpullCapT.set(0);
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
    settleFullBleed,
    overpullCapT,
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
    setFreeH(null);
    setMaximized(false);
    setMode("input");
    if (reduce) {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      threadHeight.set(0);
      openProgress.set(1);
      setDragPreviewMounted(false);
    } else {
      // Keep the transcript MOUNTED through the collapse spring. `setMode("input")`
      // above flips `sheetOpen` false, which alone would unmount the thread this
      // very frame — the panel would then snap to the composer height instantly
      // while the `threadHeight` spring animated a now-unmounted element's
      // flex-basis (the "jerky, too-fast collapse" — 415px in one frame). The
      // drag-preview mount keeps the thread laid out so the panel height actually
      // follows the spring down; the settle listener below unmounts it once the
      // height reaches 0 (robust to the [baseH] effect re-issuing the spring).
      setDragPreviewMounted(true);
      animateThreadHeight(0);
      // Settle the pill morph to the input's resting end explicitly: a drag
      // that dipped past the bottom left openProgress below 1, and the
      // `pilled`-driven effect won't re-fire when `pilled` stays false — the
      // glass would otherwise strand semi-transparent.
      animateOpenProgress(1);
    }
  }, [
    reduce,
    threadHeight,
    openProgress,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
    animateOpenProgress,
    setDragPreviewMounted,
  ]);

  // Collapse the whole chat to the bottom pill capsule — the shared landing for
  // every "put the chat away" release (flick down from the input, an input drag
  // whose pill morph crossed halfway, an open-sheet drag carried past the
  // bottom). Mode "pill" drives everything else: the pilled effect springs
  // openProgress → 0 and the detent effect springs the thread height → 0.
  const collapseToPill = React.useCallback(() => {
    draggingRef.current = false;
    setDragPreviewMounted(false);
    setFreeH(null);
    setMaximized(false);
    setMode("pill");
    inputRef.current?.blur();
    detentHaptic();
  }, [setDragPreviewMounted]);

  // Landing for a drag released AT THE BOTTOM (thread height within the detent
  // magnet of 0): PILL when the gesture carried past the bottom into the
  // input→pill morph, OR when it started at/above the half detent (one big yank
  // from full/maximized = "put the chat away" — the screen edge leaves no room
  // to overshoot below a full-height sheet, so start height carries the
  // intent). Otherwise the INPUT bar (short closes, small free rests).
  const collapseFromRelease = React.useCallback(() => {
    // The overshoot test only applies to gestures that came DOWN through the
    // bottom (openProgress driven 1 → below the commit line). A drag that
    // started PILLED moves openProgress the other way (0 → up) — a half-open
    // pill morph must land on the INPUT, not read as "carried past bottom".
    if (
      (!pilled && openProgress.get() <= PILL_COMMIT_PROGRESS) ||
      dragStartHRef.current > halfH + SHEET_DETENT_MAGNET
    ) {
      collapseToPill();
    } else {
      closeSheet();
    }
  }, [pilled, openProgress, halfH, collapseToPill, closeSheet]);

  // Leaving the chat for Settings/Home: animate OUT of maximize and collapse the
  // sheet (closeSheet un-maximizes + springs the thread height down) BEFORE
  // swapping the page underneath, so it reads as the chat closing into the new
  // view rather than a jump-cut from full-screen. The page swap waits a beat for
  // the collapse spring to start (a touch longer when leaving MAXIMIZED, since
  // there's more to unwind); reduced motion navigates immediately.
  // Maximize via a vertical PULL, not a button (#13531). A pull-up that crosses
  // the 80%-of-viewport threshold rises to the FULL detent and drops the inset,
  // so the panel goes edge-to-edge in one continuous gesture. The button-only
  // `toggleMaximize` is gone; this is the single entry into full-bleed and is
  // called from the pull-gesture release path (maybeMaximizeOnRelease) once the
  // peak raw pull clears 80% of the viewport height.
  const maximizeFromPull = React.useCallback(() => {
    // Snap the morph fully open BEFORE flipping to full-bleed so no in-flight
    // pill-open spring can leak a sub-1 scale into the maximized frame (top gap).
    draggingRef.current = false;
    stopThreadAnimation();
    stopOpenProgressAnimation();
    openProgress.set(1);
    setFreeH(null);
    setMode("full");
    setMaximized(true);
    // Finish the finger-driven morph to edge-to-edge explicitly: the drag left
    // fullBleedT partway (≥0.5) and the state effect is gated during the release
    // frame, so drive it home rather than waiting for the `fullBleed` flip.
    animateFullBleedTo(1);
    // Hand the cap to the maximized detent spring (`threadHeight` → fullPanelMaxH);
    // the finger-only pin fraction rests at 0.
    overpullCapT.set(0);
    detentHaptic();
  }, [
    openProgress,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateFullBleedTo,
    overpullCapT,
  ]);

  // Restore OUT of full-bleed back to the inset FULL-detent overlay (#13531).
  // Driven by a downward pull that starts in the top 20% of the maximized panel
  // (the top-20% grab zone below); it drops full-bleed but keeps the thread open
  // at the FULL detent, so it reads as shrinking the edge-to-edge view back into
  // the overlay chat rather than collapsing the whole sheet (Escape/back still
  // collapse to the input).
  const restoreFromMaximized = React.useCallback(() => {
    draggingRef.current = false;
    stopThreadAnimation();
    setMaximized(false);
    setMode("full");
    detentHaptic();
  }, [stopThreadAnimation]);

  // The single detent→detent animator: whenever the settled detent (or viewport)
  // changes and we're not mid finger-drag, spring the history height to it. The
  // gesture / open paths just flip sheetOpen/expanded and this reacts — no
  // per-frame React state, so the live drag stays buttery.
  React.useEffect(() => {
    if (draggingRef.current) return;
    // Off-drag the cap belongs to `threadHeight`/`fullBleedT`; force the
    // finger-only pin fraction to 0 so no gesture that ended off the settle path
    // (flick, keyboard resize) can leave the resting cap inflated above the detent.
    overpullCapT.set(0);
    if (reduce) {
      stopThreadAnimation();
      threadHeight.set(baseH);
      return;
    }
    animateThreadHeight(baseH);
    return stopThreadAnimation;
  }, [
    baseH,
    reduce,
    threadHeight,
    overpullCapT,
    animateThreadHeight,
    stopThreadAnimation,
  ]);

  // Snap to one of the three iOS-style detents and settle the live drag. A
  // detent change fires a light haptic so the snap feels physical on device.
  // "collapsed" hides the history entirely (just the input); "half" is the
  // comfortable reading height; "full" the near-fullscreen reading mode.
  const goToDetent = React.useCallback(
    (to: "collapsed" | "half" | "full") => {
      // Flip the settled detent; the [baseH] effect springs the height to it.
      // A detent always clears any free-drag rest height. Full-bleed is a
      // separate, explicit maximize state: plain FULL is the inset full detent.
      draggingRef.current = false;
      setFreeH(null);
      setMaximized(false);
      // "collapsed" is the input bar (sheet closed); half/full open the thread.
      setMode(to === "collapsed" ? "input" : to);
      const target = to === "collapsed" ? 0 : to === "half" ? halfH : openH;
      if (reduce) {
        stopThreadAnimation();
        stopOpenProgressAnimation();
        threadHeight.set(target);
        openProgress.set(1);
      } else {
        animateThreadHeight(target);
        // Every detent is on the input side of the pill morph. A drag that
        // dipped past the bottom (openProgress < 1) then released upward onto a
        // detent must settle the morph home — the pilled effect won't re-fire
        // while `pilled` stays false, so an un-settled morph strands the glass
        // semi-transparent.
        animateOpenProgress(1);
      }
      // Settle the shape morph: every detent is inset; full-bleed only comes
      // from the explicit maximize path.
      animateFullBleedTo(0);
      // A flick-to-detent ends the gesture: drop the finger-only pin fraction so
      // it can't leave the resting cap inflated above the detent's own height.
      overpullCapT.set(0);
      // Stepping all the way down closes the keyboard (the chat is dismissed).
      if (to === "collapsed") inputRef.current?.blur();
      detentHaptic();
    },
    [
      halfH,
      openH,
      reduce,
      threadHeight,
      openProgress,
      stopThreadAnimation,
      stopOpenProgressAnimation,
      animateThreadHeight,
      animateOpenProgress,
      animateFullBleedTo,
      overpullCapT,
    ],
  );

  // Trackpad two-finger swipe steps the sheet through its detents
  // (pill ↔ input ↔ half ↔ full ↔ maximized) — the macOS-feel complement to
  // the pointer drag. Wheel events accumulate with a short decay and step once
  // per threshold with a cooldown, so a single physical swipe moves ONE detent
  // (no accidental multi-jumps). Scoped to the sheet chrome: events that
  // originate inside the transcript scroller belong to transcript scrolling
  // and are ignored here, so reading history never resizes the sheet.
  const wheelStepAccRef = React.useRef(0);
  const wheelStepCooldownRef = React.useRef(0);
  const wheelStepDecayRef = React.useRef<number | null>(null);
  const onSheetWheel = React.useCallback(
    (e: React.WheelEvent) => {
      if (firstRunOpen || draggingRef.current) return;
      if (
        e.target instanceof Element &&
        e.target.closest("#continuous-thread")
      ) {
        return;
      }
      const now = performance.now();
      if (now < wheelStepCooldownRef.current) return;
      if (wheelStepDecayRef.current !== null) {
        window.clearTimeout(wheelStepDecayRef.current);
      }
      wheelStepDecayRef.current = window.setTimeout(() => {
        wheelStepAccRef.current = 0;
        wheelStepDecayRef.current = null;
      }, 250);
      wheelStepAccRef.current += e.deltaY;
      const STEP_PX = 60;
      const acc = wheelStepAccRef.current;
      if (Math.abs(acc) < STEP_PX) return;
      wheelStepAccRef.current = 0;
      wheelStepCooldownRef.current = now + 450;
      // Natural-scroll semantics: swiping UP on the trackpad (content up,
      // deltaY > 0) grows the sheet; swiping down shrinks it.
      const grow = acc > 0;
      if (grow) {
        if (pilled) goToDetent("collapsed");
        else if (!sheetOpen) goToDetent("half");
        else if (!expanded) goToDetent("full");
        else if (!maximized) maximizeFromPull();
      } else {
        if (maximized) restoreFromMaximized();
        else if (expanded) goToDetent("half");
        else if (sheetOpen) goToDetent("collapsed");
        else if (!pilled) collapseToPill();
      }
    },
    [
      firstRunOpen,
      pilled,
      sheetOpen,
      expanded,
      maximized,
      goToDetent,
      maximizeFromPull,
      restoreFromMaximized,
      collapseToPill,
    ],
  );

  // First-run onboarding pin + release. While onboarding is active the sheet
  // stays pinned FULL — a true full-screen chat (the seeded greeting/choices
  // own the screen and the chat is undismissable; every collapse path below is
  // also gated on `firstRunOpen`). On the FALLING edge — onboarding just
  // completed — settle to the HALF detent: the sheet springs full → half in
  // step with the opaque backdrop fade, so the home screen is revealed behind
  // the top half while the conversation stays in hand. Edge-detected via a ref
  // so an ordinary session (onboarding never active) never triggers it.
  const wasFirstRunOpenRef = React.useRef(firstRunOpen);
  React.useEffect(() => {
    const was = wasFirstRunOpenRef.current;
    wasFirstRunOpenRef.current = firstRunOpen;
    if (firstRunOpen) {
      setFreeH(null);
      setMode("full");
      setMaximized(true);
      return;
    }
    if (was) goToDetent("half");
  }, [firstRunOpen, goToDetent]);

  // First-run opaque backdrop (#12178). While onboarding pins the sheet FULL,
  // the backdrop is an OPAQUE `bg-bg` layer that hides the launcher/home behind
  // the chat — the normal translucent gradient scrim would let them show
  // through. On the falling edge (onboarding just completed) it fades opaque →
  // transparent over ~400ms in step with the one-shot auto-collapse above,
  // revealing home/launcher underneath (kept mounted, warm); reduced-motion
  // cuts straight to hidden. `off` unmounts the layer for ordinary sessions.
  const [firstRunBackdrop, setFirstRunBackdrop] = React.useState<
    "opaque" | "revealing" | "off"
  >(firstRunOpen ? "opaque" : "off");
  React.useEffect(() => {
    if (firstRunOpen) {
      setFirstRunBackdrop("opaque");
      return;
    }
    setFirstRunBackdrop((prev) =>
      prev === "opaque" ? (reduce ? "off" : "revealing") : prev,
    );
  }, [firstRunOpen, reduce]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadRef is the stable ref object returned by useThreadAutoScroll (a useRef); reading .current is not a dependency.
  const collapse = React.useCallback(() => {
    // Undismissable during onboarding: Escape (document, thread, composer),
    // outside taps, the grabber close, and the sheet-open grabber tap all
    // funnel here — every one is a no-op until first-run completes.
    if (pinnedOpen) return;
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
  }, [closeSheet, pinnedOpen]);

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

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPrefill = (event: Event) => {
      if (firstRunOpen) return;
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
  }, [clearPrefillFocusSchedule, firstRunOpen, setDraft]);

  // "Open chat" intent (the launcher's Messages tile). Land the user IN an open
  // conversation instead of the wordless home with a collapsed pill: un-pill to
  // the composer and reveal the thread (a no-op when there's nothing to reveal
  // yet), then focus the input. Gated by the onboarding lock like the tour.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOpen = () => {
      if (pinnedOpen) return;
      setMode((m) => (m === "pill" ? "input" : m));
      expand();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(CHAT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, onOpen);
  }, [pinnedOpen, expand]);

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
      if (firstRunOpen) return;
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
    firstRunOpen,
    handsFree,
    recording,
    setDraft,
    toggleHandsFree,
  ]);

  // Push-to-talk dictation drops its final transcript into the composer draft
  // (no send): register the sink with the controller while this overlay is
  // mounted, appending to whatever the user has already typed.
  React.useEffect(() => {
    setDictationSink((text) => {
      // Append through the live draft ref — the shared context setter takes a
      // plain string (no functional-update form).
      const current = draftRef.current;
      setDraft(current ? `${current} ${text}` : text);
      inputRef.current?.focus();
      expand();
    });
    return () => setDictationSink(null);
  }, [setDictationSink, setDraft, expand]);

  // A completed transcription SESSION works like ChatGPT dictation: the full
  // transcript is INSERTED AS TEXT at the end of the composer draft — never
  // auto-sent, never a document chip the user has to open. The captured audio
  // becomes a pending AUDIO ATTACHMENT (the sharable artifact: sending it
  // routes the WAV through the content-addressed media store, so the thread
  // carries a playable, downloadable /api/media/<sha256>.wav recording). The
  // session is also archived (Transcript record + audio) for the Transcripts
  // view, best-effort and silent.
  React.useEffect(() => {
    setTranscriptSessionSink((segments, startedAtMs, audioWav) => {
      if (segments.length === 0) return;
      const text = transcriptPlainText(segments);
      const stamp = new Date(startedAtMs)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      if (text) {
        // Append at the END of whatever is already typed (through the live
        // ref — the shared context setter takes a plain string), mirroring the
        // push-to-talk dictation sink above.
        const current = draftRef.current;
        setDraft(current ? `${current} ${text}` : text);
      }
      const hasAudio = Boolean(audioWav && audioWav.byteLength > 0);
      if (audioWav && hasAudio) {
        // Enforce the SAME per-file media size cap the attach/paste/drop paths
        // go through (intakeAttachmentFiles → perFileByteCap): a several-minute
        // dictation produces a large WAV, and hand-attaching it unchecked would
        // blow past the server media limit and fail the whole send. Over the
        // cap, drop just the audio artifact — the transcript TEXT inserted above
        // is the primary output and always lands — and say so inline.
        if (audioWav.byteLength > MAX_CHAT_MEDIA_RAW_BYTES) {
          setImageError(
            `Recording too large to attach (max ${bytesToMb(
              MAX_CHAT_MEDIA_RAW_BYTES,
            )}MB) — transcript kept.`,
          );
        } else {
          const recording: ImageAttachment = {
            data: wavBytesToBase64(audioWav),
            mimeType: "audio/wav",
            name: `Recording ${stamp}.wav`,
          };
          setPendingImages((prev) =>
            [...prev, recording].slice(0, MAX_CHAT_IMAGES),
          );
        }
      }
      if (text || hasAudio) {
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
        .catch(() => {
          /* archival is best-effort; a failed save just skips the record */
        });
    });
    return () => setTranscriptSessionSink(null);
  }, [setTranscriptSessionSink, setDraft, setPendingImages, expand]);

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
        // One infinite thread (#13531): the overlay no longer resets/switches
        // conversations (clear-chat / new-conversation) or toggles full-screen
        // via a command — maximize is a vertical pull now. These slash paths are
        // inert in the overlay; the shared subsystem plumbing (first-run/wipe/
        // switch, CommandPalette, TUI) is untouched and handled elsewhere.
        clearChat: () => {},
        newConversation: () => {},
        toggleFullscreen: () => {},
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
    [slash, submitText, setDraft, toggleTranscriptionMode, collapse],
  );

  const submit = React.useCallback(() => {
    // Onboarding is sign-in-first; transcript choice widgets are the only input.
    if (firstRunOpen) {
      return;
    }
    const shortcut =
      pendingImages.length === 0
        ? resolveClientShortcutExecution(
            slash.commands,
            draft,
            slash.resolveSection,
            {
              allowNatural: slash.naturalShortcutsEnabled,
              resolveChoices: slash.resolveChoices,
              // #12087 Item 20: re-apply the sender's real authority to the
              // natural-language path so it matches the visible menu.
              isAuthorized: slash.isAuthorized,
              isElevated: slash.isElevated,
            },
          )
        : null;
    if (shortcut) {
      runExecution(shortcut);
      return;
    }
    submitText(draft, pendingImages);
  }, [draft, pendingImages, firstRunOpen, runExecution, slash, submitText]);

  const pickSlashItem = React.useCallback(
    (index: number) => {
      const exec = slashMenu.resolve(index);
      if (exec) runExecution(exec);
    },
    [slashMenu, runExecution],
  );

  // The shared composer-core keydown: IME-commit guard (#9148) → slash-menu
  // interception → Enter sends → Escape collapses the open sheet. The slash
  // binding adapts the overlay's menu/executor onto the core's key contract.
  const handleComposerKeyDown = useComposerKeydown<HTMLTextAreaElement>({
    onSend: submit,
    slash: {
      open: slashOpen,
      move: (delta) => slashMenu.move(delta),
      complete: () => {
        const completed = slashMenu.complete();
        if (completed == null) return false;
        setDraft(completed);
        return true;
      },
      submit: () => {
        const exec = slashMenu.resolve();
        if (!exec) return false;
        runExecution(exec);
        return true;
      },
      dismiss: () => setSlashDismissed(true),
    },
    onEscape: () => {
      if (!sheetOpen) return false;
      collapse();
      return true;
    },
  });
  // The shared composer-core paste routing: an image/file paste attaches, an
  // oversized text paste becomes a collapsed text-attachment chip, small text
  // falls through to the textarea.
  const handleComposerPaste = useComposerPaste<HTMLTextAreaElement>({
    addFiles: addImageFiles,
    attachText: (attachment) =>
      setPendingImages((prev) =>
        [...prev, attachment].slice(0, MAX_CHAT_IMAGES),
      ),
  });

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
    // While pinned for onboarding the chat is undismissable, so the outside-tap
    // swallower must not install: it capture-eats pointerup on everything
    // outside the sheet.
    if (typeof document === "undefined" || !sheetOpen || pinnedOpen) {
      outsideSheetPointerRef.current = null;
      suppressNextOutsideClickRef.current = false;
      return undefined;
    }

    // Surfaces painted ABOVE the chat glass (notification sheet/panel at
    // Z_NOTIFICATION_OVERLAY, any open Radix dialog) must win the tap — the
    // swallower otherwise eats their first tap AND collapses the chat under
    // them. "Tap outside collapses" is only for the background view.
    //
    // The inline home notification center (#15080) is a live INTERACTIVE
    // surface even though it sits BELOW the chat glass (inline on the home
    // column, not the old Z_NOTIFICATION_OVERLAY shade). Its rows own tap (open
    // / deep-link), swipe-dismiss, and a long-press menu; without this
    // exemption the capture-phase pointerup below preventDefault +
    // stopImmediatePropagation'd the row's tap and set suppressNextOutsideClick,
    // so the click-swallower ate the row's onClick, tapping a notification did
    // NOTHING ("interacting is cooked", device r8). Exempt the ROWS
    // (`[data-notif-row]` — the option strip lives inside the row) so their own
    // handlers win. Scope the exemption to the rows, NOT the whole center
    // section: the section is `flex-1` and chromeless, so it fills most of the
    // home band with invisible field — exempting the section (as it once did)
    // killed outside-tap collapse everywhere around the rows. A real tap on the
    // bare field still collapses the chat; a pull-drag is a drag (not a tap) so
    // the swallower ignores it either way.
    const isAboveShellOverlay = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest(
        '[data-above-shell-overlay], [role="dialog"], [data-notif-row], [data-notif-control]',
      );

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
  }, [sheetOpen, pinnedOpen, collapse, isOverlayControlTarget]);

  // Escape collapses the chat from ANY open state, even a free-drag open with no
  // focused element (the element-level handlers on the textarea/thread only fire
  // when one of them holds focus). Registered only while open.
  React.useEffect(() => {
    if (typeof document === "undefined" || !sheetOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open Radix dialog (data-state="open" — e.g. the command palette)
        // sits above the chat: let ITS Escape handling win — collapsing here
        // too closed both at once (e.g. an invisible palette + the chat).
        // Scoped to exactly these; broad role="dialog" would match
        // always-mounted shell surfaces (AssistantOverlay, tutorial card) and
        // permanently disable Escape-collapse.
        //
        // Also defer while the transcript viewer is open or a per-message edit
        // is in progress: neither carries `[data-state="open"]`, so Escape must
        // close THAT first (the viewer's own handler / the editor's Cancel) and
        // NOT also collapse the whole sheet + discard the in-progress edit.
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [data-testid="transcript-viewer"], [data-testid="thread-line-edit-input"]',
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
      if (!sheetOpen || pinnedOpen) return;
      detail.handled = true;
      collapse();
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
    return () =>
      window.removeEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
  }, [sheetOpen, pinnedOpen, collapse]);

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
    // A stale thread-focus intent (queued by an earlier maximize/settle whose
    // sheetOpen edge never consumed it) would fire on THIS open's sheetOpen
    // flip and steal focus from the composer the very tap just focused —
    // breaking the grabber's two-step keyboard dismiss. This open's focus
    // target is explicitly the composer, so void any queued intent.
    focusThreadRef.current = false;
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
  //
  // FOLLOW-THE-POINTER CONTRACT. The drag is a clamped per-frame integrator
  // over ONE continuum coordinate `cont`:
  //
  //   -PILL_OPEN_DISTANCE ─ pill capsule
  //                     0 ─ input bar (openProgress 1, thread height 0)
  //        insetPanelMaxH ─ inset FULL detent
  //          fullPanelMaxH ─ edge-to-edge full-bleed ceiling
  //
  // Every pointer frame adds the frame's delta and clamps at both ends, so
  // travel past an edge is CONSUMED (never banked) and a reversal moves the
  // sheet on its very first pixel — an up-down-up mouse drag cannot drift out
  // of sync with the cursor. Nothing springs while the finger is down: the
  // morphs (openProgress, threadHeight, fullBleedT) are pure functions of
  // `cont`, and the only mid-drag React state change is the maximize flag
  // mirroring the morph with hysteresis (0.99 up / 0.9 down). Release intent
  // (flick/detent/maximize/pill) lives in the onPull*/onSettleFree handlers.
  const onDragOffset = React.useCallback(
    (offset: number) => {
      // Onboarding pins the sheet at FULL: the live drag must not move it.
      if (pinnedOpen) return;
      if (!draggingRef.current) {
        stopThreadAnimation();
        stopOpenProgressAnimation();
        // Hand the shape morph to the finger — stop any in-flight settle spring
        // so a fresh over-pull tracks 1:1 instead of fighting a decay.
        stopFullBleedAnimation();
        // Fresh gesture: reset the peak-pull tracker (#13531) and record where
        // the sheet stood when the finger landed.
        maxPullRawRef.current = 0;
        // Seed the continuum from the DERIVED resting pose (detent/free-rest),
        // not the live threadHeight — the sheet visually rests at `baseH`, and
        // reading the motion value would pick up a mid-flight settle spring.
        let startH = baseH;
        // De-slack a capped OPEN sheet: at the FULL detent the thread's
        // flex-basis (baseH = panelMaxH) exceeds what actually fits — the thread
        // is flex-shrunk to the panel. Dragging DOWN would first have to drain
        // that invisible slack before the panel shrank (a ~chrome-px dead zone
        // where the finger moves but the sheet edge doesn't). Snap the seed to
        // the thread's REAL rendered height so a downward drag shrinks the panel
        // 1:1 from the first pixel. No visual change: the panel is already this
        // tall (capped), we only realign the motion value to it.
        if (sheetOpen && typeof document !== "undefined") {
          const threadEl = document.querySelector<HTMLElement>(
            '[data-testid="chat-thread"]',
          );
          const actualThreadH = threadEl?.getBoundingClientRect().height;
          if (
            actualThreadH != null &&
            actualThreadH > 0 &&
            actualThreadH < startH - 2
          ) {
            startH = actualThreadH;
            threadHeight.set(actualThreadH);
          }
        }
        const cont0 = pilled
          ? -PILL_OPEN_DISTANCE
          : sheetOpen
            ? startH
            : // The input bar is the continuum origin; a collapsed rest never
              // carries height.
              0;
        dragContRef.current = cont0;
        dragStartContRef.current = cont0;
        dragStartHRef.current = Math.max(0, cont0);
        // Offsets are measured from pointerdown, so the integrator's origin is
        // 0 — the first delivered frame's whole travel integrates (an rAF-
        // coalesced first move can already carry real distance).
        dragLastOffsetRef.current = 0;
        // Reset the measured-top maximize tracking for the fresh gesture. Never
        // seeded pinned: a gesture that starts at the ceiling (a restore grab)
        // is fully described by rawOverpullT — a pinned seed would misread the
        // whole downward track as measuredOverpullT = 1.
        const el0 = getPanelElement();
        dragStartTopRef.current = el0
          ? el0.getBoundingClientRect().top
          : Number.POSITIVE_INFINITY;
        dragMinTopRef.current = dragStartTopRef.current;
        dragPinnedRef.current = false;
        dragOffAtPinRef.current = 0;
        dragPinTopRef.current = 0;
        // Clear any stale pin fraction from a prior gesture; this frame re-sets it
        // from the fresh over-pull below.
        overpullCapT.set(0);
      }
      draggingRef.current = true;
      // Promote the panel + thread to their own GPU layer for the duration of
      // the drag (dropped on settle) so the live morph composites instead of
      // repainting per frame on iOS Safari. Skipped under reduced-motion: there
      // is no settle spring to composite, and the async clear below only runs on
      // the animated release path.
      if (!reduce) setDraggingState(true);
      // Integrate this frame's travel and clamp at the continuum edges. The
      // clamp IS the consumption: the next frame integrates from the clamped
      // value, so beyond-the-edge travel evaporates instead of becoming debt a
      // reversal must pay back before the sheet moves.
      const dy = offset - dragLastOffsetRef.current;
      dragLastOffsetRef.current = offset;
      const cont = Math.min(
        fullPanelMaxH,
        Math.max(-PILL_OPEN_DISTANCE, dragContRef.current + dy),
      );
      dragContRef.current = cont;
      // Peak pull (height units) for the release decision, tracked only on
      // upward frames — a downward-only drag from a tall detent must never
      // read as a maximize the finger never pulled toward.
      if (dy > 0 && cont > maxPullRawRef.current) maxPullRawRef.current = cont;
      // A pull that carried into the maximize over-pull zone but then reversed
      // back BELOW the inset FULL height has given that intent up: void the
      // peak so the RELEASE decision can't re-maximize the sheet the user just
      // dragged back down.
      if (
        cont < insetPanelMaxH &&
        maxPullRawRef.current >=
          insetPanelMaxH + maxOverPull * MAXIMIZE_COMMIT_T
      ) {
        maxPullRawRef.current = 0;
      }
      // Apply the morphs — each a pure function of `cont`, all finger-locked.
      // Below 0 the travel is the input↔pill morph (the input scales down into
      // the capsule and crossfades out under the finger — in BOTH directions);
      // above 0 it is the thread height.
      openProgress.set(cont < 0 ? clamp01(1 + cont / PILL_OPEN_DISTANCE) : 1);
      threadHeight.set(Math.max(0, cont));
      // Mount the panel body on ANY pull that opens height, even with no
      // history yet, so the sheet follows the finger on a brand-new/empty chat
      // too (else it just darkened the scrim and sprang back — the "won't
      // drag" bug). Focus-to-open stays gated in `expand` so boot never
      // auto-pops an empty sheet.
      if (!sheetOpen) setDragPreviewMounted(cont > 0);
      // MAXIMIZE MORPH. Raw height keeps the sheet finger-locked through the
      // inset-FULL → edge-to-edge gap. The measured top-edge latch fills the
      // gap for short-content chats whose panel visually pins at its content
      // ceiling before the raw height has consumed the whole morph budget.
      const rawOverpullT = clamp01((cont - insetPanelMaxH) / maxOverPull);
      let measuredOverpullT = 0;
      // The latch only makes sense while the gesture is net-ABOVE its start —
      // a descending drag (a restore, or a pull-shut) is fully described by
      // rawOverpullT and must never re-engage the measured pin.
      if (cont > 0 && cont > dragStartContRef.current) {
        const el = getPanelElement();
        const top = el ? el.getBoundingClientRect().top : null;
        if (top != null) {
          if (!dragPinnedRef.current) {
            // Still rising: track the lowest (highest-on-screen) top reached.
            if (top < dragMinTopRef.current - 1) {
              dragMinTopRef.current = top;
            } else if (
              dy > 0 &&
              // The panel top has stopped rising while the finger keeps pulling
              // up AND the panel is TALL (top high on screen) → pinned at the
              // inset-full ceiling. Testing the ABSOLUTE top position (not "rose
              // ≥24px from the gesture start") is what makes this fire when the
              // drag BEGINS already at the ceiling — a pull up from the FULL
              // detent, where the panel cannot rise further on its own. Without
              // it the over-pull never engaged: the panel froze at the ceiling
              // until the finger went far past the screen top (the reported
              // "freezes at ~90%, have to drag beyond the screen to maximize").
              // `top > 2` keeps a gesture that BEGINS at the edge-to-edge
              // ceiling (a restore grab) from latching on its first frame.
              top < viewportH * 0.35 &&
              top > 2
            ) {
              // Latch the over-pull phase from here: further finger travel now
              // collapses the top margin (fullBleedT) 1:1, top pin→0.
              dragPinnedRef.current = true;
              dragOffAtPinRef.current = cont;
              dragPinTopRef.current = Math.max(1, dragMinTopRef.current);
            }
          }
          if (dragPinnedRef.current) {
            measuredOverpullT = clamp01(
              (cont - dragOffAtPinRef.current) /
                Math.max(1, dragPinTopRef.current),
            );
            // Reversed back below the pin → drop the over-pull phase.
            if (cont < dragOffAtPinRef.current - 4) {
              dragPinnedRef.current = false;
              dragMinTopRef.current = top;
            }
          }
        }
      }
      const overpullT = Math.max(rawOverpullT, measuredOverpullT);
      const startedFromFullDetent = expanded && freeH == null;
      const livePeakTravel = cont - Math.min(0, dragStartContRef.current);
      const liveLongHaul = livePeakTravel >= viewportH * 0.8;
      // Feed the finger's over-pull to the height cap so it lifts through the
      // inset-ceiling flex-overshoot dead zone (where `cont < insetPanelMaxH` yet
      // the panel is already pinned at the ceiling) — the panel edge keeps
      // tracking the finger instead of freezing until `cont` clears the ceiling.
      overpullCapT.set(overpullT);
      // DISCRETE full-bleed SHAPE. The finger NEVER sets `fullBleedT` directly —
      // the "awkward lerp" of border/radius/width easing with every pixel. Instead
      // the over-pull flips a state at the threshold and the shape SPRINGS to it
      // once (border, radius, side inset, width, composer capsule). Only the SHAPE
      // is stateful: the panel HEIGHT tracked the finger 1:1 the whole way up
      // because `panelCapH` follows the finger's over-pull + `threadHeight`, not
      // this spring, so there is no ceiling freeze. Reversible with hysteresis:
      // pulling back down below the release threshold springs the shape home.
      // Reduced-motion cuts instantly.
      // A real keyboard blocks maximize (the edge-to-edge panel would spill above
      // the keyboard-shrunk visual viewport); a pull-to-full with the keyboard up
      // settles at the inset FULL detent instead.
      if (
        overpullT >= MAXIMIZE_COMMIT_T &&
        (startedFromFullDetent || liveLongHaul) &&
        !maximized &&
        !keyboardBlocksMaximize
      ) {
        setFreeH(null);
        setMode("full");
        setMaximized(true);
        focusThreadRef.current = true;
        if (reduce) fullBleedT.set(1);
        else animateFullBleedTo(1);
        detentHaptic();
      } else if (overpullT <= MAXIMIZE_RELEASE_T && maximized) {
        setMaximized(false);
        if (reduce) fullBleedT.set(0);
        else animateFullBleedTo(0);
        // Void the peak so the release decision does not re-maximize from an
        // abandoned high-water mark.
        maxPullRawRef.current = 0;
      }
    },
    [
      pinnedOpen,
      pilled,
      sheetOpen,
      baseH,
      insetPanelMaxH,
      fullPanelMaxH,
      maxOverPull,
      viewportH,
      expanded,
      freeH,
      threadHeight,
      openProgress,
      fullBleedT,
      overpullCapT,
      reduce,
      setDraggingState,
      stopThreadAnimation,
      stopOpenProgressAnimation,
      stopFullBleedAnimation,
      animateFullBleedTo,
      setDragPreviewMounted,
      getPanelElement,
      maximized,
      keyboardBlocksMaximize,
    ],
  );

  // Pull-to-maximize decision (#13531): a released upward pull whose PEAK raw
  // upward travel (maxPullRawRef, pre-clamp/pre-pin) cleared 80% of the viewport
  // height commits to edge-to-edge full-bleed. The live shape morph in
  // onDragOffset is calibrated to the SAME threshold — it reaches full exactly
  // here — so the panel is already reading as maximized when this commits it,
  // and a release short of the threshold settles the morph back to the inset FULL
  // detent. Returns true when it took over the release so the caller skips its
  // normal detent settle. Onboarding never re-triggers this (pinned full-bleed).
  const maybeMaximizeOnRelease = React.useCallback((): boolean => {
    if (pinnedOpen) return false;
    // A real keyboard blocks the release-time maximize too (mirrors the mid-drag
    // gate): a pull-to-full with the keyboard up settles at the inset FULL detent
    // instead of an edge-to-edge maximize that would spill above the visible area.
    if (keyboardBlocksMaximize) return false;
    // Two distinct maximize intents, both read from the gesture itself:
    //  - OVER-PULL: a drag that started at the inset FULL detent and whose peak
    //    raw pull carried at least half the maximize morph PAST that detent (the
    //    finger visibly squared the corners) — the canonical exit upward from
    //    FULL. A free-rest below FULL steps to FULL first instead of surprise
    //    maximizing on a short flick.
    //  - LONG HAUL: the drag swept ≥80% of the screen — "grabbed it and threw
    //    it to the top". Short free-rest flicks step to FULL because the raw
    //    travel stays below this threshold.
    // The 80% is measured against the LAYOUT viewport (screen space), not the
    // keyboard-shrunk visual viewport: with a soft keyboard up, 80% of the
    // visual height can fall below the FULL detent, so an ordinary flick to
    // full would accidentally commit an edge-to-edge maximize whose top spills
    // above the screen.
    const screenH = Math.max(viewportH, viewport.innerHeight);
    const peak = maxPullRawRef.current;
    // "At least half the real morph gap past the inset FULL height" — the
    // finger visibly carried the panel more than halfway to edge-to-edge.
    const startedFromFullDetent = expanded && freeH == null;
    const overPulled =
      startedFromFullDetent &&
      peak >= insetPanelMaxH + maxOverPull * MAXIMIZE_COMMIT_T;
    // Long haul measures TRAVEL, not height: a pull that began on the pill
    // spends PILL_OPEN_DISTANCE forming the input before any height exists, so
    // shift the peak by the below-zero start to compare finger distance.
    const peakTravel = peak - Math.min(0, dragStartContRef.current);
    const longHaul = peakTravel >= screenH * 0.8;
    if (overPulled || longHaul) {
      focusThreadRef.current = true;
      maximizeFromPull();
      return true;
    }
    return false;
  }, [
    pinnedOpen,
    keyboardBlocksMaximize,
    viewportH,
    viewport.innerHeight,
    insetPanelMaxH,
    maxOverPull,
    maximizeFromPull,
    expanded,
    freeH,
  ]);

  const pullBinding: PullGestureBinding = usePullGesture({
    onStart: resetPullPeak,
    onDrag: onDragOffset,
    onDragReset: settleDrag,
    // Horizontal swipe carries two meanings by sheet state: collapsed, it is
    // the home↔launcher rail nav; with the sheet OPEN, dragging the chat
    // sideways (either direction) DISMISSES it — collapse to the pill, the
    // shared "put the chat away" landing.
    swipeEnabled: true,
    onSwipeLeft: () => {
      settleDrag();
      if (sheetOpen) collapseToPill();
      else goLauncher();
    },
    onSwipeRight: () => {
      settleDrag();
      if (sheetOpen) collapseToPill();
      else goHome();
    },
    // Flicks step one detent; released drags from the collapsed input honor the
    // live height so a long pull can land full instead of snapping back to half.
    // The inline closures are rebuilt every render, so they always read the
    // current detent.
    onPullUp: () => {
      setDragPreviewMounted(false);
      if (pilled) {
        // PILL → open: a flick up opens; a HELD drag released with flick
        // velocity honors how far the finger actually carried the sheet — a
        // long pull from the pill lands FULL (or commits maximize past the 80%
        // threshold), a short flick lands HALF, so pill → input → chat →
        // full-screen is one continuum from the very bottom. Releasing
        // draggingRef first lets the pilled→openProgress effect spring the
        // morph 0→1.
        draggingRef.current = false;
        if (maybeMaximizeOnRelease()) return;
        const releasedH = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (releasedH < SHEET_DETENT_MAGNET && !hasRevealableThread) {
          // A short flick with no thread to open into → the bare input bar.
          setMode("input");
          if (reduce) {
            stopThreadAnimation();
            threadHeight.set(0);
          } else animateThreadHeight(0);
          detentHaptic();
          return;
        }
        focusThreadRef.current = true;
        goToDetent(releasedH >= halfH + SHEET_DETENT_MAGNET ? "full" : "half");
        return;
      }
      // Over-pull past the 80%-viewport threshold maximizes from ANY open state
      // (#13531) — this must win before the per-state detent settle below.
      if (maybeMaximizeOnRelease()) return;
      if (!sheetOpen) {
        // A committed pull-up opens even an empty chat (no early spring-back on
        // `!hasRevealableThread`) — the deliberate drag is the user asking to
        // open; `expand` still guards the passive focus-to-open path.
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
      if (pinnedOpen) return settleDrag();
      if (pilled) return settleDrag(); // already the lowest detent
      if (sheetOpen) {
        // Step down from the LIVE height, so a flick and a held-drag-then-flick
        // both land where the finger left the sheet: a plain flick (height
        // barely moved) steps ONE detent — full → half → input, never skipping;
        // a held drag carried to the bottom released with downward velocity
        // lands at the bottom (pill/input by collapseFromRelease), not bounced
        // back up to a detent it deliberately left. A downward flick also
        // closes the keyboard — goToDetent("collapsed") blurs; half-step too.
        const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (h <= SHEET_DETENT_MAGNET) return collapseFromRelease();
        if (h > halfH + 1) {
          inputRef.current?.blur();
          goToDetent("half");
        } else {
          goToDetent("collapsed");
        }
        return;
      }
      // INPUT → PILL: collapse the input away into a pill at the bottom.
      collapseToPill();
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
      if (pinnedOpen) return settleDrag();
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
      // small thumb drift should spring back to the input, not collapse the
      // chat. (Open-sheet drags that reach the bottom land via the magnetism
      // below — collapseFromRelease picks pill vs input.)
      if (!sheetOpen && direction === "down") {
        if (dragContRef.current <= -PILL_OPEN_DISTANCE / 2) collapseToPill();
        else settleDrag();
        return;
      }
      // A slow upward over-pull past the 80%-viewport threshold maximizes
      // (#13531), even though the visible height rubber-banded at FULL — the
      // peak raw pull (maxPullRawRef) carries the intent. Downward restore drags
      // must not re-enter full-bleed, even if a previous upward peak was visible
      // before the release settled.
      if (direction === "up" && maybeMaximizeOnRelease()) return;
      const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
      // DETENT MAGNETISM — the resting positions are the detents {collapsed:0,
      // half, full}; a release within SHEET_DETENT_MAGNET of one snaps to it
      // (deterministic, no janky near-detent slivers), and only the clear gaps
      // between them keep the free-drag rest height. goToDetent commits the
      // honest flags so data-detent + the maximize header match the height.
      if (h <= SHEET_DETENT_MAGNET) {
        // Near the bottom → pill or input by gesture intent.
        collapseFromRelease();
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
  // Latch a press on the open-sheet grabber so its mount gate can't drop the
  // captured pointer between pointerdown and the integrator's first frame.
  const grabberBinding = React.useMemo(
    () => withPressLatch(pullBinding, grabberPressRef),
    [pullBinding],
  );

  // Top-20% pull-down-to-restore (#13531). While maximized (full-bleed) there is
  // no SheetGrabber; this binding drives an invisible grab strip over the top
  // 20% of the panel. A downward pull drops full-bleed on the first downward
  // frame and LIVE-TRACKS the finger — the panel insets and shrinks 1:1 under the
  // pointer, resting where released (free rest, with detent magnetism at
  // half/full and a full collapse near the bottom). Keyboard (Enter/Space/
  // ArrowDown) does the discrete restore. Onboarding pins the sheet, so the zone
  // is never rendered during first-run (guarded anyway for safety).
  const restoreFromMaximizedGuarded = React.useCallback(() => {
    if (pinnedOpen) return;
    restoreFromMaximized();
  }, [pinnedOpen, restoreFromMaximized]);
  // Live drag: reuse the shared drag math (onDragOffset) so the panel tracks
  // the finger identically to a grabber drag — the height AND the edge-to-edge
  // ↔ inset shape morph (a pure function of the height in onDragOffset) both
  // run 1:1 under the pointer. The only extra step is dropping full-bleed the
  // moment the pull turns downward, so the inset layout is what follows the
  // finger; an upward hold leaves `maximized` set and rubber-bands at the
  // full-bleed ceiling.
  const onRestoreDrag = React.useCallback(
    (offset: number) => {
      if (pinnedOpen) return;
      // Fresh gesture (onDragOffset flips draggingRef on its first frame). Seed
      // the peak at 0 — the maximized sheet sits at the ceiling, which is
      // gesture-start offset 0 — NOT the first sampled offset (a fast/coalesced
      // first move can already be far down, and seeding the peak there would
      // make `offset < peak` impossible so a plain pull-down never un-maximized).
      if (!draggingRef.current) {
        restoreDidUnmaximizeRef.current = false;
        restorePeakOffsetRef.current = 0;
      }
      if (offset > restorePeakOffsetRef.current) {
        restorePeakOffsetRef.current = offset;
      }
      // Drop full-bleed the moment the finger nets downward off the ceiling
      // peak (any upward drift is consumed by onDragOffset's ceiling rebase, so
      // the sheet leaves the ceiling exactly here, not at raw `offset < 0`).
      // The small slop absorbs touch jitter so a held-at-top hand doesn't flap.
      if (
        maximized &&
        offset < restorePeakOffsetRef.current - RESTORE_UNMAX_SLOP
      ) {
        setMaximized(false);
        setRestoreDragging(true);
        restoreDidUnmaximizeRef.current = true;
      }
      onDragOffset(offset);
    },
    [pinnedOpen, maximized, onDragOffset],
  );
  // Release from a restore drag: if it never un-maximized (an upward/stationary
  // gesture) keep it pinned full-bleed; otherwise settle at the released height —
  // free rest, snap to a nearby detent, or collapse near the bottom (the same
  // magnetism the grabber uses).
  const settleRestore = React.useCallback(() => {
    draggingRef.current = false;
    setDragPreviewMounted(false);
    setRestoreDragging(false);
    if (pinnedOpen || !restoreDidUnmaximizeRef.current) return settleDrag();
    // A restore that un-maximized always lands on the inset shape; drive the
    // morph home (0) so a release mid-return finishes un-morphing the edges.
    animateFullBleedTo(0);
    // The live pin fraction is finger-only; hand the cap back to the settle springs.
    overpullCapT.set(0);
    const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
    if (h <= SHEET_DETENT_MAGNET) {
      // The restore drag started full-height, so a run to the bottom lands on
      // the PILL (collapseFromRelease reads the gesture-start height).
      collapseFromRelease();
      return;
    }
    focusThreadRef.current = true;
    if (h >= openH - SHEET_DETENT_MAGNET) {
      goToDetent("full");
    } else if (Math.abs(h - halfH) <= SHEET_DETENT_MAGNET) {
      goToDetent("half");
    } else {
      setFreeH(h);
      setMode("half");
      setMaximized(false);
    }
  }, [
    pinnedOpen,
    settleDrag,
    threadHeight,
    panelMaxH,
    openH,
    halfH,
    collapseFromRelease,
    goToDetent,
    animateFullBleedTo,
    overpullCapT,
    setDragPreviewMounted,
  ]);
  // Cancel/tap on the strip: drop the drag flag and spring back to the current
  // detent (a tap keeps it maximized; a rotation-canceled drag re-settles).
  const resetRestore = React.useCallback(() => {
    setRestoreDragging(false);
    settleDrag();
  }, [settleDrag]);
  const maximizeRestoreBinding: PullGestureBinding = usePullGesture({
    onStart: resetPullPeak,
    // Sideways swipe on the maximize grab strip dismisses the chat to the
    // pill — the same drag-the-chat-away gesture the open-sheet grabber owns
    // (fullBleed is derived from mode, so its settle animation unwinds the
    // full-bleed frame on the flip). Never nav: the chat is full-screen here.
    swipeEnabled: true,
    onSwipeLeft: () => {
      setRestoreDragging(false);
      collapseToPill();
    },
    onSwipeRight: () => {
      setRestoreDragging(false);
      collapseToPill();
    },
    onDrag: onRestoreDrag,
    onDragReset: resetRestore,
    // Flick or slow-release both settle at the current finger height.
    onPullUp: settleRestore,
    onPullDown: settleRestore,
    onSettleFree: settleRestore,
    // A pointercancel / lost capture (rotation, OS takeover) must NOT strand
    // `restoreDragging` true — that would keep the panel max-height full-screen
    // and break the next open. Settle it like any other release.
    onCancel: settleRestore,
  });
  // Latch a press on the restore strip. Without this the strip can unmount under
  // its own captured pointer the instant the drag drops full-bleed (before
  // `restoreDragging` has re-mounted it), stranding the release: `settleRestore`
  // never runs, so `restoreDragging`/`draggingRef` stay true and freeze the
  // sheet — the corrupted state the desktop-held drain leg then trips over.
  const restoreZoneBinding = React.useMemo(
    () => withPressLatch(maximizeRestoreBinding, restorePressRef),
    [maximizeRestoreBinding],
  );

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
    <motion.div
      ref={overlayRef}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 flex w-full min-w-0 flex-col",
        // Resting on a landscape phone, the compact composer hugs the trailing
        // (inline-end) bottom corner — the conventional compose slot views leave
        // free — instead of centering a wide band over their controls (#14173).
        // Direction-aware: `items-end` is inline-end, so it lands bottom-left in
        // RTL. Full-width children (banners) are unaffected (they stay `w-full`).
        compactLanding ? "items-end" : "items-center",
        // The side inset (px) is driven by the shape spring below (`overlayPadX`),
        // not a class, so it eases 12→0 on maximize and 0→12 on de-maximize.
      )}
      // Lift the whole overlay above the on-screen keyboard (`bottom`); padding
      // below the composer is conditional on an actual keyboard lift, not focus
      // alone. With the keyboard up, only a small gap (0.75rem, matching the side
      // margin) sits between composer and keyboard. At rest, clear the
      // home-gesture zone (max safe-area / android inset) plus a hair, keeping the
      // chat low without touching that zone.
      style={{
        zIndex: Z_SHELL_OVERLAY,
        // At rest, the measured reclaim offset seats the composer at the
        // physical bottom on collapsed iOS standalone/native viewports. Off that
        // surface the custom property is zero. When the keyboard is visible,
        // effectiveKeyboardInset owns the lift instead of the reclaim offset.
        bottom: keyboardLiftActive
          ? effectiveKeyboardInset
          : STANDALONE_BOTTOM_RECLAIM_OFFSET,
        // Full-bleed uses no overlay bottom padding; gesture-zone clearance
        // lives inside the composer row so controls sit above the home indicator.
        // Non-full-bleed keeps the same safe-area clearance above the reclaimed
        // physical bottom, with the wallpaper/app floor owning everything below.
        // Side inset eases with the shape spring (12px inset → 0 at full-bleed).
        paddingLeft: overlayPadX,
        paddingRight: overlayPadX,
        // Bottom clearance: the keyboard-lift gap wins when the keyboard is up;
        // else, only WHILE maximizing/restoring does the composer inset ease with
        // the shape spring (its value equals the plain rest inset at the boundary,
        // so the switch is seamless) — at rest it stays the plain calc so the
        // home-indicator clearance contract is exact.
        paddingBottom: keyboardLiftActive
          ? "0.75rem"
          : fullBleed || restoreDragging || isDragging
            ? overlayPadBottom
            : "calc(var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem)",
      }}
      data-testid="continuous-chat-overlay"
      data-open={sheetOpen ? "true" : undefined}
    >
      {/* NO reclaimed-bottom-floor element here (removed): it used to paint a
          transparent→var(--launch-bg) gradient over the strip below the
          composer, from when that strip was an UNPAINTED void that read as a
          dead black bar. The app shell now guarantees that zone is always
          painted underneath this overlay — the full-bleed wallpaper on
          shared-background routes (the transparent app-safe-area-floor lets it
          own the screen to the true bottom edge) and the dark `bg-bg` floor on
          opaque routes. Repainting it here with --launch-bg (a HOST-seeded
          launch color, orange on web) drew a visible tinted band over the
          wallpaper under the floating composer — the residual "gap" on the
          standalone home view. Everything below the composer must simply show
          whatever the shell paints: wallpaper, lockscreen-style. */}
      {/* Structural inset-0 marker behind the open chat. It NO LONGER dims the
          background — pulling the chat up used to darken everything behind it,
          which fought the frosted-glass panel; the panel's own backdrop blur now
          carries the separation, so the live view stays bright behind the glass.
          Kept as a transparent, pointer-transparent element (outside taps are
          owned by the document-level detector; e2e uses it as a coordinate
          target) with the same data-active flag consumers read. */}
      <motion.div
        aria-hidden="true"
        data-testid="chat-sheet-backdrop"
        data-active={sheetOpen ? "true" : "false"}
        className="fixed inset-0"
        style={{
          visibility: scrimVisibility,
          pointerEvents: "none",
        }}
      />

      {/* First-run opaque backdrop (#12178): while onboarding is open this
          OPAQUE `bg-bg` layer sits ABOVE the gradient scrim and BELOW the glass
          panel, so no launcher/home pixel shows through — including behind the
          translucent panel glass. On completion it fades to transparent (~400ms)
          in step with the one-shot collapse, revealing the launcher warm
          underneath; reduced-motion cuts. Pointer-transparent like the scrim. */}
      {firstRunBackdrop !== "off" ? (
        <motion.div
          aria-hidden="true"
          data-testid="chat-first-run-backdrop"
          data-first-run-opaque={
            firstRunBackdrop === "opaque" ? "true" : "false"
          }
          className="fixed inset-0 bg-bg"
          initial={false}
          animate={{ opacity: firstRunBackdrop === "opaque" ? 1 : 0 }}
          transition={{
            duration: firstRunBackdrop === "revealing" ? 0.4 : 0,
            ease: "easeInOut",
          }}
          onAnimationComplete={() => {
            setFirstRunBackdrop((prev) =>
              prev === "revealing" ? "off" : prev,
            );
          }}
          style={{ pointerEvents: "none" }}
        />
      ) : null}

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
              WALLPAPER_FLOAT_SHADOW,
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
          the turn until the model is ready. Boot status likewise has NO
          floating surface: a stalled boot speaks in the transcript via the
          boot-recovery conductor (use-boot-recovery-conductor.ts), and the
          in-transcript no-provider gate covers the unconfigured state. */}

      {/* THE chat — one connected object. Its base is the always-present input;
          the conversation grows UP out of it on a pull, inside this same panel.
          The drag handle floats above the panel in THIS non-clipped wrapper
          (the fieldset itself is overflow-hidden), so its big hit zone can reach
          up into the empty space above the input. Pull the handle up to reveal
          history; pull down to collapse the input into the pill. */}
      <motion.div
        // Width is the motion value above (rest: 48rem / 13rem compact-landing
        // #14173; edge-to-edge as the maximize morph completes) so the glass
        // grows in lock-step with the finger instead of popping on commit. The
        // grabber + pill are positioned relative to THIS wrapper, so they
        // shrink and re-corner with it.
        style={{ maxWidth: wrapperMaxW }}
        className="pointer-events-none relative flex w-full flex-col items-center"
      >
        {!firstRunOpen &&
        ((!fullBleed && !restoreDragging) ||
          draggingRef.current ||
          grabberPressRef.current != null) ? (
          // Suppressed while full-bleed (the restore strip owns the top) and
          // while a restore drag is in flight (so the strip keeps the pointer
          // capture through the un-maximize) — EXCEPT while a grabber drag is
          // live OR merely pressed: a MID-DRAG commit (pill or maximize) must not
          // unmount or disable the element holding the pointer capture, or the
          // gesture dies at the exact moment it commits. `grabberPressRef` widens
          // that window back to the pointerdown, before the integrator's first
          // frame flips `draggingRef`. Onboarding hides the grabber entirely: it
          // is pinned, undismissable, and sign-in-first.
          <SheetGrabber
            open={sheetOpen}
            onOpen={openFromGrabber}
            onClose={collapse}
            binding={grabberBinding}
            // The handle stays QUIET while the mic is recording — the composer
            // mic/voice glyphs already carry the "capture is hot" pulse right
            // next to the user's attention; a second pulsing bar above them
            // read as noise. Only the collapsed PILL (where no composer glyph
            // is visible) pulses for a live capture — see PillHandle below.
            glow={(listening || responding) && !recording}
            opacity={grabberOpacity}
            pilled={pilled}
            inert={!sheetOpen && (hasImages || Boolean(imageError))}
          />
        ) : null}
        <motion.fieldset
          ref={bindPanelRef}
          aria-label="Chat composer"
          data-testid="chat-sheet"
          onWheel={onSheetWheel}
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
            ...CHAT_PANEL_THEME,
            // Morph-driven cap: the inset ceiling at rest, growing to the
            // full-bleed ceiling in lock-step with the shape morph (see
            // panelCapH) so an over-pull grows 1:1 under the finger.
            maxHeight: panelCapH,
            // Full-bleed must be exactly scale 1 — a sub-1 morph scale with a
            // bottom transform-origin would drop the top edge below the status
            // bar (the "gap at the top when maximized" bug). While open (incl. a
            // restore drag) panelScale is already 1; the height, not a scale,
            // shrinks.
            scale: fullBleed ? 1 : panelScale,
            // Grow UP out of the pill at the bottom.
            transformOrigin: "bottom center",
            // GPU-promote the panel ONLY while a drag/settle is live (#swipe-
            // smoothness). The morph animates `scale` (a transform) here and the
            // thread animates its `flexBasis` below; hinting `will-change:
            // transform` for the duration of the gesture lets WebKit/iOS Safari
            // rasterize the panel onto its own compositor layer up front, so the
            // finger-tracked morph and the release spring composite without
            // repainting the frosted glass each frame (the installed-PWA
            // micro-stutter). Dropped on settle — a permanent hint keeps the
            // layer (and its memory) resident for no benefit at rest.
            willChange: isDragging ? "transform" : undefined,
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
              // SOLID warm-dark panel. The chat floats over the live ember field,
              // so a transparent/border-only surface let the home widgets bleed
              // straight through the open thread (the #1 "too transparent"
              // complaint). The panel is now an opaque warm near-black with a
              // warm hairline edge that seats it above the field, so nothing
              // behind it ever shows through. NOTE: the opaque fill is enforced
              // by the inline backgroundColor below (inline wins over this
              // class); this class supplies the edge. Flat system: depth =
              // border, not a drop shadow (all shadow tokens are none).
              fullBleed
                ? "border-0 bg-card"
                : "border border-border-strong bg-card",
            )}
            style={{
              opacity: glassOpacity,
              // Corner radius eases with the full-screen shape spring: the inset
              // sheet radius squares off as it maximizes and rounds back as it
              // de-maximizes, in lockstep with the side/bottom insets.
              borderRadius: morphRadius,
              // REAL frosted glass on the inset sheet: a mostly-translucent dark
              // fill over a strong backdrop blur, so the live view behind reads
              // as a soft, bright frost — not the grayish near-opaque slab a high
              // fill produced. The heavy blur (30px) + light saturate is what
              // keeps text readable while letting the backdrop's color and light
              // through: nothing sharp bleeds, but the panel is unmistakably
              // glass, not a gray card. `--card` / `--bg` are scoped by
              // CHAT_PANEL_THEME on the fieldset, not the orange app theme behind.
              // Full-bleed stays fully opaque (it covers the whole screen — there
              // is nothing to see through, and the blur would be wasted battery).
              backgroundColor: fullBleed
                ? "var(--bg)"
                : "color-mix(in srgb, var(--card) 62%, transparent)",
              backdropFilter: fullBleed
                ? undefined
                : "blur(30px) saturate(1.4)",
              WebkitBackdropFilter: fullBleed
                ? undefined
                : "blur(30px) saturate(1.4)",
              // Liquid-glass bevel: a bright top-left rim over a soft
              // bottom-right shade so the frosted edge catches light like a real
              // glass slab. Only on the inset sheet — full-bleed has no edge to
              // catch light. Depth here is the glass rim, not a drop shadow (the
              // flat system keeps all shadow tokens none).
              boxShadow: fullBleed ? undefined : LIQUID_GLASS_EDGE_SHADOW,
              // Specular sheen: a soft radial highlight near the top-left (as if
              // lit from above) over the faint neutral top-edge fade — the glass
              // catches light instead of just fading. Neutral white only, NOT the
              // warm `--surface` gradient that read as brown.
              backgroundImage: `${LIQUID_GLASS_SHEEN}, linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 22%)`,
              // Full-bleed: extend the glass UP through the safe-area-top so the
              // dark background reaches the true top of the screen. The panel
              // height comes from visualViewport (which excludes the Android
              // status bar) while the panel sits in a screen-top fixed container,
              // so without this the glass starts a status-bar-height below the top
              // (the "safe-area gap" above maximized chat). overflow-visible on the
              // panel lets it bleed up; content (header, with its own safe-area
              // padding) is untouched. Rides the shape spring (0px at rest) so
              // the extension eases in with the morph instead of popping at
              // commit. Harmless when the inset is 0.
              top: glassTopExtension,
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
          {/* AX-tree mirror of data-maximized (#13531). `detentLabel` folds the
              full-bleed MAXIMIZED state into "full" (both rest at the top), so the
              detent probe alone cannot tell them apart — the on-device XCUITest
              maximize/restore leg reads this separate probe to observe whether the
              chat committed to edge-to-edge full-bleed. */}
          <span className="sr-only" data-testid="chat-maximized-probe">
            {`chat-maximized:${fullBleed ? "true" : "false"}`}
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
            // touching the sibling glass layer's shadow. Spans the FULL glass
            // width (no maxWidth here): the restore-drag strip (inset-x-0) and
            // the drag-and-drop file intake below both live on this element and
            // must cover the whole panel, including the edge-to-edge glass at
            // full-bleed on wide viewports — a pinned wrapper left dead margins
            // where a restore pull did nothing and a dropped file navigated the
            // tab away. Column width is pinned on the inner rows (header /
            // thread / composer all carry `mx-auto max-w-3xl`), so the chat
            // content never reflows through the maximize morph regardless.
            className="relative z-10 flex min-h-0 w-full flex-col overflow-hidden"
            style={{
              opacity: glassOpacity,
              pointerEvents: pilled ? "none" : "auto",
              // Mirror the surface radius so the content clip matches it.
              borderRadius: morphRadius,
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
            {/* Specular sheen — a soft light from the top edge, the liquid-glass
                highlight. Subtle + non-interactive. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-0 h-20 bg-gradient-to-b from-surface to-transparent"
            />

            {/* Top-bar pull-down-to-restore grab zone (#13531). Confined to the
                safe-area + MAXIMIZE_RESTORE_ZONE_PX strip at the very top so the
                transcript BELOW it stays freely scrollable (wheel + touch-drag)
                and an accidental tap can't jog the sheet out of full-screen — a
                deliberate DOWNWARD drag from the top edge is the only exit.
                Mounted while full-bleed AND for the duration of a restore drag
                (`restoreDragging`) so it keeps the pointer capture after the drag
                drops full-bleed. NOT during onboarding (it pins full-bleed and
                keeps the inert grabber). `z-[15]` sits UNDER the header (`z-20`),
                whose empty space is `pointer-events-none`, so pulls that START
                over the top bar fall THROUGH to this strip. Keyboard-operable
                (Enter/Space/ArrowDown restore) so the gesture-only affordance
                stays WCAG 2.1.1 operable. */}
            {(fullBleed ||
              restoreDragging ||
              restorePressRef.current != null) &&
            !pinnedOpen ? (
              <button
                {...restoreZoneBinding}
                type="button"
                data-testid="chat-maximize-restore-zone"
                aria-label="drag down to exit full screen"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" ||
                    e.key === " " ||
                    e.key === "ArrowDown"
                  ) {
                    e.preventDefault();
                    restoreFromMaximizedGuarded();
                  }
                }}
                className="pointer-events-auto absolute inset-x-0 top-0 z-[15] touch-none bg-transparent"
                style={{
                  height: `calc(env(safe-area-inset-top, 0px) + ${MAXIMIZE_RESTORE_ZONE_PX}px)`,
                }}
              />
            ) : null}

            {/* Sheet header — shown at the HALF detent and up (not just FULL).
              One infinite thread (#13531): no maximize/minimize (that's a
              vertical pull now) and no clear/new-chat (the thread never resets).
              It carries NO buttons — search/upload/camera/transcribe moved to the
              composer "+" menu and Home lives in the launcher — so the chat stops
              acting like a second app nav bar. The bar remains only to reserve
              the safe-area top inset at full-bleed and host the transcribe badge. */}
            {threadPresented ? (
              <motion.div
                data-testid="chat-sheet-header"
                // Mounted while the sheet is open, or while an upward drag is
                // previewing the sheet before release. It can FADE + LERP its
                // space as the live height crosses the header threshold.
                // `headerVisible` gates interactivity + the a11y tree.
                inert={!sheetOpen || !headerVisible || undefined}
                style={{
                  // Full-bleed is always fully open: show the header at full
                  // opacity (headerOpacity is already 1 at any height ≥ half,
                  // which full-bleed guarantees).
                  opacity: fullBleed ? 1 : headerOpacity,
                  // Height cap + safe-area top padding EASE with the shape
                  // morph (headerMaxHMorph / headerPadTopMorph) — a discrete
                  // swap at commit popped the header a status-bar height on
                  // notch devices. Collapsed → 0 top padding (no leaked margin
                  // above the composer); opens to ~10px as the header reveals;
                  // grows to safe-area + 8px as the glass squares off under the
                  // status bar. Set inline (not a Tailwind arbitrary class,
                  // whose env(...,0px) comma breaks the parser).
                  maxHeight: headerMaxHMorph,
                  paddingTop: headerPadTopMorph,
                }}
                className={cn(
                  // `pointer-events-none` on the bar itself so a pull-down that
                  // starts over the EMPTY top-bar space falls through to the
                  // restore strip beneath it (the "should work over the top bar"
                  // fix); interactive content inside the strip opts back in only
                  // when present.
                  "pointer-events-none relative z-20 flex shrink-0 items-center justify-between gap-1.5 overflow-hidden px-3",
                  // Always the centered reading column: pinned even mid-morph
                  // and full-bleed so the header never reflows while the glass
                  // widens (a no-op at rest, where the wrapper is the same 48rem).
                  "mx-auto w-full max-w-3xl",
                )}
              >
                {/* The header carries no nav/search buttons — Search, Upload,
                    Enable camera, and Transcribe all live in the composer "+"
                    menu now, and Home lives in the launcher. This bar exists
                    only to reserve the safe-area top inset at full-bleed and to
                    host the transcription status badge. */}
                {transcriptionMode ? (
                  <div
                    data-testid="chat-transcribing-badge"
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-medium text-accent"
                  >
                    Transcribing — say “exit transcription mode” to stop
                  </div>
                ) : null}
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
                  // `flex flex-col`: the thread is now a flex COLUMN so its lone
                  // child (the scroller) sizes via `flex-1 min-h-0` against this
                  // element's bounded height instead of `height:100%`. A flex
                  // item whose main size comes ONLY from `flex-basis` (the px
                  // MotionValue below) is NOT a definite height for a percentage
                  // `h-full` child on iOS Safari / WebKit (it resolves to auto →
                  // the scroller sizes to CONTENT and never overflows → the
                  // transcript can't scroll on mobile web, #chat-scroll-web). The
                  // flex algorithm gives a `min-h-0` flex child a definite
                  // resolved height regardless, so this makes the scroll viewport
                  // reliably bounded on every engine.
                  "relative z-10 flex min-h-0 w-full shrink grow-0 flex-col overflow-hidden",
                  // Always the centered reading column (a no-op at rest): the
                  // transcript stays this width THROUGH the maximize morph and
                  // at full-bleed — only the glass grows, the text never reflows.
                  // No top-edge fade mask and no grabber inset: the transcript
                  // runs to the panel's top edge and hard-clips there (the
                  // floating grabber overlays it).
                  "mx-auto max-w-3xl",
                )}
                // Flex-basis IS the motion value (px string) — set 1:1 during a drag,
                // spring-animated to a detent on release; no `animate`/`transition`,
                // so no re-render. `shrink min-h-0` lets the panel's `maxHeight` cap
                // win: a tall detent (or the keyboard) shrinks the thread (it
                // scrolls) instead of pushing the panel off-screen.
                // Onboarding (firstRunOpen) mounts locked at the FULL detent and
                // never drags, but the `threadHeight` MotionValue that feeds
                // `threadFlexBasis` starts at 0, so the FIRST paint renders the
                // thread at 0 height and the composer stacks at the top — then a
                // post-commit effect grows it to `openH` and the composer drops a
                // full viewport to the bottom (~0.9 CLS on the first frame a new
                // user sees, #15214). During onboarding there is no drag to track,
                // so pin the flex-basis to the settled open height statically at
                // render time — first paint already matches the resting layout, no
                // reflow. Reverts to the live MotionValue the moment onboarding
                // ends and the sheet becomes interactive.
                style={{
                  flexBasis: firstRunOpen ? `${openH}px` : threadFlexBasis,
                }}
              >
                {/* Message search (#14279): an in-sheet panel that covers the
                    transcript while open. Selecting a hit closes it and jumps
                    (handleSearchJump). Reachable via the composer "+" menu
                    ("Search chat…"), which only exists while the sheet is open;
                    gate on sheetOpen so the panel never intrudes on the resting
                    composer. */}
                {searchOpen && sheetOpen ? (
                  <div
                    data-testid="chat-message-search"
                    data-keyboard-open={keyboardLiftActive ? "true" : undefined}
                    // Bottom-anchored, NON-scrolling flex column. The panel
                    // itself owns scrolling in its results region and pins its
                    // search input to the bottom (`keyboard-anchored` layout),
                    // so the input the user types into always sits right above
                    // a raised soft keyboard — the whole overlay is already
                    // lifted by `effectiveKeyboardInset`, so the panel bottom IS
                    // the top of the keyboard. Making THIS wrapper scroll (the
                    // old `overflow-y-auto`) let the input scroll away under the
                    // keyboard on iOS; keep it `overflow-hidden` and let the
                    // inner results list be the only scroll region.
                    className="absolute inset-0 z-30 flex flex-col overflow-hidden bg-scrim px-4 pb-3 pt-2 backdrop-blur-xl"
                  >
                    <MessageSearchPanel
                      search={runMessageSearch}
                      onJump={handleSearchJump}
                      onClose={closeSearch}
                      layout="keyboard-anchored"
                    />
                  </div>
                ) : null}
                <motion.div
                  id="continuous-thread"
                  data-testid="chat-thread-scroll"
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
                  // `flex-1 min-h-0` (not `h-full`): as the single child of the
                  // flex-column thread above, the scroller fills the parent's
                  // BOUNDED height via the flex algorithm — a resolution that is
                  // definite on every engine, unlike `height:100%` against a
                  // flex-basis-sized parent (auto on iOS Safari → content-sized →
                  // unscrollable, #chat-scroll-web). `min-h-0` lets it shrink
                  // below its content so `overflow-y-auto` actually engages.
                  // `[-webkit-overflow-scrolling:touch]`: iOS Safari needs this
                  // legacy hint to give an `overflow-y-auto` region its own
                  // momentum-scroll compositor layer; without it a nested
                  // overflow region on iOS can fail to take the touch-scroll at
                  // all (the transcript reads as "stuck" — #chat-scroll-web).
                  // Harmless/ignored on every non-WebKit engine.
                  // `overflow-x-hidden`: `overflow-y-auto` alone computes the
                  // cross axis to `auto` too, so a child a hair too wide (a
                  // long code line, the full-bleed chips rail) surfaces a
                  // horizontal scrollbar strip across the sheet on iOS — the
                  // "weird side scroll thingy." This transcript only ever scrolls
                  // vertically; pin the horizontal axis closed.
                  className="scrollbar-hide relative flex min-h-0 w-full flex-1 touch-pan-y flex-col overflow-y-auto overflow-x-hidden overscroll-contain px-5 outline-none [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
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
                      className="sticky top-0 z-[2] -mx-5 mb-1 bg-gradient-to-b from-scrim to-transparent px-5"
                    />
                  ) : null}
                  {/* `mt-auto` keeps the latest line at the bottom (nearest the
                  input) until the thread overflows, then it scrolls. During
                  onboarding only the current first-run turn is displayed, so
                  keep short setup cards centered while letting tall cards grow
                  past the viewport so the scrollport owns the overflow. */}
                  <div
                    ref={threadContentRef}
                    className={cn(
                      "flex flex-col pb-3 pt-1",
                      !firstRunOpen && "mt-auto",
                      firstRunOpen &&
                        "min-h-full shrink-0 justify-center pb-[18vh] pt-0",
                    )}
                  >
                    {/* Top sentinel for infinite upward scroll (#13532, #14279):
                        a zero-height marker just above the oldest turn. When it
                        nears the top of the scroller, useLoadOlderOnScroll
                        prefetches + prepends an older page a viewport early and
                        preserves the reader's anchor so the thread never jumps.
                        Only meaningful in the flat (non-topic) transcript. */}
                    {!firstRunOpen &&
                    !hasTopics &&
                    renderWindow.canLoadOlder &&
                    visibleMessages.length > 0 ? (
                      <div
                        ref={topSentinelRef}
                        data-testid="chat-transcript-top-sentinel"
                        aria-hidden="true"
                        className="pointer-events-none flex h-5 shrink-0 items-center justify-center"
                      >
                        <Loader2
                          className={cn(
                            "h-4 w-4 text-muted-strong opacity-60",
                            reduce ? "" : "animate-spin",
                          )}
                          aria-hidden="true"
                        />
                      </div>
                    ) : null}
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
                  </div>
                </motion.div>
                {sheetOpen && hasThread && !threadAtBottom ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={jumpToLatest}
                    aria-label="jump to latest message"
                    data-testid="chat-jump-to-latest"
                    className="absolute bottom-3 left-1/2 z-[3] flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-surface/95 px-3 text-xs font-medium text-txt shadow-lg transition-colors hover:bg-bg-hover"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    <span>Jump to latest</span>
                  </Button>
                ) : null}
              </motion.div>
            ) : null}
            {/* Cloud-agent provisioning status — rendered IN the chat, just
                above the composer, NOT as a home widget floating above the
                sheet. The widget consumes the same `useCloudHandoffPhase` event
                and self-hides entirely unless a dedicated cloud agent is booting
                (or a credit/retry state is live), so this is inert in the common
                case. Full chat-column width, styled to sit in the sheet. */}
            <AgentProvisioningWidget spanClassName="relative z-10 mx-auto w-full max-w-3xl shrink-0 px-3 pt-2" />
            {/* Reply target pill, just above the input (glass chrome). */}
            {chatReplyTarget ? (
              <div className="relative z-10 shrink-0 px-3 pt-2">
                <ChatReplyPill
                  appearance="glass"
                  target={chatReplyTarget}
                  onCancel={() => setChatReplyTarget(null)}
                />
              </div>
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
                          className="absolute -right-1.5 -top-1.5 z-30 grid h-5 w-5 place-items-center rounded-full border border-border-strong bg-scrim p-0 text-xs text-txt transition-colors before:absolute before:-inset-3 before:content-[''] hover:bg-bg"
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
                              className="h-14 w-14 rounded-lg border border-border-strong object-cover"
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
                          className="group relative flex h-14 min-w-[3.5rem] max-w-[10rem] shrink-0 items-center gap-2 rounded-lg border border-border-strong bg-surface px-2.5 text-txt"
                          title={img.name}
                        >
                          <KindIcon className="h-5 w-5 shrink-0 text-muted-strong" />
                          <span className="min-w-0 truncate text-xs-tight leading-tight">
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
                    className={cn(
                      "text-xs",
                      WALLPAPER_TEXT.danger,
                      WALLPAPER_FLOAT_SHADOW,
                    )}
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
            <motion.div
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
                // While INSET the composer dissolves into the sheet (one
                // continuous glass surface, #10710) — border/fill are morph-
                // driven inline (transparent at rest). At FULL-BLEED they fade
                // in to the resting input bar's own capsule chrome, so the
                // maximized chat's input reads exactly like the default
                // floating input. `border` reserves the hairline's layout.
                "border",
                // Always the transcript's centered column (a no-op at rest) so
                // the composer sits under the messages through the morph and at
                // full-bleed, never stretched edge-to-edge on a wide window.
                "mx-auto max-w-3xl",
              )}
              // Full-bleed has no overlay bottom padding (the panel is
              // edge-to-edge), so the composer carries the home-gesture
              // clearance itself — as a MARGIN below the capsule, eased in
              // with the shape morph (0 at rest). Skipped while the keyboard
              // is up, which already covers that zone. The bevel shadow is
              // discrete-on-commit (too subtle to morph); border/fill alphas
              // ride the morph.
              style={{
                borderRadius: PANEL_RADIUS_PX,
                borderColor: composerCapsuleBorder,
                backgroundColor: composerCapsuleBg,
                boxShadow: fullBleed ? LIQUID_GLASS_EDGE_SHADOW : undefined,
                width: composerCapsuleWidth,
                ...(keyboardLiftActive
                  ? {}
                  : { marginBottom: composerCapsuleMarginBottom }),
              }}
            >
              {/* Inline slash-command autocomplete, floating just above the
                    input row. */}
              {slashProp && !slashDismissed ? (
                <SlashCommandMenu
                  state={slashMenu}
                  loading={isSlashDraft && slash.loading}
                  error={isSlashDraft && slash.error}
                  onPick={pickSlashItem}
                />
              ) : null}
              {/* The "+" opens the chat-actions menu. Every item acts on THIS
                  in-app conversation only — they are surface-local affordances
                  (search this thread, attach to this turn, point the agent's
                  camera/transcription at this chat), never connector actions on a
                  Discord/Telegram room. Search + Transcribe + camera are things
                  the agent can also drive; Upload is a pure client affordance. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label="chat actions"
                    disabled={firstRunOpen}
                    data-testid="chat-composer-plus"
                    // Same 40px box / 20px mark / padded-back-to-44px hit zone
                    // as the SoftButton controls, so the row reads as one family.
                    className="relative grid h-10 w-10 shrink-0 place-items-center bg-transparent p-0 text-muted-strong transition-colors before:absolute before:-inset-0.5 before:content-[''] hover:bg-transparent hover:text-txt data-[state=open]:text-txt [&_svg]:size-5"
                  >
                    <Glyph d={PLUS_GLYPH} className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={10}
                  // Above the shell overlay (z 9000); mirrors the config-select
                  // floating layer so the menu never hides behind the glass.
                  style={{ zIndex: 12000 }}
                  // Unified liquid-glass menu chrome (glass/tokens.ts `menu`
                  // variant) instead of the flat opaque card.
                  glass
                  className="min-w-[13rem]"
                >
                  <DropdownMenuItem
                    className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                    onSelect={() => openSearch()}
                  >
                    <Search
                      className="h-4 w-4 shrink-0 text-muted"
                      aria-hidden
                    />
                    Search chat…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                    disabled={pendingImages.length >= MAX_CHAT_IMAGES}
                    onSelect={() => fileInputRef.current?.click()}
                  >
                    <Paperclip
                      className="h-4 w-4 shrink-0 text-muted"
                      aria-hidden
                    />
                    Upload file
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                    onSelect={() => send("Turn on the camera so you can see.")}
                  >
                    <Camera
                      className="h-4 w-4 shrink-0 text-muted"
                      aria-hidden
                    />
                    Enable camera
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                    onSelect={() => toggleTranscriptionMode()}
                  >
                    <Captions
                      className="h-4 w-4 shrink-0 text-muted"
                      aria-hidden
                    />
                    {transcriptionMode ? "Stop transcribing" : "Transcribe"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Textarea
                ref={inputRef}
                rows={1}
                value={draft}
                // Onboarding is sign-in-first: lock the composer until the user
                // signs in, so they can't type into a chat that isn't ready yet.
                disabled={firstRunOpen}
                onChange={(e) => {
                  const nextDraft = e.target.value;
                  if (
                    draft.trim().length > 0 &&
                    nextDraft.trim().length === 0
                  ) {
                    reportComposerActivity({
                      activity: "draft_abandoned",
                      surface: COMPOSER_ACTIVITY_SURFACE,
                      conversationId: activeConversationIdRef.current,
                      draftLength: 0,
                      reason: "cleared",
                    });
                  }
                  setDraft(nextDraft);
                  // Mirror the live draft to the active view (Help search etc.).
                  viewChatBinding?.onQuery?.(nextDraft);
                  if (nextDraft.trim().length > 0) expand();
                }}
                onFocus={() => {
                  // Widen out of the short-landscape compact affordance (#14173)
                  // on focus, before the first keystroke.
                  setComposerFocused(true);
                  // A pill-open focus only raises the keyboard; it must not
                  // expand a history thread (see suppressExpandOnFocusRef).
                  if (suppressExpandOnFocusRef.current) {
                    suppressExpandOnFocusRef.current = false;
                  } else {
                    expand();
                  }
                }}
                onBlur={() => setComposerFocused(false)}
                onPaste={handleComposerPaste}
                onKeyDown={handleComposerKeyDown}
                // The composer is LOCKED during onboarding: first-run is
                // sign-in-first, so the input is disabled (see `disabled` above)
                // until the user signs in.
                // (This surface's strings are plain literals by design — see
                // the imageError note above.)
                placeholder={
                  firstRunOpen
                    ? "Sign in to start chatting"
                    : noProviderConfigured
                      ? "Connect a model provider in Settings to chat"
                      : modelBlocksSend
                        ? modelStatus?.kind === "downloading"
                          ? `Downloading ${modelStatus.modelName ?? "your model"} — you can keep typing`
                          : `Getting ${modelStatus?.modelName ?? "your model"} ready — you can keep typing`
                        : booting
                          ? `Ask ${agentName} — waking up…`
                          : (viewChatBinding?.placeholder ?? `Ask ${agentName}`)
                }
                aria-label="message"
                data-testid="chat-composer-textarea"
                aria-describedby={
                  booting && !noProviderConfigured && !firstRunOpen
                    ? "cc-booting-hint"
                    : undefined
                }
                // Combobox semantics (role + aria-*) are applied as one spread,
                // and only when a slash catalog is wired in — a plain message
                // box otherwise.
                {...comboboxAria}
                // The floating composer is the primary chat affordance on the
                // ambient home surface, so its placeholder must stay readable
                // even when the glass pill sits over dark wallpaper. During
                // onboarding `disabled:opacity-100` prevents the browser from
                // dimming the locked cue.
                className="scrollbar-hide max-h-[8.5rem] min-h-8 min-w-0 flex-1 resize-none self-center border-none bg-transparent px-1.5 py-1 text-left text-sm leading-relaxed text-txt outline-none placeholder:text-muted-strong disabled:pointer-events-none disabled:opacity-100"
              />
              {booting && !noProviderConfigured && !firstRunOpen ? (
                <span id="cc-booting-hint" className="sr-only">
                  {agentName} is waking up — you can type now; your message
                  sends and the reply arrives in a moment.
                </span>
              ) : null}
              {/* Trailing controls. */}
              <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                {/* Transcription start/stop — ChatGPT-style dictation, always
                sitting next to the voice control (mic glyph = "transcribe my
                speech into the box"; the waveform next door is the spoken
                conversation). Tap to start; tap again (or say "exit
                transcription mode") to stop — the full transcript lands at the
                END of the draft and the recording attaches as a sharable audio
                artifact (see the transcript-session sink). The voice button
                stays the master control (a tap there ends transcription AND the
                mic); this one LEAVES THE MIC ON, matching
                toggleTranscriptionMode's off-path (#10699). Hidden when a
                send/stop control is showing (a draft or a streaming reply). */}
                {!((hasDraft || hasImages) && !recording) &&
                !(!recording && responding) ? (
                  <SoftButton
                    icon={Mic}
                    label={
                      transcriptionMode
                        ? "stop transcription"
                        : "start transcription"
                    }
                    disabled={firstRunOpen}
                    active={transcriptionMode}
                    pulse={transcriptionMode}
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
                      // Onboarding is sign-in-first; if a synthetic draft exists
                      // anyway, send stays locked with the rest of the composer.
                      disabled={firstRunOpen || !canSend}
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
                    // VOICE — the spoken-conversation control (waveform glyph;
                    // the mic glyph lives on the transcribe/dictate button
                    // beside it). Tap = hands-free conversation; hold =
                    // push-to-talk dictation; while transcribing a tap is the
                    // master off (ends transcription AND the mic).
                    <SoftButton
                      icon={AudioLines}
                      label={
                        pttHolding
                          ? // Press-and-hold dictates into the composer draft; a
                            // release drops the transcript into the text box and
                            // does NOT send (usePushToTalk onHoldEnd). Label the
                            // real behavior.
                            "release to insert"
                          : transcriptionMode
                            ? // Distinct from the transcribe button's "stop
                              // transcription" (which leaves the mic on): the
                              // voice control is the MASTER off — a tap ends
                              // transcription AND the mic — so a screen reader
                              // can tell the two adjacent controls apart.
                              "stop transcription and mic"
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
                      pulse={recording || handsFree || transcriptionMode}
                      onClick={handleMicClick}
                      onPointerDown={micHoldHandlers.onPointerDown}
                      onPointerUp={micHoldHandlers.onPointerUp}
                      onPointerCancel={micHoldHandlers.onPointerCancel}
                      onPointerLeave={micHoldHandlers.onPointerLeave}
                      testId="chat-composer-mic"
                    />
                  )}
                </div>
              </div>
            </motion.div>
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
              // The pill IS the whole chat while collapsed, so it alone pulses
              // for a live mic capture (`recording`) — the open-sheet grabber
              // deliberately does not (the composer glyphs carry that cue).
              glow={listening || responding || recording}
              pilled={pilled}
            />
          </motion.div>
        </motion.fieldset>
      </motion.div>
    </motion.div>
  );
}
