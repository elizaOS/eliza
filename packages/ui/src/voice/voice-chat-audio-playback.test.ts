/**
 * Unit coverage for `playDecodedVoiceAudio`, the shared decoded-TTS playback
 * lifecycle: generation gating before and during decode, analyser/source graph
 * wiring, the playback-reference tap lifecycle, guarded teardown on natural end
 * versus the speech-timeout fallback, and the playback-start event contract.
 * The module under test runs real; the Web Audio graph nodes and the frame-pump
 * tap are structural doubles standing in for their browser-only boundaries.
 */
import { describe, expect, it, vi } from "vitest";
import type { PlaybackFramePump } from "./playback-frame-pump";
import {
  type DecodedVoicePlaybackOptions,
  playDecodedVoiceAudio,
} from "./voice-chat-audio-playback";
import type { SpeakTask, VoicePlaybackStartEvent } from "./voice-chat-types";

interface FakeNode {
  connections: FakeNode[];
  disconnectCount: number;
  connect(target: FakeNode): FakeNode;
  disconnect(): void;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    connections: [],
    disconnectCount: 0,
    connect(target) {
      node.connections.push(target);
      return target;
    },
    disconnect() {
      node.disconnectCount += 1;
    },
  };
  return node;
}

interface FakeAnalyser extends FakeNode {
  fftSize: number;
  smoothingTimeConstant: number;
}

function makeAnalyser(): FakeAnalyser {
  const analyser: FakeAnalyser = {
    connections: [],
    disconnectCount: 0,
    fftSize: 0,
    smoothingTimeConstant: 0,
    connect(target) {
      analyser.connections.push(target);
      return target;
    },
    disconnect() {
      analyser.disconnectCount += 1;
    },
  };
  return analyser;
}

interface FakeSource extends FakeNode {
  buffer: unknown;
  onended: (() => void) | null;
  starts: unknown[];
  start(when?: number): void;
}

function makeSource(): FakeSource {
  const source: FakeSource = {
    connections: [],
    disconnectCount: 0,
    buffer: null,
    onended: null,
    starts: [],
    connect(target) {
      source.connections.push(target);
      return target;
    },
    disconnect() {
      source.disconnectCount += 1;
    },
    start(when?: number) {
      source.starts.push(when ?? 0);
    },
  };
  return source;
}

interface FakeTap {
  startCalls: Array<number | undefined>;
  stopCalls: Array<{ reset?: boolean; drain?: boolean } | undefined>;
  start(startTimestampMs?: number): void;
  stop(options?: { reset?: boolean; drain?: boolean }): Promise<void>;
}

function makeTap(): FakeTap {
  const tap: FakeTap = {
    startCalls: [],
    stopCalls: [],
    start(startTimestampMs?: number) {
      tap.startCalls.push(startTimestampMs);
    },
    async stop(options?: { reset?: boolean; drain?: boolean }) {
      tap.stopCalls.push(options);
    },
  };
  return tap;
}

interface FakeBuffer {
  duration: number;
}

function makeBuffer(durationSec: number): FakeBuffer {
  return { duration: durationSec };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected at least one recorded item");
  }
  return item;
}

