/**
 * MicWaveform — live mic-input amplitude visualization for the chat composer's
 * mic surface (voice waveform lane, fast-follow on the streaming-transcript +
 * auto-send + VAD work in #15426).
 *
 * The instant-feedback layer under the streaming transcript: while a
 * PCM-capturing voice backend is listening, this renders a compact wispr /
 * openai-style bar array whose bars scroll left as new amplitude samples
 * arrive, so the user SEES the mic is live and hears-the-shape of their speech
 * before any transcript text lands.
 *
 * Perf contract (this is the whole point):
 * - Level samples arrive via `subscribeMicLevel` (from `useVoiceChat`), which
 *   the capture layer already rAF-coalesces to ~30-60fps. We do NOT store the
 *   level in React state — that would re-render the composer 30-60×/s. Instead
 *   we keep a rolling ring buffer in a ref and mutate each bar's `scaleY`
 *   transform directly on its DOM node inside a single rAF loop. React renders
 *   the bars ONCE (mount) and never again for level changes.
 * - Only the coarse "is anything above the VAD floor" accent/muted state is a
 *   React `useState`, and it's throttled to flip at most on threshold crossings,
 *   not per sample.
 *
 * Accessibility / reduced motion:
 * - `prefers-reduced-motion` (via `useReducedMotion`) swaps the scrolling bars
 *   for a single static level bar whose width tracks a smoothed level — still
 *   informative ("mic is hearing you") without motion. If even that is too much
 *   the caller can pass `staticFallback` to force the non-animated variant.
 * - `role="img"` + `aria-label` so assistive tech announces it as a mic level
 *   meter, not a pile of empty divs.
 *
 * Design system: token palette only (`bg-accent` when speech is detected,
 * `bg-muted` when below the VAD floor), no hardcoded colors, no icons. Sized to
 * the composer line height so it never shifts layout.
 */

import * as React from "react";

