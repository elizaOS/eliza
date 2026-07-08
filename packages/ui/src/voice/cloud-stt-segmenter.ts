/**
 * Incremental capture segmenter for chunked-segment cloud STT (voice V2a —
 * Phase 1 streaming ASR, per VOICE-STREAMING-DESIGN §2.5).
 *
 * Runs alongside the existing per-frame auto-stop VAD in the WAV recorder. As
 * mono PCM16 frames arrive it decides WHEN to cut a segment boundary so the
 * captured-so-far speech can be POSTed to the batch cloud STT endpoint mid-
 * utterance (instead of only the whole WAV at stop). Cutting segments during
 * speech overlaps the transcription round-trips with the user still talking, so
 * the final speech-end→transcript leg shrinks to "transcribe the last ~1s tail
 * + stitch" rather than "transcribe the entire utterance".
 *
 * The segmenter is PURE state-machine logic over frames + timestamps — it never
 * touches the AudioContext / WAV encoding (the recorder owns that). It only
 * answers, per frame, "cut a segment boundary now?" plus tracks a small trailing
 * overlap so consecutive segments share ~200ms of audio (seam continuity; the
 * stitcher dedups the overlapped words — see cloud-stt-stitcher.ts).
 *
 * Boundary policy:
 *   - Emit a boundary after ~`segmentMs` of buffered SPEECH (default 1000ms),
 *     so long utterances pipeline as ~1s chunks.
 *   - Emit a boundary on a short intra-utterance PAUSE (`pauseMs`, default
 *     350ms) — a softer threshold than the end-of-turn VAD silence (650ms) — so
 *     a natural clause break flushes a clean segment rather than splitting mid-
 *     word. (The end-of-turn VAD still fires the final boundary + stop.)
 *   - Never emit a boundary before `minSegmentMs` of speech (default 400ms):
 *     avoids a spray of tiny 1-2 word segments on choppy speech, each costing a
 *     round-trip.
 *
 * Reuses the same energy VAD (`measurePcmAudio` + thresholds) as the auto-stop
 * detector so "speech" here means the same thing it does for turn-end.
 */

import {
  DEFAULT_LOCAL_ASR_AUTO_STOP,
  measurePcmAudio,
  POST_TTS_ECHO_THRESHOLD_MULTIPLIER,
} from "./local-asr-capture";
import {
  DEFAULT_POST_TTS_COOLDOWN_MS,
  isTtsEchoGateActive as sharedTtsEchoGateActive,
} from "./tts-playback-activity";

export interface CloudSttSegmenterOptions {
  /** Target buffered-speech duration per segment before cutting. Default 1000ms. */
  segmentMs?: number;
  /** Minimum buffered speech before ANY boundary may fire. Default 400ms. */
  minSegmentMs?: number;
  /** Intra-utterance pause that flushes a clean segment boundary. Default 350ms.
   * Softer than the end-of-turn silence window so a clause break cuts a segment
   * without ending the turn. */
  pauseMs?: number;
  /** Trailing audio (ms) to carry into the NEXT segment for seam continuity.
   * The stitcher dedups the overlapped words. Default 200ms. */
  overlapMs?: number;
  /** Speech RMS gate (shared with the auto-stop VAD default). */
  speechRmsThreshold?: number;
  /** Speech peak gate (shared with the auto-stop VAD default). */
  speechPeakThreshold?: number;
  /** Post-TTS cooldown window for the echo gate. Default 1500ms. */
  postTtsCooldownMs?: number;
  /** Injectable playback-activity probe (tests). */
  isTtsEchoGateActive?: (nowMs: number) => boolean;
}

/** Per-frame decision from the segmenter. */
export interface CloudSttSegmenterUpdate {
  /**
   * True on the frame that closes a segment. The recorder should encode the
   * frames buffered since the last boundary (minus the retained overlap tail)
   * to a WAV and POST it as segment `seq`.
   */
  boundary: boolean;
  /** True when THIS frame carried detected speech (for the recorder's buffer gating). */
  speech: boolean;
}

