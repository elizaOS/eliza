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
 * On a cloud-only build the `needs-auth` phase replaces both gestures with a
 * labeled chip that launches Cloud sign-in. Hold is not armed there.
 */
import * as React from "react";

import { useBranding } from "../../config/branding";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import type { ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
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
  /** True while the assistant reply is being spoken aloud. Sharpens the
   *  responding glow so "speaking" and "thinking" read differently. */
  speaking?: boolean;
  /** True while Cloud sign-in is in flight from this pill. Pulses the
   *  `needs-auth` chip so the wait is visible. */
  signingIn?: boolean;
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
  { id: "l4", delayMs: 420 },
  { id: "l3", delayMs: 240 },
  { id: "l2", delayMs: 120 },
  { id: "l1", delayMs: 60 },
  { id: "c0", delayMs: 0 },
  { id: "r1", delayMs: 60 },
  { id: "r2", delayMs: 120 },
  { id: "r3", delayMs: 240 },
  { id: "r4", delayMs: 420 },
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
 *   needs-auth  — dark labeled chip ("Sign in to {appName}").
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
  onOpen,
  onClose,
  onHoldStart,
  onHoldEnd,
  onHoldCancel,
  speaking = false,
  signingIn = false,
}: HomePillProps): React.JSX.Element {
  const { appName } = useBranding();
  const needsAuth = phase === "needs-auth";
  // The pill reads as "open" (its click will close) only for the overlay
  // surfaces. `listening` is deliberately NOT included: hold-to-talk runs with
  // the overlay closed, and treating it as open would flash the label/pressed
  // state during every hold (#20483).
  const isOpen = phase === "summoned" || phase === "responding";

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

  const signInLabel = `Sign in to ${appName}`;
  const chipExpanded =
    phase === "listening" || phase === "processing" || needsAuth;
  const label = needsAuth
    ? signInLabel
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
      aria-pressed={isOpen}
      data-phase={phase}
      data-speaking={speaking || undefined}
      data-testid="shell-home-pill"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{ zIndex: Z_SHELL_OVERLAY }}
      className={cn(
        "group pointer-events-auto relative mb-2 flex h-8 items-center justify-center rounded-full bg-transparent p-0",
        needsAuth ? "w-[13rem]" : "w-16",
        "transition-transform duration-200 hover:bg-transparent active:scale-95",
        "focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="shell-home-pill-mark"
        className={cn(
          "flex items-center justify-center rounded-full",
          "transition-[width,height,opacity,transform,background-color,box-shadow] duration-200",
          // Listening/processing/needs-auth grow the capsule into a dark chip.
          // Listening carries live bars; processing swaps them for dots;
          // needs-auth fills the chip with the sign-in label.
          needsAuth
            ? "h-7 min-w-[11.5rem] px-3 bg-neutral-900/95"
            : chipExpanded
              ? "h-7 w-20 gap-[3px] bg-neutral-900/95"
              : "h-2.5 w-12 gap-[3px] bg-white/95 group-hover:w-14",
          chipExpanded && "shadow-[0_4px_16px_rgba(0,0,0,0.35)]",
          !chipExpanded &&
            (phase === "responding"
              ? speaking
                ? // Speaking: stronger, tighter warm glow than thinking — the
                  // reply is audibly playing right now.
                  "shadow-[0_0_14px_rgba(255,138,42,0.85),0_0_0_1px_rgba(255,138,42,0.5)]"
                : "shadow-[0_0_10px_rgba(255,138,42,0.6),0_0_0_1px_rgba(0,0,0,0.12)]"
              : "shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"),
          (phase === "booting" || (needsAuth && signingIn)) &&
            "animate-pulse opacity-65 motion-reduce:animate-none",
          phase === "responding" &&
            !speaking &&
            "animate-pulse opacity-90 motion-reduce:animate-none",
        )}
      >
        {needsAuth && (
          <span
            data-testid="shell-home-pill-sign-in"
            className="whitespace-nowrap text-[11px] font-medium tracking-tight text-white/95"
          >
            {signInLabel}
          </span>
        )}
        {phase === "listening" &&
          WAVE_BARS.map((bar) => (
            <span
              key={bar.id}
              data-testid="shell-home-pill-wave-bar"
              className="home-pill-wave-bar h-[6px] w-[3px] rounded-full bg-white/95 motion-reduce:animate-none"
              style={{ animationDelay: `${bar.delayMs}ms` }}
            />
          ))}
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
