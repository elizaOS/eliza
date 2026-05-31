import type * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import {
  applyParams,
  createDirector,
  type Director,
  RIG_SVG,
  type RigEmotion,
  type RigParams,
} from "./rigRuntime";

export interface FaceRigProps {
  /** Blend target emotion preset. Defaults to `neutral`. */
  emotion?: RigEmotion;
  /** Drive the talking jaw envelope (ignored while `audioStream` lip-syncs). */
  talking?: boolean;
  /** Allow periodic blinks. Defaults to `true`. */
  blink?: boolean;
  /** Apply idle head sway + breathing. Defaults to `true`. */
  idle?: boolean;
  /**
   * Optional live audio source (assistant TTS or user mic). When provided, the
   * jaw is driven from the stream's RMS amplitude instead of the procedural
   * talk envelope — a self-contained lip-sync that needs no external driver.
   */
  audioStream?: MediaStream | null;
  /**
   * Pins specific params every frame after the director runs. Use to override
   * the rig from a caller (e.g. a manual scrubber or an external driver).
   */
  paramsOverride?: Partial<RigParams>;
  className?: string;
  style?: React.CSSProperties;
}

/** True when the user has asked the OS to minimize motion. */
function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Self-contained mic/TTS amplitude meter used to drive the jaw for lip-sync. */
interface JawMeter {
  /** Latest smoothed amplitude in 0..1. */
  read(): number;
  /** Tear down the audio graph (does not stop the caller's stream). */
  dispose(): void;
}

/**
 * Wrap a {@link MediaStream} in an `AnalyserNode` and expose a smoothed RMS
 * amplitude in 0..1. Attack is faster than release so the mouth snaps open on
 * speech onset and eases shut on silence, which reads as natural lip motion.
 */
function createJawMeter(stream: MediaStream): JawMeter {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(
    new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
  );
  let level = 0;
  const ATTACK = 0.6;
  const RELEASE = 0.18;
  return {
    read(): number {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // Map a speech-typical RMS window to 0..1 and gate the noise floor.
      const target = Math.min(1, Math.max(0, (rms - 0.01) * 6));
      const coeff = target > level ? ATTACK : RELEASE;
      level += (target - level) * coeff;
      return level;
    },
    dispose(): void {
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
    },
  };
}

// Make the injected <svg> fill its host while preserving the 1:1 viewBox.
const RIG_SVG_RESPONSIVE = RIG_SVG.replace(
  '<svg id="face"',
  '<svg id="face" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%"',
);

/**
 * A drop-in negative-space anime face puppet. Renders the baked rest-pose SVG
 * (SSR-safe — the static markup is correct with no JS) and, on mount, drives it
 * with a procedural director on a single requestAnimationFrame loop. Designed
 * to fill its container on a dark background.
 *
 * Honors `prefers-reduced-motion` by holding a single static pose. When an
 * `audioStream` is supplied the jaw lip-syncs to its amplitude.
 */
export function FaceRig({
  emotion = "neutral",
  talking = false,
  blink = true,
  idle = true,
  audioStream = null,
  paramsOverride,
  className,
  style,
}: FaceRigProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Latest live props, read by the frame loop without re-subscribing it.
  const liveRef = useRef({ talking, blink, idle, paramsOverride });
  liveRef.current = { talking, blink, idle, paramsOverride };

  // Latest emotion, so an audio-driven loop rebuild starts on the right pose
  // even though `emotion` is intentionally out of the main effect's deps.
  const emotionRef = useRef(emotion);
  emotionRef.current = emotion;

  // The director and mounted face element, created once on mount; the emotion
  // effect reaches them here to retarget without rebuilding the frame loop.
  const directorRef = useRef<Director | null>(null);
  const faceRef = useRef<SVGSVGElement | null>(null);
  const reducedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    const faceEl = host?.querySelector<SVGSVGElement>("#face");
    if (!faceEl) return;

    const director = createDirector();
    directorRef.current = director;
    faceRef.current = faceEl;
    director.setEmotion(emotionRef.current);

    const applyPinned = (frame: RigParams): void => {
      const override = liveRef.current.paramsOverride;
      applyParams(faceEl, override ? { ...frame, ...override } : frame);
    };

    // Reduced motion: settle the director on the target pose (a large step with
    // no envelopes fully converges the easing), apply one frame, and hold. The
    // emotion effect re-applies a fresh static frame on subsequent changes.
    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;
    if (reduced) {
      applyPinned(
        director.tick(10, { talk: false, blink: false, idle: false }),
      );
      return () => {
        directorRef.current = null;
        faceRef.current = null;
      };
    }

    const meter: JawMeter | null = audioStream
      ? createJawMeter(audioStream)
      : null;

    let rafId = 0;
    let last = performance.now();
    const frame = (): void => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const live = liveRef.current;
      const params = director.tick(dt, {
        // The amplitude meter owns the jaw while a stream is attached, so the
        // procedural talk envelope is suppressed to avoid double-driving it.
        talk: meter ? false : live.talking,
        blink: live.blink,
        idle: live.idle,
      });
      if (meter) params.jaw = Math.max(params.jaw, meter.read());
      applyPinned(params);
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      directorRef.current = null;
      faceRef.current = null;
      meter?.dispose();
    };
    // Only the audio source identity rebuilds the loop. Emotion is retargeted
    // live by the effect below; the flags are read through liveRef each frame,
    // so they intentionally stay out of the deps.
  }, [audioStream]);

  // Retarget the blend on emotion change without rebuilding the loop. Under
  // reduced motion there is no loop, so re-settle and apply one static frame.
  useEffect(() => {
    const director = directorRef.current;
    if (!director) return;
    director.setEmotion(emotion);
    if (reducedRef.current && faceRef.current) {
      const frame = director.tick(10, {
        talk: false,
        blink: false,
        idle: false,
      });
      const override = liveRef.current.paramsOverride;
      applyParams(
        faceRef.current,
        override ? { ...frame, ...override } : frame,
      );
    }
  }, [emotion]);

  return (
    <div
      ref={hostRef}
      data-testid="face-rig"
      className={cn("face-rig", className)}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        lineHeight: 0,
        ...style,
      }}
      // SSR-safe: the baked markup already shows the correct rest pose; the
      // effect above only animates it once mounted.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, build-time-generated rig markup
      dangerouslySetInnerHTML={{ __html: RIG_SVG_RESPONSIVE }}
    />
  );
}
