/**
 * Performance governor for the homescreen canvas.
 *
 * The goal: "we should have a performance indicator and measure — if it's
 * bogging down the device we should warn, and automatically when we create we
 * should try to self-optimize." This module is the pure decision core. The host
 * feeds it frame deltas; it maintains a rolling FPS estimate and decides when to
 * (a) surface a warning and (b) ask the active scene to shed detail via
 * {@link SceneInstance.optimize}.
 *
 * Quality tier is a single knob in [0,1]: 1 = full detail, 0 = bare minimum. The
 * governor lowers the tier when sustained FPS is below target and only raises it
 * back once there's comfortable headroom — a hysteresis band that stops the tier
 * from oscillating frame to frame.
 */

export interface PerfThresholds {
  /** FPS below this (sustained) triggers a downgrade + warning. */
  warnFps: number;
  /** FPS above this (sustained) allows an upgrade back toward full detail. */
  recoverFps: number;
  /** Frames the condition must hold before acting (debounce). */
  sustainFrames: number;
  /** Tier step per adjustment. */
  step: number;
}

export const DEFAULT_THRESHOLDS: PerfThresholds = {
  warnFps: 45,
  recoverFps: 58,
  sustainFrames: 45,
  step: 0.2,
};

export interface PerfState {
  /** Exponential moving average of instantaneous FPS. */
  fps: number;
  /** Current quality tier in [0,1]. */
  tier: number;
  /** True while sustained FPS is under target — drives the UI warning. */
  warning: boolean;
  /** Consecutive frames below warnFps. */
  belowFrames: number;
  /** Consecutive frames above recoverFps. */
  aboveFrames: number;
}

export function createPerfState(): PerfState {
  return { fps: 60, tier: 1, warning: false, belowFrames: 0, aboveFrames: 0 };
}

/** Smoothing factor for the FPS EMA. Higher = more responsive, noisier. */
const FPS_ALPHA = 0.1;

function clampTier(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface PerfTick {
  state: PerfState;
  /** Set when the governor wants the scene to change detail this frame. */
  retarget: number | null;
}

/**
 * Advance the governor by one frame given the frame delta in seconds. Returns the
 * next state and, when a tier change is warranted, the new target tier the host
 * should pass to {@link SceneInstance.optimize}. `retarget` is null on frames
 * that don't change the tier.
 */
export function perfTick(
  state: PerfState,
  dtSeconds: number,
  thresholds: PerfThresholds = DEFAULT_THRESHOLDS,
): PerfTick {
  // Guard against a zero/negative dt (paused tab, first frame).
  const instFps = dtSeconds > 0 ? 1 / dtSeconds : state.fps;
  const fps = state.fps + (instFps - state.fps) * FPS_ALPHA;

  let belowFrames = fps < thresholds.warnFps ? state.belowFrames + 1 : 0;
  let aboveFrames = fps > thresholds.recoverFps ? state.aboveFrames + 1 : 0;
  let tier = state.tier;
  let warning = state.warning;
  let retarget: number | null = null;

  if (belowFrames >= thresholds.sustainFrames && tier > 0) {
    tier = clampTier(tier - thresholds.step);
    retarget = tier;
    warning = true;
    belowFrames = 0;
  } else if (aboveFrames >= thresholds.sustainFrames && tier < 1) {
    tier = clampTier(tier + thresholds.step);
    retarget = tier;
    aboveFrames = 0;
    if (tier >= 1) warning = false;
  } else if (fps >= thresholds.warnFps && tier >= 1) {
    // Healthy and already at full detail — clear any stale warning.
    warning = false;
  }

  return {
    state: { fps, tier, warning, belowFrames, aboveFrames },
    retarget,
  };
}

/** A user-facing label for the current performance state. */
export function perfLabel(state: PerfState): string {
  const fps = Math.round(state.fps);
  if (state.warning) return `${fps} fps · reducing detail`;
  if (state.tier < 1)
    return `${fps} fps · ${Math.round(state.tier * 100)}% detail`;
  return `${fps} fps`;
}