import type { MicLevel } from "../../../hooks/useVoiceChat";
import { cn } from "../../../lib/utils";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Self-contained `prefers-reduced-motion` reader. Kept local (rather than
 * pulling motion/react's `useReducedMotion`) so the waveform's reduced-motion
 * fallback is deterministically testable via a `matchMedia` stub and carries no
 * animation-library dependency. SSR/no-matchMedia hosts default to "not
 * reduced" (the animated variant is the richer default); the subscription keeps
 * it live if the user flips the OS setting mid-session.
 */
function usePrefersReducedMotion(): boolean {
  const getMatch = React.useCallback((): boolean => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  }, []);

  const [reduced, setReduced] = React.useState<boolean>(getMatch);

  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(mql.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    // Older Safari exposes only addListener/removeListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return reduced;
}

export interface MicWaveformProps {
  /**
   * Subscribe to live mic amplitude. Returns an unsubscribe fn. Typically
   * `voice.subscribeMicLevel` from {@link useVoiceChat}. When absent (a backend
   * with no PCM stream, e.g. browser SpeechRecognition / native TalkMode), the
   * component renders its idle baseline and never animates.
   */
  subscribeMicLevel?: (listener: (level: MicLevel) => void) => () => void;
  /**
   * Whether capture is currently live. Bars only react while `active`; on
   * `active → false` the buffer decays back to the idle baseline. Lets the
   * component mount ahead of / linger after a turn without flicker.
   */
  active: boolean;
  /** Bar count. Default 28 — dense enough to read as a waveform, small enough
   * to sit inside the composer line without layout cost. */
  barCount?: number;
  /**
   * RMS level treated as the "speech detected" floor for the accent/muted
   * color. Defaults to the capture layer's `speechRmsThreshold` (0.003). Ties
   * the visual into the same VAD threshold that gates transcription.
   */
  speechFloor?: number;
  /** Force the static (non-scrolling) fallback regardless of motion pref. */
  staticFallback?: boolean;
  className?: string;
  /** Test/automation hook. */
  "data-testid"?: string;
}

/** Default VAD RMS floor — mirrors DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold. */
const DEFAULT_SPEECH_FLOOR = 0.003;
const DEFAULT_BAR_COUNT = 28;
/**
 * RMS is small (speech peaks well under 0.3 in the normalized PCM range); scale
 * it up so bars use their full height, then clamp. Empirically 6× lifts normal
 * conversational speech (~0.03-0.12 rms) to a readable 0.2-0.7 fill.
 */
const RMS_VISUAL_GAIN = 6;
const MIN_BAR_SCALE = 0.08; // never fully collapse a bar (keeps the row legible)

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Map a raw RMS sample to a [MIN_BAR_SCALE, 1] bar scale. */
function levelToScale(rms: number): number {
  const scaled = clamp01(rms * RMS_VISUAL_GAIN);
  return MIN_BAR_SCALE + scaled * (1 - MIN_BAR_SCALE);
}

export function MicWaveform({
  subscribeMicLevel,
  active,
  barCount = DEFAULT_BAR_COUNT,
  speechFloor = DEFAULT_SPEECH_FLOOR,
  staticFallback = false,
  className,
  "data-testid": dataTestId,
}: MicWaveformProps): React.ReactElement | null {
  const prefersReduced = usePrefersReducedMotion();
  const useStatic = staticFallback || prefersReduced;

  // Coarse speech-vs-silence flag — the ONLY React state driven by the level,
  // and it only flips on a threshold crossing (see the rAF loop), so it can't
  // re-render per sample.
  const [speechDetected, setSpeechDetected] = React.useState(false);

  // Level-presence gate: the waveform only mounts once a real amplitude sample
  // has arrived. `subscribeMicLevel` is always a concrete function on the voice
  // state, but the browser-SpeechRecognition and native-TalkMode backends own
  // no PCM stream and NEVER emit a level — for those, `hasLevel` stays false and
  // the component renders nothing, so we never show a permanently-idle meter
  // that (mis)implies the mic is silent. Flips true exactly once per active
  // turn, on the first sample; resets when capture ends.
  const [hasLevel, setHasLevel] = React.useState(false);
  const hasLevelRef = React.useRef(false);

  // Rolling ring buffer of bar scales (newest at the end). Lives in a ref so
  // updates never re-render. Rebuilt when barCount changes.
  const scalesRef = React.useRef<number[]>([]);
  if (scalesRef.current.length !== barCount) {
    scalesRef.current = new Array(barCount).fill(MIN_BAR_SCALE);
  }
  // Latest measured level, written by the subscription, read by the rAF loop.
  const latestRef = React.useRef<number>(0);
  // The bar DOM nodes we mutate directly (animated variant only).
  const barElsRef = React.useRef<(HTMLSpanElement | null)[]>([]);
  // The static-fallback fill node (static variant only).
  const staticFillRef = React.useRef<HTMLSpanElement | null>(null);
  const rafRef = React.useRef<number>(0);
  const speechRef = React.useRef(false);

  // Subscribe to the level stream. Stores the latest rms in a ref only — the
  // rAF loop below is what consumes it, so a fast source never schedules work
  // beyond one animation frame.
  React.useEffect(() => {
    if (!active || !subscribeMicLevel) {
      latestRef.current = 0;
      // Reset the presence gate so a fresh turn re-arms it; a non-PCM backend
      // that never emitted keeps it false and the component stays unmounted.
      hasLevelRef.current = false;
      setHasLevel(false);
      return;
    }
    const unsubscribe = subscribeMicLevel((level) => {
      latestRef.current = level.rms;
      // First real sample of this turn → reveal the waveform. Backends without a
      // PCM stream never reach here, so they never mount the meter.
      if (!hasLevelRef.current) {
        hasLevelRef.current = true;
        setHasLevel(true);
      }
    });
    return unsubscribe;
  }, [active, subscribeMicLevel]);

  // Single rAF loop: consumes the latest level, advances the ring buffer, and
  // writes each bar's transform (or the static fill width) directly to the DOM.
  // No React re-render happens here except the throttled speech flag.
  React.useEffect(() => {
    if (!active) {
      // Decay to baseline once, so a stopped turn doesn't freeze mid-waveform.
      const scales = scalesRef.current;
      for (let i = 0; i < scales.length; i += 1) scales[i] = MIN_BAR_SCALE;
      const els = barElsRef.current;
      for (const el of els) {
        if (el) el.style.transform = `scaleY(${MIN_BAR_SCALE})`;
      }
      if (staticFillRef.current) {
        staticFillRef.current.style.width = "0%";
      }
      if (speechRef.current) {
        speechRef.current = false;
        setSpeechDetected(false);
      }
      return;
    }

    let running = true;
    const tick = (): void => {
      if (!running) return;
      const rms = latestRef.current;

      // Throttled speech-vs-silence flag: only setState on a crossing.
      const nowSpeech = rms >= speechFloor;
      if (nowSpeech !== speechRef.current) {
        speechRef.current = nowSpeech;
        setSpeechDetected(nowSpeech);
      }

      if (useStatic) {
        // Static variant: smooth width, no scrolling. Blend toward the target
        // so it reads as a level meter rather than a jittery bar.
        const target = clamp01(rms * RMS_VISUAL_GAIN) * 100;
        const fill = staticFillRef.current;
        if (fill) {
          const prev = parseFloat(fill.style.width) || 0;
          const next = prev + (target - prev) * 0.35;
          fill.style.width = `${next.toFixed(1)}%`;
        }
      } else {
        // Scrolling variant: shift the ring buffer left, push the newest scale.
        const scales = scalesRef.current;
        scales.shift();
        scales.push(levelToScale(rms));
        const els = barElsRef.current;
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i];
          if (el)
            el.style.transform = `scaleY(${(scales[i] ?? MIN_BAR_SCALE).toFixed(3)})`;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [active, useStatic, speechFloor]);

  const colorClass = speechDetected ? "bg-accent" : "bg-muted";
  const ariaLabel = active
    ? speechDetected
      ? "Microphone level: speech detected"
      : "Microphone level: listening, quiet"
    : "Microphone level: idle";

  // Presence gate: render nothing until a real level has been received this
  // turn. Keeps the meter off entirely for non-PCM backends (browser
  // SpeechRecognition / native TalkMode) that are "listening" but emit no
  // amplitude — avoids a misleading permanently-idle bar and its layout cost.
  if (!hasLevel) {
    return null;
  }

  if (useStatic) {
    // Reduced-motion fallback: a single static level bar (no scroll, no pulse).
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        data-testid={dataTestId ?? "chat-composer-mic-waveform"}
        data-variant="static"
        data-active={active ? "true" : "false"}
        data-speech={speechDetected ? "true" : "false"}
        className={cn(
          "relative inline-flex h-4 w-16 items-center overflow-hidden rounded-full bg-muted/30",
          className,
        )}
      >
        <span
          ref={staticFillRef}
          aria-hidden="true"
          className={cn(
            "block h-full rounded-full transition-none",
            colorClass,
          )}
          style={{ width: "0%" }}
        />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      data-testid={dataTestId ?? "chat-composer-mic-waveform"}
      data-variant="bars"
      data-active={active ? "true" : "false"}
      data-speech={speechDetected ? "true" : "false"}
      data-bar-count={barCount}
      className={cn("inline-flex h-4 items-center gap-px", className)}
    >
      {Array.from({ length: barCount }, (_, i) => (
        <span
          // The bar array is a fixed-length positional strip: bar `i` is always
          // the same slot (leftmost..rightmost), never reordered/inserted, so the
          // index IS its stable identity. Its content is mutated imperatively via
          // the ref below, not by React reconciliation, so an index key is
          // correct here (not the usual reorder footgun).
          // biome-ignore lint/suspicious/noArrayIndexKey: positional fixed-length bar strip, index is stable identity
          key={i}
          ref={(el) => {
            barElsRef.current[i] = el;
          }}
          aria-hidden="true"
          className={cn(
            "block h-full w-0.5 origin-center rounded-full",
            colorClass,
          )}
          style={{ transform: `scaleY(${MIN_BAR_SCALE})` }}
        />
      ))}
    </span>
  );
}
