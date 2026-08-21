/**
 * Renders the compact home pill that anchors launcher access, current shell
 * status, and the hold-to-talk quasimode (#20483).
 *
 * The pill carries two gestures on one target: a quick press (released inside
 * {@link HOLD_THRESHOLD_MS}) toggles the assistant overlay, and a sustained
 * hold becomes push-to-talk — capture starts at the threshold, runs while the
 * pointer stays down, and the release sends the utterance. The hold is a
 * quasimode in Raskin's sense: the pressed pointer IS the state, so there is
 * nothing for the user to remember or un-stick. Cancel affordances: Escape
 * mid-hold, or sliding the pointer more than {@link SLIDE_CANCEL_PX} off the
 * pill before releasing.
 *
 * On a cloud-only build the `needs-auth` phase keeps the same neutral resting
 * affordance; activating it launches Cloud sign-in. Hold is not armed there.
 */

import { AudioWaveform, Plus, Square } from "lucide-react";
import { useReducedMotion } from "motion/react";
import * as React from "react";

import { useBranding } from "../../config/branding";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { computeWaveBarScales, FLATLINE_SCALE } from "./home-pill-wave";
import type { ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
  /** Whether the chat overlay is actually open. Voice activity can enter
   *  `responding` while the pill remains closed, so phase cannot own this. */
  open?: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Begin hold-to-talk capture (wired to `startRecording("ptt")`). When
   *  absent the pill is click-only, preserving the pre-quasimode behavior for
   *  hosts that have no capture pipeline. */
  onHoldStart?: () => void;
  /** Release hold-to-talk: stop capture and send the utterance. */
  onHoldEnd?: () => void;
  /** Abandon hold-to-talk without sending (Esc mid-hold, slide-off). */
  onHoldCancel?: () => void;
  /** Live capture analyser while recording (`controller.analyser`). When
   *  present, the listening chip's bars are metered from real microphone
   *  energy — a flat line means the mic is dead, the honest failure signal.
   *  Absent (mic still opening, or host without capture), the bars fall back
   *  to the decorative CSS shimmer. */
  analyser?: AnalyserNode | null;
  /** True while the assistant reply is being spoken aloud. Sharpens the
   *  responding glow so "speaking" and "thinking" read differently. */
  speaking?: boolean;
  /** True while Cloud sign-in is in flight from this pill. Pulses the
   *  `needs-auth` chip so the wait is visible. */
  signingIn?: boolean;
  /** Reports the idle pill's shallow composer-preview hover state. Desktop
   *  uses this to widen the transparent native hit area before painting it. */
  onPreviewHoverChange?: (hovered: boolean) => void;
  /** True once the native host has acknowledged its wider shallow frame. Hover
   *  and listening lanes stay compact until then so WKWebView cannot clip them
   *  into the resting 96px window. Web callers leave this unset. */
  previewHostReady?: boolean;
  /** Whether hovering may render HomePill's lightweight visual preview. Hosts
   *  that mount the real ChatOverlay input detent must disable this duplicate. */
  showComposerPreview?: boolean;
}

/** How long the pointer must stay down before a press becomes a hold. Above
 *  a natural click's duration, below perceptible lag — the disambiguation
 *  window between the pill's two gestures. */
export const HOLD_THRESHOLD_MS = 150;

/** Pointer travel from the press point that turns a release into a cancel —
 *  the iOS "slide off to cancel" convention. */
export const SLIDE_CANCEL_PX = 44;

/** Listening-state waveform bars: nine bars with center-weighted, symmetric
 *  stagger delays so the chip reads as a live waveform (shimmering from the
 *  middle out) rather than a marching sequence — mirroring the density of the
 *  studied Wispr Flow bar. Ids are stable keys; delays repeat symmetrically. */
const WAVE_BARS = [
  { id: "l7", delayMs: 420, height: 10 },
  { id: "l6", delayMs: 320, height: 13 },
  { id: "l5", delayMs: 240, height: 17 },
  { id: "l4", delayMs: 180, height: 16 },
  { id: "l3", delayMs: 120, height: 21 },
  { id: "l2", delayMs: 80, height: 22 },
  { id: "l1", delayMs: 40, height: 26 },
  { id: "c0", delayMs: 0, height: 28 },
  { id: "r1", delayMs: 40, height: 26 },
  { id: "r2", delayMs: 80, height: 22 },
  { id: "r3", delayMs: 120, height: 21 },
  { id: "r4", delayMs: 180, height: 16 },
  { id: "r5", delayMs: 240, height: 17 },
  { id: "r6", delayMs: 320, height: 13 },
  { id: "r7", delayMs: 420, height: 10 },
] as const;

