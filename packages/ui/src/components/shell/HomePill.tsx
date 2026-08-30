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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
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
   *  Absent (mic still opening, host without capture, permission or device
   *  failure) the bars hold the static flatline: decorative motion must never
   *  imply a hot mic. */
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
   *  into the resting 64px window. Web callers leave this unset. */
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

/** Listening-state waveform bars: fifteen bars with a center-weighted,
 *  symmetric height silhouette — mirroring the density of the studied Wispr
 *  Flow bar. Ids are stable keys. Motion comes only from live analyser
 *  frames; without them the bars rest at the flatline. */
const WAVE_BARS = [
  { id: "l7", height: 10 },
  { id: "l6", height: 13 },
  { id: "l5", height: 17 },
  { id: "l4", height: 16 },
  { id: "l3", height: 21 },
  { id: "l2", height: 22 },
  { id: "l1", height: 26 },
  { id: "c0", height: 28 },
  { id: "r1", height: 26 },
  { id: "r2", height: 22 },
  { id: "r3", height: 21 },
  { id: "r4", height: 16 },
  { id: "r5", height: 17 },
  { id: "r6", height: 13 },
  { id: "r7", height: 10 },
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
 * The complete 64×44 resting target is visibly painted. This is required for
 * detached native hosts: an invisible enlargement would intercept clicks in
 * nearby applications even though no launcher pixel was visible there. Status
 * is exposed through ARIA instead of permanent text.
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
  // Bars go live only when real audio frames exist to drive them; without an
  // analyser (or under reduced motion) they hold the static flatline.
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
      // Return the bars to the honest resting flatline; a stale live scale
      // must not survive an analyser teardown mid-listen (device loss).
      waveBarRefs.current.forEach((bar) => {
        if (bar) bar.style.transform = `scaleY(${FLATLINE_SCALE})`;
      });
    };
  }, [metered, analyser]);
  const listeningExpanded = listening && previewHostReady;
  const chipExpanded = listening || phase === "processing";
  const composerSized = previewVisible || listeningExpanded;
  const markPresentation = previewVisible
    ? "homePillPreview"
    : listeningExpanded
      ? "homePillListening"
      : chipExpanded
        ? "homePillChip"
        : phase === "responding"
          ? speaking
            ? "homePillSpeaking"
            : "homePillResponding"
          : "homePillIdle";
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
    <Card asChild variant="transparent">
      <Button
        variant="transparent"
        size="content"
        shape="circle"
        aria-label={label}
        aria-busy={needsAuth && signingIn ? true : undefined}
        aria-pressed={needsAuth ? undefined : isOpen}
        data-phase={phase}
        data-speaking={speaking || undefined}
        data-composer-sized={composerSized ? "true" : "false"}
        data-needs-auth={needsAuth ? "true" : "false"}
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
          // The resting launcher is deliberately transparent: only the white
          // handle (shell-home-pill-mark) paints, so the pill reads as a
          // floating handle over the desktop. The button still fills the 64x44
          // native window, so the #21876 hit-bounds contract (native bounds ==
          // interactive surface) is preserved without an opaque backdrop.
          // When a run must prove the window itself composited (packaged pixel
          // proofs, manual QA on hard-to-read wallpapers), temporarily swap in a
          // painted surface — e.g. "border border-white/20 bg-[#181a20]/95"
          // plus a frosted blur utility — instead of asserting on transparent
          // pixels. The shipped default stays transparent, and a permanent blur
          // here would fail the battery gate (see the blur allowlist test in
          // packages/ui/src).
          "group pointer-events-auto relative flex items-center justify-center",
          "transition-[width,height,transform] duration-200 motion-reduce:transition-none",
          "h-11 w-16 p-0 active:scale-95 data-[composer-sized=true]:h-16 data-[composer-sized=true]:w-[36rem] data-[needs-auth=true]:active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-inverse/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        )}
      >
        <Badge asChild variant="visualAnchor" presentation={markPresentation}>
          <span
            aria-hidden="true"
            data-testid="shell-home-pill-mark"
            data-visual-state={markPresentation}
            className={cn(
              "flex items-center justify-center transition-[width,height,opacity,transform,background-color,box-shadow] duration-200",
              // Listening/processing grow the capsule into a dark status chip.
              // Logged-out and idle states share the neutral handle/hover preview.
              previewVisible
                ? "h-14 w-full justify-start overflow-hidden px-5"
                : listeningExpanded
                  ? "h-14 w-full justify-between overflow-hidden px-5"
                  : chipExpanded
                    ? "h-7 w-20 gap-[3px]"
                    : "h-2.5 w-12 gap-[3px] group-hover:w-14",
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
                  <Badge
                    asChild
                    variant="visualAnchor"
                    presentation="homePillPreviewHandle"
                  >
                    <span className="h-2 w-12" />
                  </Badge>
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
                    <Badge
                      asChild
                      variant="visualAnchor"
                      presentation="homePillWave"
                      key={bar.id}
                    >
                      <span
                        ref={(node) => {
                          waveBarRefs.current[index] = node;
                        }}
                        data-testid="shell-home-pill-wave-bar"
                        data-live={metered || undefined}
                        className={cn(
                          "w-1 origin-center",
                          // Live-metered: the analyser drives scaleY each frame; in
                          // silence the bars flatline — the honest dead-mic signal.
                          metered && "transition-transform duration-75",
                        )}
                        style={{
                          height: `${bar.height}px`,
                          // Flat is the truthful rest state: no analyser frames (mic
                          // opening, capture-less host, reduced motion) means no
                          // motion — never a decorative shimmer.
                          transform: `scaleY(${FLATLINE_SCALE})`,
                        }}
                      />
                    </Badge>
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
                <Badge
                  asChild
                  variant="visualAnchor"
                  presentation="homePillProcessDot"
                  key={dot.id}
                >
                  <span
                    data-testid="shell-home-pill-process-dot"
                    className="home-pill-process-dot size-[5px] motion-reduce:animate-none"
                    style={{ animationDelay: `${dot.delayMs}ms` }}
                  />
                </Badge>
              ))}
          </span>
        </Badge>
      </Button>
    </Card>
  );
}
