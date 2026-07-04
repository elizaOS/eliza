/**
 * One push-to-talk hold state machine shared by every chat composer surface.
 *
 * Press-and-hold on the mic arms voice capture after a short hold; releasing
 * the pointer finishes it. A quick tap (released before the hold fires) never
 * starts capture and instead falls through to the button's own onClick — so the
 * hook exposes `shouldSuppressClick()` for the click handler to consult, so a
 * hold-release does not ALSO fire the tap action.
 *
 * The phase is a single ref (`idle → pending → holding → idle`) so it is the
 * one source of truth; pointer capture keeps move/up/cancel routed to the same
 * element even when the finger slides off. The overlay (dictation-into-draft)
 * and the ChatComposer (STT-then-submit) previously hand-rolled this machine
 * with divergent 200ms/180ms timings — {@link PUSH_TO_TALK_HOLD_MS} is now the
 * single hold duration for both.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";

/** Single hold duration before a press promotes to an active capture. */
export const PUSH_TO_TALK_HOLD_MS = 200;

type PushToTalkPhase =
  | { kind: "idle" }
  | { kind: "pending"; pointerId: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "holding"; pointerId: number };

export interface UsePushToTalkOptions {
  /**
   * Guard checked on pointerdown. Return `false` to ignore the press entirely
   * (e.g. composer locked, a capture already live, a reply in flight). The
   * press then does nothing and a following click runs normally.
   */
  canBegin: () => boolean;
  /** Runs once the hold duration elapses — start the capture. */
  onHoldStart: () => void;
  /**
   * Runs on release/cancel of an active (held) capture. `cancelled` is `true`
   * for pointercancel/leave (finger slid off) and `false` for a clean
   * pointerup — surfaces use it to decide submit-vs-discard.
   */
  onHoldEnd: (cancelled: boolean) => void;
  /** Hold duration override; defaults to {@link PUSH_TO_TALK_HOLD_MS}. */
  holdMs?: number;
}

export interface PushToTalkHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export interface UsePushToTalkResult {
  /** Spread onto the mic button. */
  handlers: PushToTalkHandlers;
  /**
   * Call at the top of the button's onClick. Returns `true` exactly once after
   * a held release, meaning "this click is the tail of a hold — swallow it".
   */
  shouldSuppressClick: () => boolean;
}

/**
 * Wire a mic button as a press-and-hold push-to-talk control. Returns pointer
 * handlers to spread on the button plus a `shouldSuppressClick` guard for its
 * click handler. Timers and pointer capture are cleaned up on unmount.
 */
export function usePushToTalk({
  canBegin,
  onHoldStart,
  onHoldEnd,
  holdMs = PUSH_TO_TALK_HOLD_MS,
}: UsePushToTalkOptions): UsePushToTalkResult {
  const phaseRef = useRef<PushToTalkPhase>({ kind: "idle" });
  const suppressClickRef = useRef(false);

  // Keep the latest callbacks without re-creating the handlers (which would
  // re-bind them on the button every render).
  const canBeginRef = useRef(canBegin);
  const onHoldStartRef = useRef(onHoldStart);
  const onHoldEndRef = useRef(onHoldEnd);
  canBeginRef.current = canBegin;
  onHoldStartRef.current = onHoldStart;
  onHoldEndRef.current = onHoldEnd;

  useEffect(
    () => () => {
      const phase = phaseRef.current;
      if (phase.kind === "pending") clearTimeout(phase.timer);
      if (phase.kind === "holding") onHoldEndRef.current(true);
      phaseRef.current = { kind: "idle" };
      suppressClickRef.current = false;
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Only arm from idle on the primary button, and only when the surface
      // says it may begin.
      if (
        phaseRef.current.kind !== "idle" ||
        event.button !== 0 ||
        !canBeginRef.current()
      ) {
        return;
      }
      const { pointerId } = event;
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // Synthetic/detached pointer — capture is best-effort.
      }
      const timer = setTimeout(() => {
        // Promote to holding only if still pending for THIS pointer.
        const phase = phaseRef.current;
        if (phase.kind !== "pending" || phase.pointerId !== pointerId) return;
        phaseRef.current = { kind: "holding", pointerId };
        onHoldStartRef.current();
      }, holdMs);
      phaseRef.current = { kind: "pending", pointerId, timer };
    },
    [holdMs],
  );

  // One funnel for pointerup (cancelled=false) and pointercancel/leave
  // (cancelled=true). Clears the pending timer and releases pointer capture
  // FIRST — before any early return — so a quick tap can never leak a stuck
  // timer or a captured pointer.
  const finish = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
      const phase = phaseRef.current;
      if (phase.kind === "pending") clearTimeout(phase.timer);
      if (
        typeof event.currentTarget.hasPointerCapture === "function" &&
        event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      phaseRef.current = { kind: "idle" };
      if (phase.kind === "holding") {
        onHoldEndRef.current(cancelled);
        // A real click follows a clean pointerup (never a cancel); suppress it
        // so the release doesn't ALSO fire the button's tap action. Set only
        // here so it can never leak into the next legitimate tap.
        if (!cancelled) suppressClickRef.current = true;
      }
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => finish(event, false),
    [finish],
  );
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => finish(event, true),
    [finish],
  );

  const shouldSuppressClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onPointerLeave: onPointerCancel,
    },
    shouldSuppressClick,
  };
}
