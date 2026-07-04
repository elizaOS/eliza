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
  ])("detects a non-Latin wake word and command ($lang)", async ({
    lang,
    trigger,
    said,
    command,
  }) => {
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
  });

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
});