/** Processing-state dots: the mic closed but transcription is in flight —
 *  three dots breathing left-to-right, the universal "working on it". */
const PROCESS_DOTS = [
  { id: "d0", delayMs: 0 },
  { id: "d1", delayMs: 160 },
  { id: "d2", delayMs: 320 },
] as const;

/**
 * Persistent Flow-style handle at the bottom-center of the viewport.
 *
 * The visible affordance is deliberately only a short capsule; the larger
 * transparent button preserves a comfortable pointer target. Status is exposed
 * through ARIA instead of permanent text so the launcher stays out of the
 * user's way until it is invoked.
 *
 * Each shell phase reads distinctly at a glance (the capsule is the only
 * always-visible surface, so it carries all ambient status):
 *   booting     — dim pulsing handle ("waking up").
 *   needs-auth  — same neutral handle and hover preview as idle.
 *   idle        — solid white handle ("here, ready").
 *   listening   — dark chip, live waveform bars ("mic is hot").
 *   processing  — dark chip, pulsing dots — mic closed,
 *                 transcription in flight ("heard you, working on it").
 *   responding  — warm accent glow; `speaking` sharpens it while the reply
 *                 is audibly playing (thinking vs speaking read differently).
 * Reduced-motion users get the static color/glow treatments without the
 * animations.
 */
