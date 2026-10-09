/** Composer activity, buttons, and accessible drag handles for the chat overlay. */

import {
  AnimatePresence,
  type MotionValue,
  motion,
  useIsPresent,
} from "motion/react";
import * as React from "react";
import { type OrbState, ThinkingOrb } from "thinking-orbs";
import { cn } from "../../utils/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Separator } from "../ui/separator";
import { OVERLAY_EASE } from "./chat-overlay-motion";
import {
  CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
  CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
} from "./chat-overlay-window-bounds";
import type { PullGestureBinding } from "./use-pull-gesture";
import type { ShellController } from "./useShellController";

export function Glyph({
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
export function SoftButton({
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
  pressed,
  pulse,
  testId,
}: {
  /** A hand-drawn SVG path glyph (legacy), OR pass `icon` for a lucide icon. */
  glyph?: string;
  icon?: React.ComponentType<{
    className?: string;
    "aria-hidden"?: boolean;
  }>;
  label: string;
  onClick?: () => void;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  /** Accessible toggle state when it is intentionally broader than the accent state. */
  pressed?: boolean;
  /** Breathe the glyph while a batch capture has no richer activity surface. */
  pulse?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <Button
      variant="transparent"
      size="icon"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed ?? active}
      data-state={active ? "on" : "off"}
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
        // resting → white active — never a background/border or status color.
        //
        // The icon size keeps the visible desktop box quiet at 40px and lets the
        // shared Button primitive raise the real element to 44px on coarse
        // pointers. Real target geometry avoids overlapping pseudo hit areas
        // when compact screens draw the two trailing controls closer together.
        "relative grid shrink-0 place-items-center [&_svg]:size-5",
        "text-muted-strong hover:text-txt data-[state=on]:text-inverse data-[state=on]:hover:text-inverse aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40",
        // Batch capture has no inline waveform, so its glyph breathes; realtime
        // voice keeps this control static because the composer owns the motion.
        pulse && "animate-pulse motion-reduce:animate-none",
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

function ComposerControlTransition({
  children,
  controlKey,
  reduceMotion,
}: {
  children: React.ReactNode;
  controlKey: string;
  reduceMotion: boolean;
}): React.JSX.Element {
  const present = useIsPresent();
  return (
    <motion.div
      data-composer-control={controlKey}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.16,
        ease: OVERLAY_EASE,
      }}
      className="absolute inset-0 grid place-items-center"
      style={{ pointerEvents: present ? "auto" : "none" }}
    >
      {children}
    </motion.div>
  );
}

export function ComposerControlSlot({
  children,
  controlKey,
  reduceMotion,
  slot,
}: {
  children: React.ReactNode;
  controlKey: string | null;
  reduceMotion: boolean;
  slot: "left" | "right";
}): React.JSX.Element {
  return (
    <div
      data-testid={`chat-composer-control-slot-${slot}`}
      className="relative size-10 shrink-0 pointer-coarse:size-11"
    >
      <AnimatePresence initial={false}>
        {controlKey ? (
          <ComposerControlTransition
            key={controlKey}
            controlKey={controlKey}
            reduceMotion={reduceMotion}
          >
            {children}
          </ComposerControlTransition>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const COMPOSER_MIC_BARS = [
  { id: "outer-left", height: 10 },
  { id: "far-left", height: 13 },
  { id: "mid-far-left", height: 17 },
  { id: "mid-left", height: 16 },
  { id: "near-left", height: 21 },
  { id: "inner-left", height: 22 },
  { id: "center-left", height: 26 },
  { id: "center", height: 28 },
  { id: "center-right", height: 26 },
  { id: "inner-right", height: 22 },
  { id: "near-right", height: 21 },
  { id: "mid-right", height: 16 },
  { id: "mid-far-right", height: 17 },
  { id: "far-right", height: 13 },
  { id: "outer-right", height: 10 },
] as const;

// Audio-frame writes stay imperative so live microphone activity never
// rerenders the chat tree while transcription owns the composer's text lane.
export function ComposerMicActivity({
  analyser,
  finishing,
  reduceMotion,
  transcript,
}: {
  analyser: AnalyserNode | null;
  finishing: boolean;
  reduceMotion: boolean;
  transcript: string;
}): React.JSX.Element {
  const barsRef = React.useRef<Array<HTMLSpanElement | null>>([]);
  React.useEffect(() => {
    if (!analyser || finishing || reduceMotion) return;
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const renderFrame = () => {
      analyser.getByteTimeDomainData(samples);
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const segmentStart = Math.floor(
          (index * samples.length) / COMPOSER_MIC_BARS.length,
        );
        const segmentEnd = Math.max(
          segmentStart + 1,
          Math.floor(((index + 1) * samples.length) / COMPOSER_MIC_BARS.length),
        );
        let energy = 0;
        for (
          let sampleIndex = segmentStart;
          sampleIndex < segmentEnd;
          sampleIndex += 1
        ) {
          const normalized = ((samples[sampleIndex] ?? 128) - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / (segmentEnd - segmentStart));
        const activity = Math.min(1, Math.max(0.16, rms * 5.5));
        const center = (COMPOSER_MIC_BARS.length - 1) / 2;
        const centerWeight = 1 - Math.abs(index - center) * 0.035;
        bar.style.transform = `scaleY(${Math.max(0.18, activity * centerWeight)})`;
      });
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [analyser, finishing, reduceMotion]);
  return (
    <div
      role="status"
      aria-label={
        finishing ? "Finishing transcription" : "Live microphone activity"
      }
      data-testid="chat-composer-mic-activity"
      className="relative flex min-h-10 min-w-0 flex-1 items-center justify-between gap-1 px-2 text-white/85"
    >
      <span className="sr-only" aria-live="polite">
        {finishing
          ? "Finishing transcription"
          : transcript.trim() || "Listening"}
      </span>
      <Separator
        aria-hidden="true"
        tone="subtle40"
        className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2"
      />
      {COMPOSER_MIC_BARS.map(({ id, height }, index) => (
        <span
          key={id}
          // Stable bar ids keep imperative analyser writes independent of React.
          ref={(node) => {
            barsRef.current[index] = node;
          }}
          aria-hidden="true"
          className={cn(
            "relative z-10 w-0.5 origin-center rounded-full bg-current transition-transform duration-75 sm:w-1",
            !finishing &&
              !analyser &&
              "animate-pulse motion-reduce:animate-none",
          )}
          style={{ height, transform: "scaleY(0.32)" }}
        />
      ))}
    </div>
  );
}

type RealtimeVoiceStatus = NonNullable<
  ShellController["realtimeVoice"]
>["status"];

const REALTIME_COMPOSER_LABEL: Record<RealtimeVoiceStatus, string> = {
  idle: "Voice is live",
  listening: "Listening…",
  transcribing: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking · mic paused",
  interrupting: "Stopping…",
};

type RealtimeVoiceVisualPhase =
  | RealtimeVoiceStatus
  | "connecting"
  | "paused"
  | "error";

const REALTIME_VOICE_ORB: Record<
  RealtimeVoiceVisualPhase,
  {
    state: OrbState;
    speed: number;
    paused?: boolean;
  }
> = {
  idle: { state: "breathing", speed: 0.72 },
  connecting: { state: "connecting", speed: 1 },
  listening: { state: "listening", speed: 1 },
  transcribing: { state: "listening", speed: 0.82 },
  thinking: { state: "working", speed: 0.92 },
  speaking: { state: "composing", speed: 1.08 },
  interrupting: { state: "shaping", speed: 1.18 },
  paused: { state: "breathing", speed: 0, paused: true },
  error: { state: "breathing", speed: 0, paused: true },
};

/** A fixed-size orb gives every realtime phase distinct motion without moving the composer. */
function ComposerRealtimeVoiceWaveform({
  phase,
  reduceMotion,
}: {
  phase: RealtimeVoiceVisualPhase;
  reduceMotion: boolean;
}): React.JSX.Element {
  const visual = REALTIME_VOICE_ORB[phase];
  const paused = reduceMotion || visual.paused === true;
  return (
    <span
      aria-hidden="true"
      data-phase={phase}
      data-orb-state={visual.state}
      data-testid="chat-composer-realtime-waveform"
      className={cn(
        "flex h-5 w-6 shrink-0 items-center justify-center",
        phase === "error" ? "opacity-60" : "opacity-90",
      )}
    >
      <ThinkingOrb
        aria-hidden="true"
        data-testid="chat-composer-thinking-orb"
        state={visual.state}
        size={20}
        speed={paused ? 0 : visual.speed}
        paused={paused}
        theme="dark"
      />
    </span>
  );
}

/** Realtime voice occupies the composer's normal text lane, never a second card. */
export function ComposerRealtimeVoiceActivity({
  connecting,
  error,
  needsAudioUnlock,
  onUnlockAudio,
  paused,
  microphoneMuted,
  reduceMotion,
  status,
}: {
  connecting: boolean;
  error: string | null;
  needsAudioUnlock: boolean;
  onUnlockAudio: () => void;
  paused: boolean;
  microphoneMuted: boolean;
  reduceMotion: boolean;
  status: RealtimeVoiceStatus;
}): React.JSX.Element {
  const phaseLabel = error
    ? error
    : paused
      ? "Voice paused"
      : connecting
        ? "Connecting…"
        : microphoneMuted &&
            (status === "listening" || status === "transcribing")
          ? "Microphone muted"
          : REALTIME_COMPOSER_LABEL[status];
  const visualPhase: RealtimeVoiceVisualPhase = error
    ? "error"
    : paused ||
        (microphoneMuted &&
          (status === "listening" || status === "transcribing"))
      ? "paused"
      : connecting
        ? "connecting"
        : status;
  const shimmerPhase =
    !error &&
    !paused &&
    (connecting ||
      status === "transcribing" ||
      status === "thinking" ||
      status === "speaking");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={phaseLabel}
      data-status={status}
      data-testid="chat-composer-realtime-voice"
      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-1.5"
    >
      <ComposerRealtimeVoiceWaveform
        phase={visualPhase}
        reduceMotion={reduceMotion}
      />
      <div className="flex h-10 min-w-0 flex-1 items-center overflow-hidden">
        <span
          data-testid="chat-composer-realtime-copy"
          className={cn(
            "block max-h-10 w-full min-w-0 overflow-hidden whitespace-pre-wrap text-start text-sm leading-5 [overflow-wrap:anywhere]",
            error ? "text-danger" : "text-white/75",
            shimmerPhase &&
              "shimmer shimmer-duration-1200 motion-reduce:shimmer-none",
          )}
          title={phaseLabel}
        >
          {phaseLabel}
        </span>
      </div>
      {needsAudioUnlock ? (
        <Button
          variant="warningOutline"
          size="tiny"
          onClick={onUnlockAudio}
          data-testid="chat-composer-voice-audio-unlock"
          shape="circle"
          className="shrink-0"
        >
          Enable sound
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The drag handle at the top of the chat sheet — pull UP to open the history,
 * pull DOWN to close it. It is also keyboard-operable (Enter/Space toggles,
 * ArrowUp opens, ArrowDown/Escape closes) so the drag-only affordance stays
 * WCAG 2.1.1 operable. `touch-none` keeps the browser from scroll/refreshing
 * mid-drag. A subtle white breath marks live agent work.
 */
export function SheetGrabber({
  open,
  onOpen,
  onClose,
  binding,
  breathing,
  opacity,
  pilled,
  locked = false,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  binding: PullGestureBinding;
  breathing: boolean;
  // Crossfade opacity (driven by openProgress): 0 while the pill capsule owns the
  // handle, fading to 1 only AFTER the pill has fully faded out — so the grabber
  // bar and the (identical) pill bar are NEVER both visible (the "two pills" bug).
  opacity: MotionValue<number>;
  // Inert while pilled so the invisible grabber can't steal taps meant for the
  // pill capsule (or pass-through to the home screen) below it.
  pilled: boolean;
  /** Keeps the normal handle visible while onboarding owns the detent. */
  locked?: boolean;
}): React.JSX.Element {
  const disabled = pilled || locked;
  return (
    <Button asChild variant="chatGestureTarget" size="content">
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
        aria-disabled={locked || undefined}
        aria-label={open ? "drag down to close chat" : "drag up to open chat"}
        data-testid="chat-sheet-grabber"
        data-open={open ? "true" : "false"}
        onClick={(event) => {
          // Assistive activation has no pointer sequence. Pointer taps already
          // toggle through the gesture binding and must not be replayed here.
          if (disabled || event.detail !== 0) return;
          if (open) onClose();
          else onOpen();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
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
        // Opening the sheet moves this handle before Chromium emits the touch
        // gesture's compatibility click. Without suppressing that native follow-
        // up, the click re-hit-tests onto the composer now underneath the release
        // coordinate and focuses it; the next handle tap then dismisses the
        // keyboard instead of closing the sheet. Pointer events remain the sole
        // touch authority, matching PillHandle's moving-target contract below.
        onTouchEnd={(e) => {
          if (e.cancelable) e.preventDefault();
        }}
        {...binding}
        onPointerDown={(event) => {
          // This handle is a complete gesture owner. In the shell it can sit over
          // a broad home/notification pull surface, whose native listener runs
          // independently of React; do not let this press seed both systems.
          event.stopPropagation();
          binding.onPointerDown(event);
        }}
        className={cn(
          "appearance-none text-left",
          // ABSOLUTELY positioned over the panel top (zero layout height — it
          // floats slightly on top of the input row, so collapsed height == the
          // input bar). The grab target is WIDE (a swipe-up from anywhere across
          // the composer's top edge opens the chat — the lock-screen "swipe up to
          // open" affordance) but STAYS ABOVE the input row so it never steals
          // taps meant for the textarea / +/mic controls below it.
          // z-20 keeps it above the input row (z-10) so it always wins the drag.
          "absolute top-0.5 z-20 flex cursor-grab touch-none select-none items-center justify-center py-2 active:cursor-grabbing",
          // In input mode, reserve a real gutter over BOTH edge controls. The
          // prior full-width band began inside the + button and immediately to
          // its right, so a tiny miss opened/flung the sheet instead of opening
          // chat actions. Once the sheet is open, those controls are far below
          // this top handle and the generous full-width drag lane is safe again.
          open ? "inset-x-6" : "inset-x-[4.5rem]",
          // The invisible hit target reaches a comfortable distance ABOVE the
          // panel (a swipe-up begun in the empty field just over the composer is
          // caught) and STOPS at the handle's own bottom, so it never overlaps the
          // interactive composer row beneath — taps fall through to the input.
          "before:absolute before:-inset-x-2 before:-top-6 before:bottom-0 before:content-['']",
        )}
      >
        <Card
          asChild
          surface="transparent"
          border="none"
          radius="full"
          overlayHandle
        >
          <span
            aria-hidden="true"
            className={cn(
              // The visible grabber line. Its show/hide is driven by the WRAPPER's
              // `grabberOpacity` crossfade (fades in over [0.55, 0.95] of the open),
              // strictly anti-phase with the pill bar so the two are never on screen
              // together. The bar paints at full opacity — a prior regression pinned
              // it to `opacity-0`, leaving the handle grabbable but invisible (#9142).
              "opacity-100 transition-all duration-300",
              // CLOSED (input mode): same h-1.5 w-12 bar as the pill capsule — the
              // two crossfade and must be pixel-identical. OPEN sheet: a quieter,
              // smaller bar (the full-size handle over the transcript read as
              // oversized chrome).
              open ? "h-1 w-9" : "h-1.5 w-12",
              // A dedicated opacity/scale breath marks live agent work without
              // repurposing shadcn's text-only shimmer utility.
              breathing && "eliza-chat-handle-breathe",
            )}
          />
        </Card>
      </motion.button>
    </Button>
  );
}

/**
 * The fully-collapsed PILL — the chat reduced to a small glass capsule at the
 * very bottom. Tap or flick/pull it up to bring the input back. Big invisible
 * hit area so it's easy to grab; the visible capsule stays small.
 */
export function PillHandle({
  binding,
  counterScale,
  onOpen,
  breathing,
  pilled,
  desktopOverlayHost = false,
}: {
  binding: PullGestureBinding;
  // Inverse of the panel's pill-morph scale (see pillHandleCounterScale),
  // applied to the visible BAR only — the button/hit geometry keeps riding the
  // panel scale (the touch-compat mousedown after a tap must keep landing where
  // it always did), while the painted bar stays pixel-identical to the
  // input-mode grabber bar across the whole morph.
  counterScale: MotionValue<number>;
  onOpen: () => void;
  breathing: boolean;
  // Interactive ONLY while pilled. The handle's hit zone (`px-16 pt-10`) is tall
  // and wide and sits directly over the composer textarea; if it kept
  // `pointer-events-auto` while NOT pilled it would intercept the tap meant for
  // the input (the parent's `pointer-events:none` can't override a child that
  // opts back in), so the keyboard would never open. Gate on `pilled` so taps
  // pass through to the textarea once the input has formed.
  pilled: boolean;
  desktopOverlayHost?: boolean;
}): React.JSX.Element {
  if (desktopOverlayHost) {
    return (
      <motion.div
        className="h-1.5 w-12 origin-bottom"
        style={{
          scale: counterScale,
          transformOrigin: "center",
          width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
          height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
        }}
      >
        <Button
          variant="transparent"
          size="content"
          shape="circle"
          data-testid="chat-pill"
          aria-label="open chat"
          style={{
            width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
            height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === " " ||
              event.key === "ArrowUp"
            ) {
              event.preventDefault();
              onOpen();
            }
          }}
          onTouchEnd={(event) => {
            if (event.cancelable) event.preventDefault();
          }}
          {...binding}
          tabIndex={pilled ? 0 : -1}
          aria-hidden={pilled ? undefined : true}
          className={cn(
            "shrink-0 cursor-grab touch-none select-none active:scale-95 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inverse/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
            pilled ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <Card
            asChild
            surface="transparent"
            border="none"
            radius="full"
            overlayHandle
          >
            <span
              aria-hidden="true"
              data-testid="chat-pill-mark"
              className={cn(
                "pointer-events-none h-3 w-16 opacity-100",
                breathing && "eliza-chat-handle-breathe",
              )}
            />
          </Card>
        </Button>
      </motion.div>
    );
  }
  return (
    <Button
      variant="chatGestureTarget"
      size="content"
      data-testid="chat-pill"
      aria-label="open chat"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
          e.preventDefault();
          onOpen();
        }
      }}
      // A touch tap opens the INPUT bar in the pointerup that precedes this
      // touchend — by the time the browser dispatches its compat mouse events
      // (mousedown/click), the composer textarea has already formed under the
      // same coordinates, and the synthetic click would focus it and pop the
      // keyboard the pill tap deliberately leaves down. preventDefault() on
      // touchend suppresses the compat sequence; the gesture itself runs on
      // pointer events and is unaffected. Unconditional: a touchend only
      // reaches this handle when the touch STARTED on it (touch events retarget
      // to their touchstart element), i.e. while it was the pilled handle —
      // the render that formed the input has already flipped `pilled` false by
      // the time this fires, so the prop cannot gate it.
      onTouchEnd={(event) => {
        if (event.cancelable) event.preventDefault();
      }}
      {...binding}
      tabIndex={pilled ? undefined : -1}
      aria-hidden={pilled ? undefined : true}
      className={cn(
        "h-auto w-full px-8 pb-1.5 pt-10",
        // The bar hugs the BOTTOM (small pb) where the collapsed input sat — not
        // floating mid-air; the tall pt + full width keep a generous upward grab/
        // flick zone so a swipe-up from anywhere across the bottom opens the chat
        // (the lock-screen affordance). Flex-center keeps the capsule centred
        // while the invisible hit area spans wide.
        "flex cursor-grab touch-none select-none items-end justify-center active:cursor-grabbing",
        // Interactive only while pilled. When NOT pilled the (faded) handle must
        // let taps fall through to the composer textarea below it — otherwise its
        // tall hit zone steals the tap and the keyboard never opens.
        pilled ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <Card
        asChild
        surface="transparent"
        border="none"
        radius="full"
        overlayHandle
        layoutStyle={{ transformOrigin: "bottom center" }}
      >
        <motion.span
          aria-hidden="true"
          className={cn(
            // Identical to the SheetGrabber's closed-state bar — same white shape
            // + color whether the chat is open or collapsed to the pill. Its
            // show/hide is driven by the WRAPPER's `pillOpacity` crossfade
            // (anti-phase with the grabber). The bar paints at full opacity — a
            // prior regression pinned it to `opacity-0`, leaving the pill handle
            // grabbable but invisible (#9142).
            "h-1.5 w-12 opacity-100 transition-colors duration-300",
            // Same compositor-only work-state breath as the SheetGrabber bar.
            breathing && "eliza-chat-handle-breathe",
          )}
          // The shared handle surface keeps both bars pixel-identical through the
          // crossfade. The counter-scale cancels
          // the panel's pill-morph shrink for the BAR alone, so the collapsed
          // handle renders the same size as the input-mode grabber bar.
          style={{
            scale: counterScale,
          }}
        />
      </Card>
    </Button>
  );
}
