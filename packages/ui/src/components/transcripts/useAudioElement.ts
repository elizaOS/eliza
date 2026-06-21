/**
 * useAudioElement — a thin, framework-side wrapper over one `<audio>` element
 * for the Transcripts player (#8789). Exposes play state + the current position
 * (in ms, the unit the transcript timings use) and a `seekMs`, all driven by the
 * element's own `timeupdate`/`loadedmetadata`/`play`/`pause`/`ended` events. The
 * component owns the `<audio>` tag and passes `audioRef` to it.
 */

import * as React from "react";

export interface AudioElementApi {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  playing: boolean;
  /** Current playback position in ms (from audio start). */
  currentMs: number;
  /** Total duration in ms (0 until metadata loads / when unknown). */
  durationMs: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seekMs(ms: number): void;
}

export function useAudioElement(): AudioElementApi {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [currentMs, setCurrentMs] = React.useState(0);
  const [durationMs, setDurationMs] = React.useState(0);

  React.useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrentMs(Math.round(el.currentTime * 1000));
    const onMeta = () =>
      setDurationMs(
        Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
      );
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    onMeta();
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, []);

  const play = React.useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    // play() rejects under autoplay policy without a user gesture — reflect
    // that honestly in `playing` rather than leaving a stuck "playing" state.
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => setPlaying(false));
  }, []);

  const pause = React.useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = React.useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) play();
    else pause();
  }, [play, pause]);

  const seekMs = React.useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms) / 1000;
    setCurrentMs(Math.max(0, Math.round(ms)));
  }, []);

  return {
    audioRef,
    playing,
    currentMs,
    durationMs,
    play,
    pause,
    toggle,
    seekMs,
  };
}
