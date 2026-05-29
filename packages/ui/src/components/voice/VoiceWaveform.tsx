import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Visual mode for the voice avatar.
 *
 * - `idle`: no mic, no TTS. The orb breathes with a slow organic wobble.
 * - `listening`: mic is open. The blob deforms with live microphone amplitude.
 * - `responding`: the agent is speaking (TTS). The blob deforms with playback
 *   amplitude when an analyser is supplied, otherwise an animated active wobble.
 */
export type VoiceWaveformMode = "idle" | "listening" | "responding";

/** Minimal analyser surface — lets tests supply a fake without a DOM audio graph. */
export type FrequencyAnalyser = Pick<
  AnalyserNode,
  "frequencyBinCount" | "getByteFrequencyData"
>;

export interface VoiceWaveformProps {
  mode: VoiceWaveformMode;
  /**
   * Optional Web Audio analyser to read amplitude from. When provided it drives
   * the blob from the active capture / playback node. The avatar never mutates
   * or disconnects the node — it only reads.
   */
  analyser?: FrequencyAnalyser | null;
  /**
   * Open a private microphone analyser when listening and no analyser is
   * supplied. Defaults to false so shells that already own voice capture do
   * not create a second getUserMedia session just for visualization.
   */
  captureMic?: boolean;
  /** Diameter / square size in px. Default 220. */
  size?: number;
  className?: string;
  /** Accessible label. Default "Voice activity". */
  ariaLabel?: string;
}

const DEFAULT_SIZE = 220;
/** Vertices around the blob outline. Higher = smoother, rounder curve. */
const POINTS = 72;

/**
 * Average `analyser` frequency data into `count` normalized [0,1] buckets.
 * Pure and DOM-free so it can be exercised with a fake analyser in tests.
 */
export function sampleFrequencyLevels(
  analyser: FrequencyAnalyser | null | undefined,
  count: number,
): Float32Array {
  const out = new Float32Array(count);
  if (!analyser || count <= 0) return out;
  const bins = analyser.frequencyBinCount;
  if (bins <= 0) return out;
  const buf = new Uint8Array(bins);
  analyser.getByteFrequencyData(buf);
  const step = Math.max(1, Math.floor(bins / count));
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) {
      sum += buf[i * step + j] ?? 0;
    }
    out[i] = sum / step / 255;
  }
  return out;
}

/**
 * Per-vertex blob radii. Pure: identical inputs yield identical output, which
 * is what the reactivity tests assert.
 *
 * - `idle` ignores `levels` and breathes from `time` alone.
 * - active modes blend an ambient organic wobble with the supplied amplitude,
 *   so louder input always pushes the outline further out.
 */
export function computeBlobRadii(args: {
  levels: Float32Array;
  time: number;
  mode: VoiceWaveformMode;
  points: number;
  baseRadius: number;
  maxDeform: number;
}): Float32Array {
  const { levels, time, mode, points, baseRadius, maxDeform } = args;
  const radii = new Float32Array(points);
  const responding = mode === "responding";
  for (let i = 0; i < points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    let deform: number;
    if (mode === "idle") {
      const breath = Math.sin(time * 0.9 + i * 0.35) * 0.5 + 0.5;
      deform = maxDeform * (0.1 + 0.12 * breath);
    } else {
      const wobble =
        (Math.sin(time * 1.6 + angle * 3) * 0.5 + 0.5) * 0.5 +
        (Math.sin(time * 2.3 - angle * 5) * 0.5 + 0.5) * 0.5;
      const ambient = maxDeform * (responding ? 0.26 : 0.2) * wobble;
      const reactive = maxDeform * 0.78 * Math.min(1, levels[i] ?? 0);
      deform = ambient + reactive;
    }
    radii[i] = baseRadius + deform;
  }
  return radii;
}

/** Brand orange fallback as an "r, g, b" triple (matches --accent-rgb). */
const FALLBACK_ACCENT_RGB = "255, 88, 0";

/**
 * Resolve the `--accent-rgb` custom property to a concrete "r, g, b" string.
 * Canvas color strings cannot contain `var()`, so this must be resolved before
 * being handed to the 2D context. Returns the brand-orange fallback when the
 * property is undefined, empty, or not a valid comma-separated RGB triple.
 */
