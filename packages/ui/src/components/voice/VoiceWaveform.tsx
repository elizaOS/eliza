import * as React from "react";

import { cn } from "../../lib/utils";

export type VoiceWaveformMode = "idle" | "listening" | "responding";

export type FrequencyAnalyser = Pick<
  AnalyserNode,
  "frequencyBinCount" | "getByteFrequencyData"
>;

export interface VoiceWaveformProps {
  mode: VoiceWaveformMode;
  analyser?: FrequencyAnalyser | null;
  captureMic?: boolean;
  className?: string;
  ariaLabel?: string;
}

const BAR_COUNT = 24;
const BAR_KEYS = Array.from(
  { length: BAR_COUNT },
  (_, index) => `voice-waveform-bar-${index}`,
);

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

export interface LevelSummary {
  energy: number;
  low: number;
  mid: number;
  high: number;
}

export function summarizeLevels(levels: Float32Array): LevelSummary {
  const n = levels.length;
  if (n === 0) return { energy: 0, low: 0, mid: 0, high: 0 };
  const third = Math.max(1, Math.floor(n / 3));
  let total = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let i = 0; i < n; i += 1) {
    const v = levels[i] ?? 0;
    total += v;
    if (i < third) low += v;
    else if (i < third * 2) mid += v;
    else high += v;
  }
  const highCount = Math.max(1, n - third * 2);
  return {
    energy: total / n,
    low: low / third,
    mid: mid / third,
    high: high / highCount,
  };
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
      // already disconnected
    }
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };

  return { analyser, stop };
}

function activeAnalyserForMode(
  mode: VoiceWaveformMode,
  analyser: FrequencyAnalyser | null,
  mic: MicAnalyser | null,
): FrequencyAnalyser | null {
  if (mode === "responding") return analyser;
  if (mode === "listening") return analyser ?? mic?.analyser ?? null;
  return null;
}

function makeFallbackLevels(mode: VoiceWaveformMode): Float32Array {
  const base = mode === "idle" ? 0.18 : mode === "listening" ? 0.38 : 0.58;
  return Float32Array.from({ length: BAR_COUNT }, (_, index) => {
    const phase = (index / BAR_COUNT) * Math.PI * 2;
    return Math.max(0.06, base + Math.sin(phase) * 0.12);
  });
}

export function VoiceWaveform({
  mode,
  analyser,
  captureMic = false,
  className,
  ariaLabel = "Voice activity",
}: VoiceWaveformProps): React.JSX.Element {
  const [levels, setLevels] = React.useState(() => makeFallbackLevels(mode));
  const externalAnalyserRef = React.useRef<FrequencyAnalyser | null>(
    analyser ?? null,
  );
  const micRef = React.useRef<MicAnalyser | null>(null);

  externalAnalyserRef.current = analyser ?? null;

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
    let frame = 0;
    let raf = 0;
    let disposed = false;

    const tick = () => {
      const active = activeAnalyserForMode(
        mode,
        externalAnalyserRef.current,
        micRef.current,
      );
      const sampled = sampleFrequencyLevels(active, BAR_COUNT);
      const next =
        sampled.some((value) => value > 0) || active
          ? sampled
          : makeFallbackLevels(mode);
      setLevels(next);
      frame += 1;
      if (!disposed && frame < 1_000_000) {
        raf = window.requestAnimationFrame(tick);
      }
    };

    if (typeof window !== "undefined") {
      raf = window.requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [mode]);

  const summary = summarizeLevels(levels);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn(
        "pointer-events-none flex h-full w-full select-none items-center justify-center overflow-hidden",
        className,
      )}
      data-testid="voice-waveform"
      data-mode={mode}
      style={
        {
          "--voice-energy": summary.energy.toFixed(3),
          "--voice-low": summary.low.toFixed(3),
          "--voice-mid": summary.mid.toFixed(3),
          "--voice-high": summary.high.toFixed(3),
        } as React.CSSProperties
      }
    >
      <div className="flex h-2/3 w-3/4 max-w-[360px] items-center justify-center gap-1.5">
        {BAR_KEYS.map((key, index) => {
          const level = levels[index] ?? 0;
          const height = `${Math.max(10, Math.round(18 + level * 70))}%`;
          return (
            <span
              aria-hidden="true"
              className="block w-1.5 rounded-full bg-[rgb(var(--accent-rgb,255,88,0))] opacity-80 shadow-[0_0_18px_rgba(255,88,0,0.28)] transition-[height,opacity] duration-150"
              key={key}
              style={{ height }}
            />
          );
        })}
      </div>
    </div>
  );
}