function harness(buffer: FakeBuffer = makeBuffer(2)) {
  const generationRef = { current: 1 };
  const analyserRef: { current: FakeAnalyser | null } = { current: null };
  const timeDomainDataRef: { current: Float32Array<ArrayBuffer> | null } = {
    current: null,
  };
  const audioSourceRef: { current: FakeSource | null } = { current: null };
  const playbackFrameTapRef: { current: FakeTap | null } = { current: null };
  const activeTaskFinishRef: { current: (() => void) | null } = {
    current: null,
  };
  const speechTimeoutRef: { current: ReturnType<typeof setTimeout> | null } = {
    current: null,
  };

  const createdAnalysers: FakeAnalyser[] = [];
  const createdSources: FakeSource[] = [];
  const taps: FakeTap[] = [];
  const startedEvents: VoicePlaybackStartEvent[] = [];
  const destination = makeNode();
  const clearSpeechTimers = vi.fn();

  let holdDecode = false;
  let releaseDecode: (() => void) | null = null;

  const context = {
    destination,
    createAnalyser(): FakeAnalyser {
      const analyser = makeAnalyser();
      createdAnalysers.push(analyser);
      return analyser;
    },
    createBufferSource(): FakeSource {
      const source = makeSource();
      createdSources.push(source);
      return source;
    },
    decodeAudioData(): Promise<FakeBuffer> {
      if (!holdDecode) return Promise.resolve(buffer);
      return new Promise<FakeBuffer>((resolve) => {
        releaseDecode = () => resolve(buffer);
      });
    },
  };

  const pump = {
    tapSource: async (): Promise<FakeTap> => {
      const tap = makeTap();
      taps.push(tap);
      return tap;
    },
  };

  const task: SpeakTask = {
    text: "hello there",
    append: false,
    segment: "full",
    telemetry: { messageId: "m-1" },
  };

  function run(
    overrides?: Partial<DecodedVoicePlaybackOptions>,
  ): Promise<void> {
    return playDecodedVoiceAudio({
      context: context as unknown as AudioContext,
      audioBytes: new Uint8Array([1, 2, 3, 4]),
      generation: 1,
      generationRef,
      provider: "browser",
      text: task.text,
      task,
      cached: false,
      analyserRef:
        analyserRef as unknown as DecodedVoicePlaybackOptions["analyserRef"],
      timeDomainDataRef,
      audioSourceRef:
        audioSourceRef as unknown as DecodedVoicePlaybackOptions["audioSourceRef"],
      playbackFrameTapRef:
        playbackFrameTapRef as unknown as DecodedVoicePlaybackOptions["playbackFrameTapRef"],
      activeTaskFinishRef,
      speechTimeoutRef,
      getPlaybackFramePump: () => pump as unknown as PlaybackFramePump,
      clearSpeechTimers,
      emitPlaybackStart: (event) => startedEvents.push(event),
      ...overrides,
    });
  }

  return {
    generationRef,
    analyserRef,
    timeDomainDataRef,
    audioSourceRef,
    playbackFrameTapRef,
    activeTaskFinishRef,
    speechTimeoutRef,
    createdAnalysers,
    createdSources,
    destination,
    taps,
    startedEvents,
    clearSpeechTimers,
    holdNextDecode: () => {
      holdDecode = true;
    },
    releaseDecode: () => {
      releaseDecode?.();
    },
    run,
  };
}