function resolveAccentRgb(): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return FALLBACK_ACCENT_RGB;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent-rgb")
    .trim();
  const channels = raw.split(",").map((part) => Number(part.trim()));
  if (
    channels.length !== 3 ||
    channels.some(
      (channel) => !Number.isInteger(channel) || channel < 0 || channel > 255,
    )
  ) {
    return FALLBACK_ACCENT_RGB;
  }
  return channels.join(", ");
}

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type MicAnalyser = {
  analyser: AnalyserNode;
  stop: () => void;
};

async function openMicAnalyser(): Promise<MicAnalyser | null> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return null;
  }
  const AudioCtor: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  if (!AudioCtor) return null;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioCtor();
  if (context.state === "suspended") {
    await context.resume().catch(() => {});
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  const stop = () => {
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  return { analyser, stop };
}

/** Draw a smooth closed curve through the radial vertices (Catmull-Rom). */
function strokeBlobPath(
  c: CanvasRenderingContext2D,
  center: number,
  radii: Float32Array,
): void {
  const count = radii.length;
  const point = (index: number): [number, number] => {
    const i = ((index % count) + count) % count;
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const r = radii[i] ?? 0;
    return [center + Math.cos(angle) * r, center + Math.sin(angle) * r];
  };

  c.beginPath();
  const [startX, startY] = point(0);
  c.moveTo(startX, startY);
  for (let i = 0; i < count; i += 1) {
    const [p0x, p0y] = point(i - 1);
    const [p1x, p1y] = point(i);
    const [p2x, p2y] = point(i + 1);
    const [p3x, p3y] = point(i + 2);
    const c1x = p1x + (p2x - p0x) / 6;
    const c1y = p1y + (p2y - p0y) / 6;
    const c2x = p2x - (p3x - p1x) / 6;
    const c2y = p2y - (p3y - p1y) / 6;
    c.bezierCurveTo(c1x, c1y, c2x, c2y, p2x, p2y);
  }
  c.closePath();
}

/**
 * Voice-reactive avatar — a sci-fi orb whose organic outline morphs with live
 * audio. Reads amplitude from the supplied analyser (TTS playback in
 * `responding`, mic in `listening`), or opens a private mic when `captureMic`
 * is set. Idle breathes softly. Honors `prefers-reduced-motion`.
 *
 * Rendering lives in the canvas; the reactive math is factored into
 * `sampleFrequencyLevels` and `computeBlobRadii`, which are unit-tested.
 */
export function VoiceWaveform({
  mode,
  analyser,
  captureMic = false,
  size = DEFAULT_SIZE,
  className,
  ariaLabel = "Voice activity",
}: VoiceWaveformProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const modeRef = React.useRef<VoiceWaveformMode>(mode);
  modeRef.current = mode;
  const externalAnalyserRef = React.useRef<FrequencyAnalyser | null>(
    analyser ?? null,
  );
  externalAnalyserRef.current = analyser ?? null;
  const micRef = React.useRef<MicAnalyser | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (mode === "listening" && captureMic && !externalAnalyserRef.current) {
      void openMicAnalyser().then((handle) => {
        if (cancelled || !handle) {
          handle?.stop();
          return;
        }
        micRef.current = handle;
      });
    }
    return () => {
      cancelled = true;
      micRef.current?.stop();
      micRef.current = null;
    };
  }, [captureMic, mode]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const c: CanvasRenderingContext2D = context;

    const dpr =
      typeof window === "undefined"
        ? 1
        : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    c.scale(dpr, dpr);

    const center = size / 2;
    const baseRadius = size * 0.3;
    const maxDeform = size * 0.16;
    // Canvas 2D cannot parse CSS `var()` in color strings — it throws on every
    // addColorStop/fillStyle assignment. Resolve --accent-rgb to a concrete
    // "r, g, b" triple once at paint-setup, falling back to brand orange.
    const accentRgb = resolveAccentRgb();
    const accent = (alpha: number) => `rgba(${accentRgb}, ${alpha})`;

    const smoothed = new Float32Array(POINTS).fill(baseRadius);

    function activeAnalyser(): FrequencyAnalyser | null {
      const phase = modeRef.current;
      if (phase === "responding") return externalAnalyserRef.current;
      if (phase === "listening") {
        return externalAnalyserRef.current ?? micRef.current?.analyser ?? null;
      }
      return null;
    }

    // Light comes from the upper-left, so the body gradient, specular hotspot,
    // and contact shadow all bias toward that corner to read as a lit sphere
    // rather than a flat disc.
    const lightX = center - baseRadius * 0.42;
    const lightY = center - baseRadius * 0.42;

    function paint(radii: Float32Array, glow: number): void {
      c.clearRect(0, 0, size, size);

      // Volumetric body: the radial center is offset toward the light so the
      // far side falls into shadow — the core depth cue for a 3D sphere.
      const fill = c.createRadialGradient(
        lightX,
        lightY,
        baseRadius * 0.05,
        center,
        center,
        baseRadius + maxDeform,
      );
      fill.addColorStop(0, accent(0.5));
      fill.addColorStop(0.45, accent(0.22));
      fill.addColorStop(0.78, accent(0.1));
      fill.addColorStop(1, accent(0.02));

      c.save();
      // Contact shadow cast down-right, opposite the light.
      c.shadowColor = "rgba(0, 0, 0, 0.45)";
      c.shadowBlur = size * (0.05 + glow * 0.1);
      c.shadowOffsetX = size * 0.02;
      c.shadowOffsetY = size * 0.035;
      strokeBlobPath(c, center, radii);
      c.fillStyle = fill;
      c.fill();
      c.restore();

      // Clip to the body for every interior light/shadow layer so highlights
      // never spill past the morphing outline.
      c.save();
      strokeBlobPath(c, center, radii);
      c.clip();

      // Terminator shading — a dark pool on the lower-right deepens the volume.
      const shade = c.createRadialGradient(
        center + baseRadius * 0.5,
        center + baseRadius * 0.5,
        baseRadius * 0.1,
        center + baseRadius * 0.4,
        center + baseRadius * 0.4,
        baseRadius + maxDeform,
      );
      shade.addColorStop(0, "rgba(0, 0, 0, 0.32)");
      shade.addColorStop(0.6, "rgba(0, 0, 0, 0.08)");
      shade.addColorStop(1, "rgba(0, 0, 0, 0)");
      c.fillStyle = shade;
      c.fillRect(0, 0, size, size);

      // Specular hotspot — a tight bright bloom near the light source.
      const specular = c.createRadialGradient(
        lightX,
        lightY,
        0,
        lightX,
        lightY,
        baseRadius * 0.6,
      );
      specular.addColorStop(0, `rgba(255, 255, 255, ${0.5 + glow * 0.3})`);
      specular.addColorStop(0.35, "rgba(255, 255, 255, 0.12)");
      specular.addColorStop(1, "rgba(255, 255, 255, 0)");
      c.fillStyle = specular;
      c.fillRect(0, 0, size, size);
      c.restore();

      // Rim light on the shadowed edge — the glossy backlight that sells depth.
      c.save();
      strokeBlobPath(c, center, radii);
      c.lineWidth = Math.max(1.5, size * 0.01);
      c.strokeStyle = accent(0.85);
      c.shadowColor = accent(0.5 + glow * 0.3);
      c.shadowBlur = size * (0.04 + glow * 0.1);
      c.stroke();
      c.restore();

      // Inner core that pulses with overall energy, offset toward the light.
      c.beginPath();
      c.arc(lightX, lightY, baseRadius * (0.3 + glow * 0.16), 0, Math.PI * 2);
      const core = c.createRadialGradient(
        lightX,
        lightY,
        0,
        lightX,
        lightY,
        baseRadius * 0.5,
      );
      core.addColorStop(0, accent(0.7 + glow * 0.3));
      core.addColorStop(1, accent(0));
      c.fillStyle = core;
      c.fill();
    }

    if (prefersReducedMotion()) {
      paint(
        computeBlobRadii({
          levels: new Float32Array(POINTS),
          time: 0,
          mode: "idle",
          points: POINTS,
          baseRadius,
          maxDeform,
        }),
        0,
      );
      return undefined;
    }

    let raf = 0;
    let t = 0;

    function frame(): void {
      t += 0.03;
      const levels = sampleFrequencyLevels(activeAnalyser(), POINTS);
      const target = computeBlobRadii({
        levels,
        time: t,
        mode: modeRef.current,
        points: POINTS,
        baseRadius,
        maxDeform,
      });
      let energy = 0;
      for (let i = 0; i < POINTS; i += 1) {
        smoothed[i] =
          (smoothed[i] ?? baseRadius) * 0.78 + (target[i] ?? 0) * 0.22;
        energy += (smoothed[i] - baseRadius) / maxDeform;
      }
      const glow = Math.min(1, Math.max(0, energy / POINTS));
      paint(smoothed, glow);
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      data-testid="voice-waveform"
      data-mode={mode}
      style={{ width: size, height: size }}
      className={cn("pointer-events-none select-none", className)}
    />
  );
}
