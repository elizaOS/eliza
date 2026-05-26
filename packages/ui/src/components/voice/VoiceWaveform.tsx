import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Visual mode for the waveform.
 *
 * - `idle`: no mic, no TTS. Gentle ambient breathing animation.
 * - `listening`: mic is open. Bars react to live microphone amplitude.
 * - `responding`: the agent is speaking (TTS). Bars react to playback
 *   amplitude when an analyser is supplied, otherwise an active animated
 *   "speaking" pattern.
 */
export type VoiceWaveformMode = "idle" | "listening" | "responding";

export interface VoiceWaveformProps {
  mode: VoiceWaveformMode;
  /**
   * Optional Web Audio analyser to read amplitude from. When provided in
   * `responding` mode it drives the bars from the active TTS playback node.
   * The waveform never mutates or disconnects the node — it only reads.
   */
  analyser?: AnalyserNode | null;
  /**
   * Open a private microphone analyser when listening and no analyser is
   * supplied. Defaults to false so shells that already own voice capture do
   * not create a second getUserMedia session just for visualization.
   */
  captureMic?: boolean;
  /** Bar count. Default 24. */
  bars?: number;
  /** Diameter / square size in px. Default 220. */
  size?: number;
  className?: string;
  /** Accessible label. Default "Voice activity". */
  ariaLabel?: string;
}

const DEFAULT_BARS = 24;
const DEFAULT_SIZE = 220;

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
  data: Uint8Array;
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
  const data = new Uint8Array(analyser.frequencyBinCount);

  const stop = () => {
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  return { analyser, data, stop };
}

/**
 * Centered voice-avatar waveform. Canvas-based radial bars that respond to
 * the active mic capture (when `listening`) or TTS playback amplitude (when
 * `responding` with an analyser). Idle renders a calm breathing ring.
 *
 * When an analyser is supplied, the visualizer reads from that audio node.
 * Without one it uses an active fallback animation; callers can opt into a
 * private microphone analyser with `captureMic` for standalone demos.
 *
 * Honors `prefers-reduced-motion` by rendering a single static ring.
 */
export function VoiceWaveform({
  mode,
  analyser,
  captureMic = false,
  bars = DEFAULT_BARS,
  size = DEFAULT_SIZE,
  className,
  ariaLabel = "Voice activity",
}: VoiceWaveformProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const modeRef = React.useRef<VoiceWaveformMode>(mode);
  modeRef.current = mode;
  const externalAnalyserRef = React.useRef<AnalyserNode | null>(
    analyser ?? null,
  );
  externalAnalyserRef.current = analyser ?? null;
  const micRef = React.useRef<MicAnalyser | null>(null);

  // Open / close the mic analyser as the mode enters / leaves `listening`.
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

    const reduced = prefersReducedMotion();
    const center = size / 2;
    const innerRadius = size * 0.26;
    const maxBar = size * 0.2;
    const accent = "rgba(var(--accent-rgb, 255, 88, 0), 0.85)";
    const accentDim = "rgba(var(--accent-rgb, 255, 88, 0), 0.35)";

    const levels = new Float32Array(bars);

    function readAmplitude(): Float32Array {
      const active =
        modeRef.current === "responding"
          ? externalAnalyserRef.current
          : modeRef.current === "listening"
            ? (externalAnalyserRef.current ?? micRef.current?.analyser ?? null)
            : null;
      const out = new Float32Array(bars);
      if (active) {
        const bins = active.frequencyBinCount;
        const buf = new Uint8Array(bins);
        active.getByteFrequencyData(buf);
        const step = Math.max(1, Math.floor(bins / bars));
        for (let i = 0; i < bars; i += 1) {
          let sum = 0;
          for (let j = 0; j < step; j += 1) {
            sum += buf[i * step + j] ?? 0;
          }
          out[i] = sum / step / 255;
        }
      }
      return out;
    }

    function drawStatic(): void {
      c.clearRect(0, 0, size, size);
      c.beginPath();
      c.arc(center, center, innerRadius + maxBar * 0.35, 0, Math.PI * 2);
      c.strokeStyle = accentDim;
      c.lineWidth = 3;
      c.stroke();
    }

    let raf = 0;
    let t = 0;

    function frame(): void {
      t += 0.04;
      const amp = readAmplitude();
      const phase = modeRef.current;
      c.clearRect(0, 0, size, size);

      for (let i = 0; i < bars; i += 1) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        let target: number;
        if (phase === "idle") {
          // Gentle breathing ripple.
          target = 0.12 + 0.08 * (Math.sin(t + i * 0.5) * 0.5 + 0.5);
        } else if (amp.some((v) => v > 0.001)) {
          target = Math.min(1, amp[i] ?? 0);
        } else {
          // Active fallback animation (no analyser amplitude available).
          const speed = phase === "responding" ? 2.2 : 1.4;
          target = 0.2 + 0.55 * Math.abs(Math.sin(t * speed + i * 0.7));
        }
        // Smooth toward the target so bars don't jitter.
        levels[i] = (levels[i] ?? 0) * 0.7 + target * 0.3;

        const barLen = maxBar * levels[i];
        const x1 = center + Math.cos(angle) * innerRadius;
        const y1 = center + Math.sin(angle) * innerRadius;
        const x2 = center + Math.cos(angle) * (innerRadius + barLen);
        const y2 = center + Math.sin(angle) * (innerRadius + barLen);
        c.beginPath();
        c.moveTo(x1, y1);
        c.lineTo(x2, y2);
        c.strokeStyle = phase === "idle" ? accentDim : accent;
        c.lineWidth = Math.max(2, size * 0.014);
        c.lineCap = "round";
        c.stroke();
      }

      // Center pulse ring.
      const avg =
        levels.reduce((acc, v) => acc + v, 0) / Math.max(1, levels.length);
      c.beginPath();
      c.arc(center, center, innerRadius * (0.82 + avg * 0.18), 0, Math.PI * 2);
      c.strokeStyle = accentDim;
      c.lineWidth = 2;
      c.stroke();

      raf = requestAnimationFrame(frame);
    }

    if (reduced) {
      drawStatic();
      return undefined;
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [bars, size]);

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
