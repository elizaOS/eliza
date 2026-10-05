/**
 * End-of-utterance detection for the streaming-audio VAD state machine.
 *
 * `StreamingAudioCaptureService` uses `silenceTimer` both as a live handle and
 * as the "is a silence countdown armed?" flag through the `if (!this.silenceTimer)`
 * re-arm guard. This deterministic harness drives the private `processAudioChunk`
 * with synthetic PCM buffers under fake timers — no microphone — to prove that a
 * speech -> pause -> speech -> pause sequence still schedules `endSpeech()`, so
 * `speechEnd` fires and `processFinalTranscription()` reaches the model. The
 * regression: the reset branch cleared the timer without nulling it, leaving a
 * stale truthy handle that permanently blocked re-arming after the first
 * intra-utterance pause and silently dropped the whole utterance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StreamingAudioCaptureService,
  type StreamingAudioConfig,
} from "./audio-capture-stream";

const CHUNK_BYTES = 200;
const SILENCE_TIMEOUT = 1000;

/** A 200-byte S16LE buffer whose every sample is `value`. */
function pcmChunk(value: number): Buffer {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 2) {
    buffer.writeInt16LE(value, i);
  }
  return buffer;
}

/** High-energy speech (RMS well above the VAD threshold). */
const SPEECH = () => pcmChunk(30000);
/** Silence (zero energy, below the VAD threshold). */
const SILENCE = () => pcmChunk(0);

type Harness = {
  service: StreamingAudioCaptureService;
  useModel: ReturnType<typeof vi.fn>;
  feed: (chunk: Buffer) => void;
  silenceTimerHandle: () => NodeJS.Timeout | null;
};

function makeHarness(overrides: Partial<StreamingAudioConfig> = {}): Harness {
  const useModel = vi.fn().mockResolvedValue("final transcription");
  const runtime = {
    agentId: "test-agent",
    getService: () => null,
    reportError: () => {},
    useModel,
  } as unknown as ConstructorParameters<typeof StreamingAudioCaptureService>[0];

  const service = new StreamingAudioCaptureService(runtime, {
    enabled: true,
    silenceTimeout: SILENCE_TIMEOUT,
    vadThreshold: 0.01,
    ...overrides,
  });

  const internals = service as unknown as {
    processAudioChunk: (chunk: Buffer) => void;
    transcriptionInProgress: boolean;
    silenceTimer: NodeJS.Timeout | null;
  };
  // Force transcription "in progress" so the streaming-transcription path is
  // inert and the test isolates the pure VAD/silence-timer state machine.
  internals.transcriptionInProgress = true;

  return {
    service,
    useModel,
    feed: (chunk: Buffer) => internals.processAudioChunk(chunk),
    silenceTimerHandle: () => internals.silenceTimer,
  };
}

describe("StreamingAudioCaptureService end-of-utterance detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("emits speechEnd once after speech -> pause -> speech -> pause", async () => {
    const { service, useModel, feed } = makeHarness();
    const speechEnd = vi.fn();
    service.on("speechEnd", speechEnd);

    // Utterance with an intra-utterance pause: speak, breathe, keep speaking,
    // then actually stop. The middle silence must not permanently disarm the
    // end-of-speech countdown.
    feed(SPEECH());
    feed(SILENCE());
    feed(SPEECH());
    feed(SILENCE());

    // The trailing silence must have re-armed the end-of-speech countdown.
    expect(speechEnd).toHaveBeenCalledTimes(0);

    // Advance just past the configured timeout (not the hardcoded 1500 default),
    // so a build that ignored `config.silenceTimeout` would not fire here.
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT + 100);

    expect(speechEnd).toHaveBeenCalledTimes(1);
    // processFinalTranscription() ran and reached the transcription model.
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(service.isSpeechActive()).toBe(false);
  });

  it("emits speechEnd once for a simple speech -> silence utterance", async () => {
    const { service, useModel, feed } = makeHarness();
    const speechEnd = vi.fn();
    service.on("speechEnd", speechEnd);

    feed(SPEECH());
    feed(SILENCE());

    expect(speechEnd).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT + 100);

    expect(speechEnd).toHaveBeenCalledTimes(1);
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("re-arms rather than double-arms the silence timer across a pause", async () => {
    const { service, feed, silenceTimerHandle } = makeHarness();
    const speechEnd = vi.fn();
    service.on("speechEnd", speechEnd);

    feed(SPEECH());
    feed(SILENCE());
    const firstArmed = silenceTimerHandle();
    expect(firstArmed).not.toBeNull();

    // Resumed speech must clear AND null the pending countdown so the guard can
    // re-arm on the next pause instead of being permanently blocked.
    feed(SPEECH());
    expect(silenceTimerHandle()).toBeNull();

    feed(SILENCE());
    const secondArmed = silenceTimerHandle();
    expect(secondArmed).not.toBeNull();
    // A genuinely re-armed (not stale) handle fires exactly one endSpeech.
    expect(secondArmed).not.toBe(firstArmed);

    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT + 100);
    expect(speechEnd).toHaveBeenCalledTimes(1);
    // The fired timer is cleared back to null by endSpeech().
    expect(silenceTimerHandle()).toBeNull();
  });

  it("does not end speech from a stale countdown when the pause is followed by more speech", async () => {
    const { service, feed } = makeHarness();
    const speechEnd = vi.fn();
    service.on("speechEnd", speechEnd);

    // Pin the *cancel* half of the invariant: resuming speech must clear the
    // pending countdown, not merely null the handle. Time passes during the
    // pause, then the user resumes and keeps talking past the moment the first
    // countdown would have expired. A stale-but-live timer (nulled without
    // clearing) would fire mid-speech and drop the utterance.
    feed(SPEECH());
    feed(SILENCE());
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT - 200);
    feed(SPEECH());
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT);
    feed(SPEECH());

    expect(speechEnd).toHaveBeenCalledTimes(0);
    expect(service.isSpeechActive()).toBe(true);
  });
});
