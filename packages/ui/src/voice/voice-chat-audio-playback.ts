/**
 * Decodes and plays generated voice bytes through the shared Web Audio graph.
 * Provider fetchers own authentication and caching; this module owns the one
 * analyser, playback-reference tap, timeout, teardown, and telemetry lifecycle
 * that every decoded-audio provider must follow.
 */

import { ttsDebug, ttsDebugTextPreview } from "../utils/tts-debug";
import {
  type PlaybackFramePump,
  type PlaybackFrameTap,
  PlaybackTapLifecycle,
} from "./playback-frame-pump";
import {
  type SpeakTask,
  toArrayBuffer,
  type VoicePlaybackStartEvent,
} from "./voice-chat-types";

interface MutableCell<T> {
  current: T;
}

export interface DecodedVoicePlaybackOptions {
  context: AudioContext;
  audioBytes: Uint8Array;
  generation: number;
  generationRef: MutableCell<number>;
  provider: VoicePlaybackStartEvent["provider"];
  text: string;
  task: SpeakTask;
  cached: boolean;
  analyserRef: MutableCell<AnalyserNode | null>;
  timeDomainDataRef: MutableCell<Float32Array<ArrayBuffer> | null>;
  audioSourceRef: MutableCell<AudioBufferSourceNode | null>;
  playbackFrameTapRef: MutableCell<PlaybackFrameTap | null>;
  activeTaskFinishRef: MutableCell<(() => void) | null>;
  speechTimeoutRef: MutableCell<ReturnType<typeof setTimeout> | null>;
  getPlaybackFramePump: () => PlaybackFramePump;
  clearSpeechTimers: () => void;
  emitPlaybackStart: (event: VoicePlaybackStartEvent) => void;
  tracePlayback?: boolean;
}

export async function playDecodedVoiceAudio({
  context,
  audioBytes,
  generation,
  generationRef,
  provider,
  text,
  task,
  cached,
  analyserRef,
  timeDomainDataRef,
  audioSourceRef,
  playbackFrameTapRef,
  activeTaskFinishRef,
  speechTimeoutRef,
  getPlaybackFramePump,
  clearSpeechTimers,
  emitPlaybackStart,
  tracePlayback = false,
}: DecodedVoicePlaybackOptions): Promise<void> {
  if (generation !== generationRef.current) return;
  const audioBuffer = await context.decodeAudioData(toArrayBuffer(audioBytes));
  if (generation !== generationRef.current) return;

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  analyserRef.current = analyser;
  timeDomainDataRef.current = new Float32Array(
    new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
  );

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(context.destination);
  audioSourceRef.current = source;

  // Audible playback must not wait indefinitely for the optional visualizer
  // worklet on first use in a busy WebView.
  const tapPromise = getPlaybackFramePump()
    .tapSource(context, source, audioBuffer)
    .catch((error) => {
      // error-policy:J4 Playback-reference capture is optional; audio remains audible.
      ttsDebug("playback-reference:tap-attach-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const tapLifecycle = new PlaybackTapLifecycle(playbackFrameTapRef);
  await tapLifecycle.attach(tapPromise);

  await new Promise<void>((resolve) => {
    let finished = false;
    const playStartMs = performance.now();
    let wrappedFinish: (() => void) | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      tapLifecycle.finish();
      if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) {
        activeTaskFinishRef.current = null;
      }
      if (audioSourceRef.current === source) {
        audioSourceRef.current = null;
      }
      source.onended = null;
      try {
        source.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:source-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        analyser.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:analyser-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      clearSpeechTimers();
      resolve();
    };

    wrappedFinish = () => {
      if (tracePlayback) {
        ttsDebug("play:web-audio:end", {
          provider,
          segment: task.segment,
          elapsedMs: Math.round(performance.now() - playStartMs),
        });
      }
      finish();
    };

    if (tracePlayback) {
      ttsDebug("play:web-audio:start", {
        provider,
        segment: task.segment,
        append: task.append,
        cached,
        textChars: text.length,
        preview: ttsDebugTextPreview(text),
        durationSecApprox: Math.round(audioBuffer.duration * 100) / 100,
      });
    }

    activeTaskFinishRef.current = wrappedFinish;
    source.onended = wrappedFinish;
    tapLifecycle.start(playStartMs);
    speechTimeoutRef.current = setTimeout(
      wrappedFinish,
      Math.max(2500, Math.ceil(audioBuffer.duration * 1000) + 1200),
    );

    source.start(0);
    emitPlaybackStart({
      text,
      segment: task.segment,
      provider,
      cached,
      startedAtMs: playStartMs,
      ...task.telemetry,
    });
  });
}