export function HomePill({
  phase,
  open,
  onOpen,
  onClose,
  onHoldStart,
  onHoldEnd,
  onHoldCancel,
  analyser = null,
  speaking = false,
  signingIn = false,
  onPreviewHoverChange,
  previewHostReady = true,
  showComposerPreview = true,
}: HomePillProps): React.JSX.Element {
  const { appName } = useBranding();
  const needsAuth = phase === "needs-auth";
  // Hosts with a controller must pass its real overlay state. The phase-only
  // fallback preserves standalone stories and consumers, but cannot distinguish
  // a closed-pill voice response from a response inside an open chat.
  const isOpen = open ?? (phase === "summoned" || phase === "responding");
  const previewEligible =
    showComposerPreview && (phase === "idle" || needsAuth);
  const [previewHovered, setPreviewHovered] = React.useState(false);

  const setPreviewHover = React.useCallback(
    (hovered: boolean) => {
      const next = previewEligible && hovered;
      setPreviewHovered(next);
      onPreviewHoverChange?.(next);
    },
    [onPreviewHoverChange, previewEligible],
  );

  React.useEffect(() => {
    if (previewEligible || !previewHovered) return;
    setPreviewHovered(false);
    onPreviewHoverChange?.(false);
  }, [onPreviewHoverChange, previewEligible, previewHovered]);

  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActiveRef = React.useRef(false);
  const pressPointRef = React.useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = React.useRef(false);
  const onHoldStartRef = React.useRef(onHoldStart);
  const onHoldEndRef = React.useRef(onHoldEnd);
  const onHoldCancelRef = React.useRef(onHoldCancel);
  onHoldStartRef.current = onHoldStart;
  onHoldEndRef.current = onHoldEnd;
  onHoldCancelRef.current = onHoldCancel;

  const clearHoldTimer = React.useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (needsAuth) return;
      if (!onHoldStartRef.current) return;
      // Primary button/touch only; a right-click must not open the mic.
      if (event.pointerType === "mouse" && event.button !== 0) return;
      pressPointRef.current = { x: event.clientX, y: event.clientY };
      suppressClickRef.current = false;
      // Keep receiving pointer events after the pointer leaves the button so
      // slide-off distance and the eventual release are still observed.
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /* capture is an enhancement; envs without active pointers (jsdom)
           still get down/up on the button itself */
      }
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        holdActiveRef.current = true;
        // The release (or cancel) must not ALSO fire the click toggle — the
        // hold consumed this press.
        suppressClickRef.current = true;
        onHoldStartRef.current?.();
      }, HOLD_THRESHOLD_MS);
    },
    [clearHoldTimer, needsAuth],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      clearHoldTimer();
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      const origin = pressPointRef.current;
      pressPointRef.current = null;
      const dx = origin ? event.clientX - origin.x : 0;
      const dy = origin ? event.clientY - origin.y : 0;
      if (Math.hypot(dx, dy) > SLIDE_CANCEL_PX) {
        onHoldCancelRef.current?.();
        return;
      }
      onHoldEndRef.current?.();
    },
    [clearHoldTimer],
  );

  const handlePointerCancel = React.useCallback(() => {
    clearHoldTimer();
    pressPointRef.current = null;
    if (!holdActiveRef.current) return;
    holdActiveRef.current = false;
    onHoldCancelRef.current?.();
  }, [clearHoldTimer]);

  // Escape aborts an in-flight hold without sending. Bound only while a hold
  // could be active so the pill never shadows the overlay's own Escape.
  React.useEffect(() => {
    if (phase !== "listening") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      clearHoldTimer();
      pressPointRef.current = null;
      onHoldCancelRef.current?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [phase, clearHoldTimer]);

  React.useEffect(() => clearHoldTimer, [clearHoldTimer]);

  const handleClick = React.useCallback(() => {
    // A completed hold already consumed this press-release pair.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onOpen, onClose]);

  const signInLabel = `Sign in with ${appName} Cloud`;
  const previewVisible = previewHovered && previewHostReady;
  const listening = phase === "listening";
  const reduceMotion = useReducedMotion() ?? false;
  // Bars go live only when real audio frames exist to drive them; reduced
  // motion keeps the static treatment (no rAF, no CSS shimmer).
  const metered = listening && analyser !== null && !reduceMotion;
  const waveBarRefs = React.useRef<Array<HTMLSpanElement | null>>([]);

  // Audio-frame writes stay imperative (direct style.transform) so live mic
  // activity never rerenders the pill while a hold is in flight.
  React.useEffect(() => {
    if (!metered || !analyser) return undefined;
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const renderFrame = () => {
      analyser.getByteTimeDomainData(samples);
      const scales = computeWaveBarScales(samples, WAVE_BARS.length);
      waveBarRefs.current.forEach((bar, index) => {
        if (!bar) return;
        bar.style.transform = `scaleY(${scales[index] ?? FLATLINE_SCALE})`;
      });
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);
    return () => {
      window.cancelAnimationFrame(frame);
      // Leave no stale live transform behind for the next (decorative) pass.
      waveBarRefs.current.forEach((bar) => {
        if (bar) bar.style.transform = "";
      });
    };
  }, [metered, analyser]);
  const listeningExpanded = listening && previewHostReady;
  const chipExpanded = listening || phase === "processing";
  const composerSized = previewVisible || listeningExpanded;
  const label = needsAuth
    ? signingIn
      ? `Signing in to ${appName} Cloud`
      : signInLabel
    : phase === "listening"
      ? `${appName} is listening — release to send`
      : phase === "processing"
        ? `${appName} is transcribing your words`
        : speaking
          ? `${appName} is speaking`
          : isOpen
            ? `Close ${appName}`
            : `Open ${appName}`;

  return (
    <Button
      variant="ghost"
      aria-label={label}
      aria-busy={needsAuth && signingIn ? true : undefined}
      aria-pressed={needsAuth ? undefined : isOpen}
      data-phase={phase}
      data-speaking={speaking || undefined}
      data-testid="shell-home-pill"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onMouseEnter={() => setPreviewHover(true)}
      onMouseLeave={() => setPreviewHover(false)}
      // A foreground NSWindow owns wheel routing before CSS hit-testing. Drop
      // the wide hover host on the first scroll gesture so subsequent trackpad
      // momentum reaches the application underneath instead of being trapped
      // by a decorative preview.
      onWheel={() => setPreviewHover(false)}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={cn(
        "group pointer-events-auto relative mb-2 flex items-center justify-center rounded-full bg-transparent p-0",
        composerSized ? "h-16 w-[36rem]" : "h-8 w-16",
        "transition-[width,height,transform] duration-200 hover:bg-transparent motion-reduce:transition-none",
        needsAuth ? "active:scale-[0.96]" : "active:scale-95",
        "focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="shell-home-pill-mark"
        className={cn(
          "flex items-center justify-center rounded-full",
          "transition-[width,height,opacity,transform,background-color,box-shadow] duration-200",
          // Listening/processing grow the capsule into a dark status chip.
          // Logged-out and idle states share the neutral handle/hover preview.
          previewVisible
            ? "h-14 w-full justify-start overflow-hidden border border-white/55 bg-[linear-gradient(180deg,rgba(38,39,40,0.98),rgba(18,19,21,0.98))] px-5"
            : listeningExpanded
              ? "h-14 w-full justify-between overflow-hidden border border-white/55 bg-neutral-900/95 px-5"
              : chipExpanded
                ? "h-7 w-20 gap-[3px] bg-neutral-900/95"
                : "h-2.5 w-12 gap-[3px] bg-white/95 group-hover:w-14",
          previewVisible
            ? "shadow-[0_14px_36px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.12)]"
            : chipExpanded && "shadow-[0_4px_16px_rgba(0,0,0,0.35)]",
          !chipExpanded &&
            !previewVisible &&
            (phase === "responding"
              ? speaking
                ? // Speaking: stronger, tighter warm glow than thinking — the
                  // reply is audibly playing right now.
                  "shadow-[0_0_14px_rgba(255,138,42,0.85),0_0_0_1px_rgba(255,138,42,0.5)]"
                : "shadow-[0_0_10px_rgba(255,138,42,0.6),0_0_0_1px_rgba(0,0,0,0.12)]"
              : "shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"),
          phase === "booting" &&
            "animate-pulse opacity-65 motion-reduce:animate-none",
          phase === "responding" &&
            !speaking &&
            "animate-pulse opacity-90 motion-reduce:animate-none",
        )}
      >
        {previewVisible && (
          <>
            <Plus
              aria-hidden="true"
              data-testid="shell-home-pill-preview-plus"
              className="size-5 shrink-0 text-white"
              strokeWidth={2}
            />
            <span
              data-testid="shell-home-pill-preview-label"
              className="ml-5 whitespace-nowrap text-sm font-normal leading-none text-white/85"
            >
              Message {appName}
            </span>
            <span className="absolute inset-x-0 top-4 flex justify-center">
              <span className="h-2 w-12 rounded-full bg-white/95" />
            </span>
            <AudioWaveform
              aria-hidden="true"
              data-testid="shell-home-pill-preview-waveform"
              className="ml-auto size-5 shrink-0 text-white"
              strokeWidth={2}
            />
          </>
        )}
        {phase === "listening" ? (
          <>
            <span className="w-5 shrink-0" aria-hidden="true" />
            <span className="flex flex-1 items-center justify-center gap-2 px-6">
              {WAVE_BARS.map((bar, index) => (
                <span
                  key={bar.id}
                  ref={(node) => {
                    waveBarRefs.current[index] = node;
                  }}
                  data-testid="shell-home-pill-wave-bar"
                  data-live={metered || undefined}
                  className={cn(
                    "w-1 origin-center rounded-full bg-white/95 shadow-[0_0_9px_rgba(255,255,255,0.4)]",
                    metered
                      ? // Live-metered: the analyser drives scaleY each frame;
                        // in silence the bars flatline — the honest dead-mic
                        // signal — so no decorative shimmer may run.
                        "transition-transform duration-75"
                      : "home-pill-wave-bar motion-reduce:animate-none",
                  )}
                  style={{
                    animationDelay: metered ? undefined : `${bar.delayMs}ms`,
                    height: `${bar.height}px`,
                    transform: metered
                      ? `scaleY(${FLATLINE_SCALE})`
                      : undefined,
                  }}
                />
              ))}
            </span>
            <Square
              aria-hidden="true"
              data-testid="shell-home-pill-listening-stop"
              className="size-5 shrink-0 fill-white/90 text-white/90"
              strokeWidth={1.5}
            />
          </>
        ) : null}
        {phase === "processing" &&
          PROCESS_DOTS.map((dot) => (
            <span
              key={dot.id}
              data-testid="shell-home-pill-process-dot"
              className="home-pill-process-dot h-[5px] w-[5px] rounded-full bg-white/90 motion-reduce:animate-none"
              style={{ animationDelay: `${dot.delayMs}ms` }}
            />
          ))}
      </span>
    </Button>
  );
}
