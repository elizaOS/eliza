/**
 * Browser-context per-speaker audio capture.
 *
 * Runs a capture script inside the meeting page (via `page.evaluate`) that
 * discovers live media elements (audio/video with a MediaStream srcObject +
 * enabled audio tracks), attaches an AudioContext({sampleRate: 16000}) +
 * ScriptProcessor(4096) to each, and forwards Float32 chunks (peak > 0.005)
 * to the Node side through an exposed binding. A periodic rescan picks up late
 * joiners / recycled elements.
 *
 * Google Meet delivers one media element per participant (per-stream keys map
 * to speakers). Microsoft Teams delivers a single mixed element — pass
 * `mixedSingleElement: true` so the capture uses one fixed stream key and
 * leaves speaker routing to caption/DOM signals upstream.
 *
 * Node side applies an RMS energy gate (a coarse pre-filter, distinct from the
 * ASR-side VAD that lives in the pipeline layer) before forwarding to the sink.
 */

import type { Page } from "playwright-core";
import { logger } from "@elizaos/core";
import { MEETING_AUDIO_SAMPLE_RATE } from "../types.js";

/** Binding name the browser script calls with (streamIndex, Float32 payload). */
const AUDIO_BINDING = "__elizaMeetSpeakerAudio";
/** ScriptProcessor buffer size (Vexa-faithful). */
const BUFFER_SIZE = 4096;
/** Browser-side per-chunk peak gate — drop pure silence before crossing to Node. */
const BROWSER_PEAK_GATE = 0.005;
/**
 * Node-side RMS energy gate. Coarse pre-filter only; real VAD is the pipeline's
 * job. Chunks below this RMS are dropped before hitting the sink.
 */
const NODE_RMS_GATE = 0.004;

type SpeakerAudioEmit = (streamIndex: number, payload: number[]) => void;
type CaptureIntervalId = ReturnType<typeof setInterval>;

interface CaptureWindow extends Window {
  __elizaMeetSpeakerAudio?: SpeakerAudioEmit;
  __elizaMeetCaptureIntervals?: CaptureIntervalId[];
}

export interface SpeakerAudioCaptureOptions {
  /** Teams-style single mixed element: use one fixed stream key. */
  mixedSingleElement?: boolean;
  /** Called for each accepted chunk. Keyed by stream index (as string). */
  onChunk: (streamKey: string, samples: Float32Array) => void;
  /** Rescan interval for new media elements (ms). Default 15000. */
  rescanIntervalMs?: number;
}

/** Handle for tearing down a capture session. */
export interface SpeakerAudioCapture {
  stop(): Promise<void>;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Install per-speaker audio capture on `page`. Idempotent binding registration:
 * a second call on the same page reuses the existing binding.
 */
export async function startSpeakerAudioCapture(
  page: Page,
  opts: SpeakerAudioCaptureOptions,
): Promise<SpeakerAudioCapture> {
  const rescanIntervalMs = opts.rescanIntervalMs ?? 15_000;

  // Expose the Node-side sink binding. Playwright throws if a binding name is
  // already registered on the page — reuse it in that case.
  try {
    await page.exposeBinding(
      AUDIO_BINDING,
      (_source, streamIndex: number, payload: number[]) => {
        const samples = Float32Array.from(payload);
        if (rms(samples) < NODE_RMS_GATE) return;
        opts.onChunk(String(streamIndex), samples);
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("already registered")) throw err;
  }

  await page.evaluate(
    async ({ bufferSize, targetRate, peakGate, rescanMs, mixed }) => {
      const w = window as CaptureWindow;
      const emit = w.__elizaMeetSpeakerAudio;
      if (!emit) throw new Error("speaker audio binding is not registered");

      const liveAudioElements = (): HTMLMediaElement[] =>
        (Array.from(document.querySelectorAll("audio, video")) as HTMLMediaElement[]).filter((el) => {
          const src = (el as HTMLMediaElement).srcObject;
          if (!(src instanceof MediaStream)) return false;
          if (el.paused) return false;
          const tracks = src.getAudioTracks();
          return tracks.length > 0 && tracks.some((t) => t.enabled);
        });

      const connectedStreamIds = new Set<string>();
      let nextStreamIndex = 0;

      const connect = (el: HTMLMediaElement, index: number): boolean => {
        const stream = el.srcObject as MediaStream;
        if (!stream || stream.getAudioTracks().length === 0) return false;
        if (connectedStreamIds.has(stream.id)) return false;

        const ctx = new AudioContext({ sampleRate: targetRate });
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(bufferSize, 1, 1);

        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          const data = e.inputBuffer.getChannelData(0);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = data[i] < 0 ? -data[i] : data[i];
            if (v > peak) peak = v;
          }
          if (peak > peakGate) emit(index, Array.from(data));
        };

        source.connect(processor);
        // ScriptProcessor only fires while connected to a destination; a
        // zero-gain node keeps it silent so the bot never plays audio out.
        const gain = ctx.createGain();
        gain.gain.value = 0;
        processor.connect(gain);
        gain.connect(ctx.destination);

        connectedStreamIds.add(stream.id);
        const track = stream.getAudioTracks()[0];
        track.addEventListener("ended", () => connectedStreamIds.delete(stream.id));
        return true;
      };

      // Wait for at least one live element (retry up to 10x).
      let elements: HTMLMediaElement[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        elements = liveAudioElements();
        if (elements.length > 0) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (mixed) {
        // Single mixed element (Teams): always stream index 0.
        if (elements.length > 0) connect(elements[0], 0);
      } else {
        for (let i = 0; i < elements.length; i++) if (connect(elements[i], i)) {
          // index tracked via loop position
        }
        nextStreamIndex = elements.length;
      }

      const rescan = setInterval(() => {
        const current = liveAudioElements();
        if (mixed) {
          if (current.length > 0) connect(current[0], 0);
          return;
        }
        for (const el of current) {
          const stream = el.srcObject as MediaStream;
          if (stream && !connectedStreamIds.has(stream.id)) {
            if (connect(el, nextStreamIndex)) nextStreamIndex++;
          }
        }
      }, rescanMs);

      w.__elizaMeetCaptureIntervals = [...(w.__elizaMeetCaptureIntervals ?? []), rescan];
    },
    {
      bufferSize: BUFFER_SIZE,
      targetRate: MEETING_AUDIO_SAMPLE_RATE,
      peakGate: BROWSER_PEAK_GATE,
      rescanMs: rescanIntervalMs,
      mixed: opts.mixedSingleElement === true,
    },
  );

  logger.info("[SpeakerAudioCapture] browser-side capture installed");

  return {
    async stop() {
      if (page.isClosed()) return;
      try {
        await page.evaluate(() => {
          const w = window as CaptureWindow;
          for (const id of w.__elizaMeetCaptureIntervals ?? []) clearInterval(id);
          w.__elizaMeetCaptureIntervals = [];
        });
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "[SpeakerAudioCapture] stop() teardown failed",
        );
      }
    },
  };
}
