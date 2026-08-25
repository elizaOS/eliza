/**
 * Exercises the real SwabbleWeb state machine with deterministic browser API
 * doubles, including recognition-session ownership and microphone teardown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { SwabbleWeb } from "./web";

class FakeRecognition extends EventTarget {
  static latest: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  start = vi.fn(() => {
    this.onstart?.();
  });
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();

  constructor() {
    super();
    FakeRecognition.latest = this;
  }
}

class FakeAnalyser {
  fftSize = 256;
  frequencyBinCount = 128;
  getByteFrequencyData(array: Uint8Array): void {
    array.fill(0);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48000;
  close = vi.fn(async () => undefined);
  destination = {};
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createMediaStreamSource(): { connect: (target: unknown) => void } {
    return { connect: vi.fn() };
  }
  createScriptProcessor(): {
    connect: (target: unknown) => void;
    disconnect: () => void;
    onaudioprocess: unknown;
  } {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }
  createGain(): { gain: { value: number }; connect: (t: unknown) => void } {
    return { gain: { value: 1 }, connect: vi.fn() };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drains queued microtasks so a suspended start() advances through its await
// chain to the pending getUserMedia call. Uses only microtasks so it is safe
// under fake timers.
async function flushMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

function makeMicStream(): {
  stream: MediaStream;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn();
  const track = { stop, kind: "audio" };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, stop };
}

function setWindow(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: overrides,
  });
}

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function speechEvent(transcript: string, isFinal = true, confidence = 0.8) {
  return {
    results: [
      {
        isFinal,
        0: { transcript, confidence },
      },
    ],
    resultIndex: 0,
  };
}

// Builds an onresult event whose `results` list accumulates every result of a
// continuous session (as the real Web Speech API does), with `resultIndex`
// marking the first result that changed since the previous dispatch.
function accumulatedEvent(
  entries: Array<{
    transcript: string;
    isFinal?: boolean;
    confidence?: number;
  }>,
  resultIndex: number,
) {
  return {
    results: entries.map((entry) => ({
      isFinal: entry.isFinal ?? true,
      0: { transcript: entry.transcript, confidence: entry.confidence ?? 0.8 },
    })),
    resultIndex,
  };
}

describe("SwabbleWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeRecognition.latest = null;
  });

  it("reports unsupported speech recognition without microphone APIs", async () => {
    setWindow();
    setNavigator({});

    await expect(new SwabbleWeb().checkPermissions()).resolves.toEqual({
      microphone: "prompt",
      speechRecognition: "not_supported",
    });
    await expect(new SwabbleWeb().requestPermissions()).resolves.toEqual({
      microphone: "denied",
      speechRecognition: "denied",
    });
    await expect(new SwabbleWeb().getAudioDevices()).resolves.toEqual({
      devices: [],
    });
  });

  it.each([
    { triggers: [] },
    { triggers: ["", "   "] },
    { triggers: [123] as never },
  ])("rejects malformed start config %#", async (config) => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({});

    await expect(new SwabbleWeb().start({ config })).rejects.toThrow(
      "Swabble config requires",
    );
    expect(FakeRecognition.latest).toBeNull();
  });

  it("emits transcript and wake-word events from valid final speech results", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const states = vi.fn();
    const transcripts = vi.fn();
    const wakeWords = vi.fn();
    await plugin.addListener("stateChange", states);
    await plugin.addListener("transcript", transcripts);
    await plugin.addListener("wakeWord", wakeWords);

    await expect(
      plugin.start({
        config: {
          triggers: [" Eliza "],
          minCommandLength: Number.NaN,
          locale: "en-US",
        },
      }),
    ).resolves.toEqual({ started: true });
    FakeRecognition.latest?.onresult?.(speechEvent("Eliza open calendar"));

    expect(states).toHaveBeenCalledWith({ state: "listening" });
    expect(transcripts).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "Eliza open calendar",
        isFinal: true,
      }),
    );
    expect(wakeWords).toHaveBeenCalledWith(
      expect.objectContaining({
        wakeWord: "eliza",
        command: "open calendar",
        postGap: -1,
      }),
    );
  });

  it("processes only newly changed results across a continuous session", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const transcripts = vi.fn();
    const wakeWords = vi.fn();
    await plugin.addListener("transcript", transcripts);
    await plugin.addListener("wakeWord", wakeWords);
    await plugin.start({ config: { triggers: ["eliza"] } });

    // Utterance 1 finalizes at index 0.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent([{ transcript: "eliza open calendar" }], 0),
    );
    // Utterance 2 finalizes at index 1; the results list still carries the
    // already-finalized utterance 1, exactly as a real continuous session does.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent(
        [
          { transcript: "eliza open calendar" },
          { transcript: "eliza close calendar" },
        ],
        1,
      ),
    );

    // Each utterance yields exactly one wake-word fire with its own command;
    // the second must not re-include the first (no "open calendareliza close").
    const commands = wakeWords.mock.calls.map((call) => call[0].command);
    expect(commands).toEqual(["open calendar", "close calendar"]);
    const emittedTranscripts = transcripts.mock.calls.map(
      (call) => call[0].transcript,
    );
    expect(emittedTranscripts).toEqual([
      "eliza open calendar",
      "eliza close calendar",
    ]);
  });

  it("does not re-fire a finalized wake word from a later interim result", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const wakeWords = vi.fn();
    await plugin.addListener("wakeWord", wakeWords);
    await plugin.start({ config: { triggers: ["eliza"] } });

    // A finalized utterance fires once.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent([{ transcript: "eliza open calendar" }], 0),
    );
    // A subsequent interim result for the next utterance must not resurface the
    // earlier finalized command, and interim text is never a wake match.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent(
        [
          { transcript: "eliza open calendar" },
          { transcript: "eliza clo", isFinal: false },
        ],
        1,
      ),
    );

    expect(wakeWords).toHaveBeenCalledTimes(1);
    expect(wakeWords).toHaveBeenCalledWith(
      expect.objectContaining({ command: "open calendar" }),
    );
  });

  it("wakes when the trigger and command finalize in separate results", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const wakeWords = vi.fn();
    await plugin.addListener("wakeWord", wakeWords);
    await plugin.start({ config: { triggers: ["eliza"] } });

    // The user says the wake word, pauses (so it finalizes alone at index 0),
    // then speaks the command, which finalizes as a separate result at index 1.
    // The changed window for the second event carries only "open calendar", so
    // a window-only match would never see the trigger — this is the regression
    // guarded here: the carry-over buffer bridges the two final results.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent([{ transcript: "eliza" }], 0),
    );
    expect(wakeWords).not.toHaveBeenCalled();

    FakeRecognition.latest?.onresult?.(
      accumulatedEvent(
        [{ transcript: "eliza" }, { transcript: "open calendar" }],
        1,
      ),
    );

    expect(wakeWords).toHaveBeenCalledTimes(1);
    expect(wakeWords).toHaveBeenCalledWith(
      expect.objectContaining({ wakeWord: "eliza", command: "open calendar" }),
    );
  });

  it("does not re-fire the pause-split command on a later unrelated utterance", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const wakeWords = vi.fn();
    await plugin.addListener("wakeWord", wakeWords);
    await plugin.start({ config: { triggers: ["eliza"] } });

    // Trigger then command across two finals fires exactly once.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent([{ transcript: "eliza" }], 0),
    );
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent(
        [{ transcript: "eliza" }, { transcript: "open calendar" }],
        1,
      ),
    );
    // A later triggerless final (idle chatter) must neither re-fire the
    // consumed command nor accumulate unbounded carry-over.
    FakeRecognition.latest?.onresult?.(
      accumulatedEvent(
        [
          { transcript: "eliza" },
          { transcript: "open calendar" },
          { transcript: "just talking" },
        ],
        2,
      ),
    );

    expect(wakeWords).toHaveBeenCalledTimes(1);
    expect(wakeWords).toHaveBeenCalledWith(
      expect.objectContaining({ command: "open calendar" }),
    );
  });

  it.each([
    {
      lang: "ru-RU",
      trigger: "эльза",
      said: "эльза открой календарь",
      command: "открой календарь",
    },
    {
      lang: "ja-JP",
      trigger: "エリザ",
      said: "エリザ カレンダーを開いて",
      command: "カレンダーを開いて",
    },
    {
      lang: "ar-SA",
      trigger: "أليزا",
      said: "أليزا افتح التقويم",
      command: "افتح التقويم",
    },
  ])(
    "detects a non-Latin wake word and command ($lang)",
    async ({ lang, trigger, said, command }) => {
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: {
          getUserMedia: vi.fn(async () => null),
        } as unknown as MediaDevices,
      });
      const plugin = new SwabbleWeb();
      const wakeWords = vi.fn();
      await plugin.addListener("wakeWord", wakeWords);
      await plugin.start({ config: { triggers: [trigger], locale: lang } });
      FakeRecognition.latest?.onresult?.(speechEvent(said));

      expect(wakeWords).toHaveBeenCalledWith(
        expect.objectContaining({ wakeWord: trigger, command }),
      );
    },
  );

  it("ignores malformed speech result payloads without emitting transcripts", async () => {
    setWindow({ SpeechRecognition: FakeRecognition });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });
    const plugin = new SwabbleWeb();
    const transcripts = vi.fn();
    await plugin.addListener("transcript", transcripts);
    await plugin.start({ config: { triggers: ["eliza"] } });

    FakeRecognition.latest?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: 42 } }],
      resultIndex: 0,
    });

    expect(transcripts).not.toHaveBeenCalled();
  });

  it("uses desktop bridge state changes and removes subscriptions on stop", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const swabbleStart = vi.fn(async () => ({ started: true }));
    const swabbleStop = vi.fn(async () => undefined);
    const onMessage = vi.fn(
      (name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
      },
    );
    const offMessage = vi.fn((name: string) => {
      listeners.delete(name);
    });
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {
          swabbleStart,
          swabbleStop,
          swabbleAudioChunk: vi.fn(async () => undefined),
        },
        onMessage,
        offMessage,
      },
    });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => null),
      } as unknown as MediaDevices,
    });

    const plugin = new SwabbleWeb();
    const states = vi.fn();
    await plugin.addListener("stateChange", states);

    await plugin.start({
      config: { triggers: ["eliza"], sampleRate: Infinity },
    });
    expect(swabbleStart).toHaveBeenCalledWith({
      config: { triggers: ["eliza"], minCommandLength: 1, sampleRate: 16000 },
    });
    listeners.get("swabbleStateChanged")?.({ listening: true });
    await expect(plugin.isListening()).resolves.toEqual({ listening: true });
    await plugin.stop();

    expect(swabbleStop).toHaveBeenCalled();
    expect(offMessage).toHaveBeenCalled();
    expect(states).toHaveBeenLastCalledWith({ state: "idle" });
  });

  it("surfaces an error event when native mic capture is denied", async () => {
    const swabbleStart = vi.fn(async () => ({ started: true }));
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {
          swabbleStart,
          swabbleAudioChunk: vi.fn(async () => undefined),
        },
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      },
    });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        }),
      } as unknown as MediaDevices,
    });

    const plugin = new SwabbleWeb();
    const errors = vi.fn();
    await plugin.addListener("error", errors);

    await expect(
      plugin.start({ config: { triggers: ["eliza"] } }),
    ).resolves.toEqual({ started: true });

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "mic-permission",
        recoverable: false,
        message: expect.stringContaining("Permission denied"),
      }),
    );
  });

  it("tears down the level meter and mic stream on a non-recoverable recognition error", async () => {
    vi.useFakeTimers();
    try {
      FakeAudioContext.instances = [];
      const { stream, stop } = makeMicStream();
      vi.stubGlobal("AudioContext", FakeAudioContext);
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: {
          getUserMedia: vi.fn(async () => stream),
        } as unknown as MediaDevices,
      });

      const plugin = new SwabbleWeb();
      const audioLevels = vi.fn();
      const states = vi.fn();
      await plugin.addListener("audioLevel", audioLevels);
      await plugin.addListener("stateChange", states);
      await plugin.start({ config: { triggers: ["eliza"] } });

      // The level-meter interval is live before the fatal error.
      vi.advanceTimersByTime(100);
      expect(audioLevels.mock.calls.length).toBeGreaterThan(0);

      // A non-recoverable recognizer error, followed by the browser's onend.
      FakeRecognition.latest?.onerror?.({ error: "audio-capture" });
      expect(states).toHaveBeenLastCalledWith({
        state: "error",
        reason: "audio-capture",
      });
      FakeRecognition.latest?.onend?.();
      expect(states).toHaveBeenLastCalledWith({ state: "idle" });

      // The plugin now reports it is not listening.
      await expect(plugin.isListening()).resolves.toEqual({
        listening: false,
      });

      // The microphone track was released exactly once (no privacy leak) ...
      expect(stop).toHaveBeenCalledTimes(1);

      // ... and no further audioLevel events fire after entering idle/error.
      audioLevels.mockClear();
      vi.advanceTimersByTime(300);
      expect(audioLevels).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the level meter and mic stream alive on a recoverable no-speech error", async () => {
    vi.useFakeTimers();
    try {
      FakeAudioContext.instances = [];
      const { stream, stop } = makeMicStream();
      vi.stubGlobal("AudioContext", FakeAudioContext);
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: {
          getUserMedia: vi.fn(async () => stream),
        } as unknown as MediaDevices,
      });

      const plugin = new SwabbleWeb();
      const audioLevels = vi.fn();
      await plugin.addListener("audioLevel", audioLevels);
      await plugin.start({ config: { triggers: ["eliza"] } });

      const recognition = FakeRecognition.latest;
      recognition?.start.mockClear();

      // no-speech is recoverable: state stays listening and the mic is retained.
      recognition?.onerror?.({ error: "no-speech" });
      await expect(plugin.isListening()).resolves.toEqual({ listening: true });
      expect(stop).not.toHaveBeenCalled();

      // onend restarts recognition while active (the untouched restart path).
      recognition?.onend?.();
      expect(recognition?.start).toHaveBeenCalled();

      // The level meter continues to emit and the mic stays open.
      audioLevels.mockClear();
      vi.advanceTimersByTime(200);
      expect(audioLevels).toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();

      await plugin.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-close or throw when stop() follows a fatal recognition error", async () => {
    vi.useFakeTimers();
    try {
      FakeAudioContext.instances = [];
      const { stream, stop } = makeMicStream();
      vi.stubGlobal("AudioContext", FakeAudioContext);
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: {
          getUserMedia: vi.fn(async () => stream),
        } as unknown as MediaDevices,
      });

      const plugin = new SwabbleWeb();
      await plugin.start({ config: { triggers: ["eliza"] } });

      FakeRecognition.latest?.onerror?.({ error: "not-allowed" });
      FakeRecognition.latest?.onend?.();
      expect(stop).toHaveBeenCalledTimes(1);

      // A redundant stop() after teardown must be a safe no-op.
      await expect(plugin.stop()).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears down a native capture that resolves its mic prompt after stop()", async () => {
    // The Electrobun native path awaits getUserMedia (a multi-second permission
    // prompt in practice). If the consumer calls stop() while the prompt is
    // open, stopNativeAudioCapture() is a no-op because captureStream is still
    // null. The suspended start must therefore re-check session ownership when
    // getUserMedia finally resolves and tear its own capture down; otherwise a
    // live mic track, an open AudioContext, and a chunk-streaming
    // ScriptProcessor outlive the idle state (TOCTOU teardown race).
    FakeAudioContext.instances = [];
    const { stream, stop } = makeMicStream();
    const micPrompt = deferred<MediaStream>();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const swabbleStop = vi.fn(async () => undefined);
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {
          swabbleStart: vi.fn(async () => ({ started: true })),
          swabbleStop,
          swabbleAudioChunk: vi.fn(async () => undefined),
        },
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      },
    });
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(() => micPrompt.promise),
      } as unknown as MediaDevices,
    });

    const plugin = new SwabbleWeb();
    const startPromise = plugin.start({ config: { triggers: ["eliza"] } });
    // Let start() reach the awaited getUserMedia before the consumer stops.
    await flushMicrotasks();
    await plugin.stop();
    expect(swabbleStop).toHaveBeenCalled();
    await expect(plugin.isListening()).resolves.toEqual({ listening: false });

    // The permission prompt now resolves, after stop() already ran.
    micPrompt.resolve(stream);
    await startPromise;
    await Promise.resolve();

    // The raced mic track is released and the graph is never wired: because the
    // ownership re-check runs before the graph is built, no AudioContext or
    // ScriptProcessor is ever created after stop(), so nothing keeps the mic
    // open or streams chunks to the already-stopped bridge.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(0);
    await expect(plugin.isListening()).resolves.toEqual({ listening: false });
  });

  it("tears down a level-meter mic that resolves its prompt after stop()", async () => {
    // The Web Speech level meter has the same await-then-assign shape: stop()
    // can retire the recognizer while startAudioLevelMonitoring() is still
    // awaiting getUserMedia. When the prompt resolves the raced stream must be
    // released rather than assigned, leaving no mediaStream or 100 ms interval
    // behind after the session went idle.
    vi.useFakeTimers();
    try {
      FakeAudioContext.instances = [];
      const { stream, stop } = makeMicStream();
      const micPrompt = deferred<MediaStream>();
      vi.stubGlobal("AudioContext", FakeAudioContext);
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: {
          getUserMedia: vi.fn(() => micPrompt.promise),
        } as unknown as MediaDevices,
      });

      const plugin = new SwabbleWeb();
      const audioLevels = vi.fn();
      await plugin.addListener("audioLevel", audioLevels);
      const startPromise = plugin.start({ config: { triggers: ["eliza"] } });
      // start() is suspended awaiting the mic prompt; stop() wins the race.
      await flushMicrotasks();
      await plugin.stop();

      // The prompt resolves after stop() already tore the session down.
      micPrompt.resolve(stream);
      await startPromise;
      await Promise.resolve();

      // The raced level-meter track is released and no interval was armed, so
      // no audioLevel events fire after idle.
      expect(stop).toHaveBeenCalledTimes(1);
      audioLevels.mockClear();
      vi.advanceTimersByTime(500);
      expect(audioLevels).not.toHaveBeenCalled();
      await expect(plugin.isListening()).resolves.toEqual({ listening: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores callbacks from a retired recognizer after a replacement starts", async () => {
    vi.useFakeTimers();
    try {
      FakeAudioContext.instances = [];
      const firstMic = makeMicStream();
      const secondMic = makeMicStream();
      const getUserMedia = vi
        .fn<() => Promise<MediaStream>>()
        .mockResolvedValueOnce(firstMic.stream)
        .mockResolvedValueOnce(secondMic.stream);
      vi.stubGlobal("AudioContext", FakeAudioContext);
      setWindow({ SpeechRecognition: FakeRecognition });
      setNavigator({
        mediaDevices: { getUserMedia } as unknown as MediaDevices,
      });

      const plugin = new SwabbleWeb();
      const errors = vi.fn();
      const audioLevels = vi.fn();
      await plugin.addListener("error", errors);
      await plugin.addListener("audioLevel", audioLevels);

      await plugin.start({ config: { triggers: ["eliza"] } });
      const firstRecognition = FakeRecognition.latest;
      await plugin.stop();
      expect(firstMic.stop).toHaveBeenCalledTimes(1);

      await plugin.start({ config: { triggers: ["eliza"] } });
      const secondRecognition = FakeRecognition.latest;
      expect(secondRecognition).not.toBe(firstRecognition);

      firstRecognition?.onerror?.({ error: "not-allowed" });
      firstRecognition?.onend?.();
      await expect(plugin.isListening()).resolves.toEqual({ listening: true });
      expect(errors).not.toHaveBeenCalled();
      expect(secondRecognition?.abort).not.toHaveBeenCalled();
      expect(secondMic.stop).not.toHaveBeenCalled();

      audioLevels.mockClear();
      vi.advanceTimersByTime(100);
      expect(audioLevels).toHaveBeenCalled();

      await plugin.stop();
      expect(secondMic.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