describe("playDecodedVoiceAudio", () => {
  it("returns before decoding when the generation is already stale", async () => {
    const h = harness();
    h.generationRef.current = 7;

    await h.run({ generation: 1 });

    expect(h.createdAnalysers).toHaveLength(0);
    expect(h.createdSources).toHaveLength(0);
    expect(h.startedEvents).toHaveLength(0);
    expect(h.analyserRef.current).toBeNull();
    expect(h.audioSourceRef.current).toBeNull();
  });

  it("abandons the clip when the generation goes stale during decode", async () => {
    const h = harness();
    h.holdNextDecode();

    const pending = h.run({ generation: 1 });
    await settle();
    h.generationRef.current = 99;
    h.releaseDecode();
    await pending;

    expect(h.createdAnalysers).toHaveLength(0);
    expect(h.createdSources).toHaveLength(0);
    expect(h.startedEvents).toHaveLength(0);
    expect(h.analyserRef.current).toBeNull();
    expect(h.audioSourceRef.current).toBeNull();
  });

  it("wires source into analyser into destination and publishes the refs", async () => {
    const h = harness();
    const pending = h.run();
    await settle();

    expect(h.createdSources).toHaveLength(1);
    const source = first(h.createdSources);
    const analyser = first(h.createdAnalysers);
    expect(analyser.fftSize).toBe(2048);
    expect(analyser.smoothingTimeConstant).toBe(0.8);
    expect(source.connections).toContain(analyser);
    expect(analyser.connections).toContain(h.destination);
    expect(source.starts).toEqual([0]);
    expect(h.analyserRef.current).toBe(analyser);
    expect(h.timeDomainDataRef.current?.length).toBe(2048);
    expect(h.audioSourceRef.current).toBe(source);

    h.activeTaskFinishRef.current?.();
    await pending;
  });

  it("emits the playback-start event with task telemetry spread in", async () => {
    const h = harness();
    const pending = h.run();
    await settle();
    h.activeTaskFinishRef.current?.();
    await pending;

    expect(h.startedEvents).toHaveLength(1);
    const event = first(h.startedEvents);
    expect(event.text).toBe("hello there");
    expect(event.segment).toBe("full");
    expect(event.provider).toBe("browser");
    expect(event.cached).toBe(false);
    expect(typeof event.startedAtMs).toBe("number");
    expect(event.messageId).toBe("m-1");
  });

  it("starts the tap once playback begins and stops it with reset on finish", async () => {
    const h = harness();
    const pending = h.run();
    await settle();

    expect(h.taps).toHaveLength(1);
    const tap = first(h.taps);
    expect(tap.startCalls).toHaveLength(1);
    expect(h.playbackFrameTapRef.current).toBe(tap);

    h.activeTaskFinishRef.current?.();
    await pending;

    expect(tap.stopCalls).toEqual([{ reset: true }]);
    expect(h.playbackFrameTapRef.current).toBeNull();
  });

  it("tears down the graph, clears speech timers, and clears its own refs on natural end", async () => {
    const h = harness();
    const pending = h.run();
    await settle();
    const source = first(h.createdSources);
    const analyser = first(h.createdAnalysers);

    source.onended?.();
    await pending;

    expect(h.clearSpeechTimers).toHaveBeenCalledTimes(1);
    expect(h.activeTaskFinishRef.current).toBeNull();
    expect(h.audioSourceRef.current).toBeNull();
    expect(source.disconnectCount).toBe(1);
    expect(analyser.disconnectCount).toBe(1);
  });

  it("leaves a foreign activeTaskFinishRef untouched on teardown", async () => {
    const h = harness();
    const pending = h.run();
    await settle();

    const foreign = vi.fn();
    h.activeTaskFinishRef.current = foreign;
    first(h.createdSources).onended?.();
    await pending;

    expect(h.activeTaskFinishRef.current).toBe(foreign);
  });

  it("leaves a foreign audioSourceRef untouched on teardown", async () => {
    const h = harness();
    const pending = h.run();
    await settle();

    const foreign = makeSource();
    h.audioSourceRef.current =
      foreign as unknown as typeof h.audioSourceRef.current;
    first(h.createdSources).onended?.();
    await pending;

    expect(h.audioSourceRef.current).toBe(foreign);
  });

  it("treats a second finish invocation as a no-op", async () => {
    const h = harness();
    const pending = h.run();
    await settle();
    const source = first(h.createdSources);
    const finisher = h.activeTaskFinishRef.current;

    source.onended?.();
    await pending;
    expect(finisher).not.toBeNull();
    finisher?.();

    expect(first(h.taps).stopCalls).toHaveLength(1);
    expect(source.disconnectCount).toBe(1);
    expect(h.clearSpeechTimers).toHaveBeenCalledTimes(1);
  });

  it("keeps a tap attachment failure audible-only and finishes cleanly", async () => {
    const h = harness();
    const failingPump = {
      tapSource: () => Promise.reject(new Error("worklet exploded")),
    };
    const pending = h.run({
      getPlaybackFramePump: () => failingPump as unknown as PlaybackFramePump,
    });
    await settle();

    expect(h.playbackFrameTapRef.current).toBeNull();
    expect(h.startedEvents).toHaveLength(1);

    first(h.createdSources).onended?.();
    await pending;

    expect(h.clearSpeechTimers).toHaveBeenCalledTimes(1);
    expect(h.audioSourceRef.current).toBeNull();
  });

  it("finishes through the speech timeout at duration*1000+1200ms", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(makeBuffer(2));
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.speechTimeoutRef.current).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3199);
      expect(h.startedEvents).toHaveLength(1);
      expect(h.clearSpeechTimers).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(h.clearSpeechTimers).toHaveBeenCalledTimes(1);
      expect(h.audioSourceRef.current).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds short clips open for at least the 2500ms timeout floor", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(makeBuffer(0.2));
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(2499);
      expect(h.clearSpeechTimers).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(h.clearSpeechTimers).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