export interface CloudSttSegmenterConfig {
  segmentMs: number;
  minSegmentMs: number;
  pauseMs: number;
  overlapMs: number;
  speechRmsThreshold: number;
  speechPeakThreshold: number;
}

export const DEFAULT_CLOUD_STT_SEGMENTER: CloudSttSegmenterConfig = {
  segmentMs: 1000,
  minSegmentMs: 400,
  pauseMs: 350,
  overlapMs: 200,
  speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
  speechPeakThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechPeakThreshold,
};

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Create a per-frame segmenter. Feed every captured mono frame through the
 * returned function; it returns `{boundary, speech}`. `null` config-less
 * variant is not offered — the segmenter is only constructed when chunked
 * streaming is enabled for the capture.
 */
export function createCloudSttSegmenter(
  options: CloudSttSegmenterOptions = {},
): {
  update: (pcm: Float32Array, sampleTimeMs?: number) => CloudSttSegmenterUpdate;
  config: CloudSttSegmenterConfig;
} {
  const config: CloudSttSegmenterConfig = {
    ...DEFAULT_CLOUD_STT_SEGMENTER,
    ...Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined),
    ),
  };
  const cooldownMs = options.postTtsCooldownMs ?? DEFAULT_POST_TTS_COOLDOWN_MS;
  const echoGateActive =
    options.isTtsEchoGateActive ??
    ((atMs: number) => sharedTtsEchoGateActive(atMs, cooldownMs));

  // Accumulated SPEECH time within the current segment (ms). Silence frames do
  // not advance this — a segment is "~1s of speech", not "~1s of wall time".
  let segmentSpeechMs = 0;
  // Wall-clock timestamp of the last speech frame, for pause detection.
  let lastSpeechAtMs: number | null = null;
  // Whether the current segment has ANY speech yet (so a pure-silence lead-in
  // never fires a boundary).
  let segmentHasSpeech = false;
  // Approx per-frame duration inferred from the frame size + assumed 16k rate;
  // refined once we see real frame lengths.
  let lastFrameTimeMs: number | null = null;

  const update = (
    pcm: Float32Array,
    sampleTimeMs = nowMs(),
  ): CloudSttSegmenterUpdate => {
    const stats = measurePcmAudio(pcm);
    const gate = echoGateActive(sampleTimeMs)
      ? POST_TTS_ECHO_THRESHOLD_MULTIPLIER
      : 1;
    const speech =
      stats.rms >= config.speechRmsThreshold * gate ||
      stats.peak >= config.speechPeakThreshold * gate;

    // Advance the segment's speech clock by the elapsed wall time since the
    // previous frame, but only while speech is active (accumulates spoken
    // duration, not silence).
    const frameDeltaMs =
      lastFrameTimeMs === null
        ? 0
        : Math.max(0, sampleTimeMs - lastFrameTimeMs);
    lastFrameTimeMs = sampleTimeMs;

    if (speech) {
      segmentHasSpeech = true;
      segmentSpeechMs += frameDeltaMs;
      lastSpeechAtMs = sampleTimeMs;
    }

    if (!segmentHasSpeech || segmentSpeechMs < config.minSegmentMs) {
      return { boundary: false, speech };
    }

    // Cut on accumulated-speech length.
    const lengthCut = segmentSpeechMs >= config.segmentMs;
    // Cut on an intra-utterance pause (a clause break), once we have min speech.
    const pauseCut =
      !speech &&
      lastSpeechAtMs !== null &&
      sampleTimeMs - lastSpeechAtMs >= config.pauseMs;

    if (lengthCut || pauseCut) {
      // Reset for the next segment. Keep no speech carried — the recorder
      // retains the raw audio overlap; the segmenter's speech clock restarts.
      segmentSpeechMs = 0;
      segmentHasSpeech = false;
      lastSpeechAtMs = null;
      return { boundary: true, speech };
    }

    return { boundary: false, speech };
  };

  return { update, config };
}
