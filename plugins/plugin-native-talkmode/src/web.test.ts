/**
 * Exercises the TalkMode browser fallback with deterministic Web Speech and
 * speech-synthesis doubles, including initialization failure recovery.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { TalkModeWeb } from "./web";

class FakeRecognition extends EventTarget {
  static latest: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();

  constructor() {
    super();
    FakeRecognition.latest = this;
  }
}

class ThrowingRecognition extends FakeRecognition {
  constructor() {
    super();
    this.start = vi.fn(() => {
      throw new Error("recognizer failed to start");
    });
  }
}

class ThrowingConstructorRecognition {
  constructor() {
    throw new Error("recognizer construction failed");
  }
}

class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

function setWindow(value: Record<string, unknown>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

describe("TalkModeWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeRecognition.latest = null;
  });

  it("reports unsupported recognition and denied permission requests without media APIs", async () => {
    setWindow({});
    setNavigator({});

    await expect(new TalkModeWeb().start()).resolves.toEqual({
      started: false,
      error: "Speech recognition not supported on this browser",
    });
    await expect(new TalkModeWeb().checkPermissions()).resolves.toEqual({
      microphone: "prompt",
      speechRecognition: "not_supported",
    });
    await expect(new TalkModeWeb().requestPermissions()).resolves.toEqual({
      microphone: "prompt",
      speechRecognition: "not_supported",
    });
  });

  it("rolls back state when the recognizer fails to start and recovers on a later start", async () => {
    const synthesis = { cancel: vi.fn(), speak: vi.fn(), speaking: false };
    const win: Record<string, unknown> = {
      SpeechRecognition: ThrowingRecognition,
      speechSynthesis: synthesis,
    };
    setWindow(win);
    setNavigator({});
    const plugin = new TalkModeWeb();
    const states = vi.fn();
    await plugin.addListener("stateChange", states);

    // A start that reports failure must leave the plugin fully disabled.
    await expect(plugin.start()).resolves.toEqual({
      started: false,
      error: "recognizer failed to start",
    });
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: false });
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });
    expect(states).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "listening" }),
    );

    // The failed start must not wedge the instance: a subsequent working
    // recognizer should transition cleanly to a listening session.
    win.SpeechRecognition = FakeRecognition;
    await expect(plugin.start()).resolves.toEqual({ started: true });
    expect(FakeRecognition.latest?.start).toHaveBeenCalledTimes(1);
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: true });
    await expect(plugin.getState()).resolves.toEqual({
      state: "listening",
      statusText: "Listening",
    });
  });

  it("returns a structured failure when recognizer construction throws", async () => {
    setWindow({ SpeechRecognition: ThrowingConstructorRecognition });
    setNavigator({});
    const plugin = new TalkModeWeb();

    await expect(plugin.start()).resolves.toEqual({
      started: false,
      error: "recognizer construction failed",
    });
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: false });
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });
  });

  it("emits transcript events for valid recognition results and ignores malformed ones", async () => {
    const synthesis = { cancel: vi.fn(), speak: vi.fn(), speaking: false };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    const plugin = new TalkModeWeb();
    const transcripts = vi.fn();
    await plugin.addListener("transcript", transcripts);

    await expect(plugin.start()).resolves.toEqual({ started: true });
    FakeRecognition.latest?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: 42 } }],
    });
    expect(transcripts).not.toHaveBeenCalled();

    FakeRecognition.latest?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: " hello " } }],
    });
    expect(transcripts).toHaveBeenCalledWith({
      transcript: " hello ",
      isFinal: true,
    });
  });

  it("speaks with sanitized directive values and resolves completion", async () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        utterances.push(value);
        queueMicrotask(() => value.onend?.());
      }),
    };
    setWindow({ speechSynthesis: synthesis });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();
    const speaking = vi.fn();
    const complete = vi.fn();
    await plugin.addListener("speaking", speaking);
    await plugin.addListener("speakComplete", complete);

    await expect(
      plugin.speak({
        text: "Hello",
        directive: { language: "es", speed: Number.NaN },
      }),
    ).resolves.toEqual({
      completed: true,
      interrupted: false,
      usedSystemTts: true,
    });

    expect(synthesis.speak).toHaveBeenCalled();
    expect(utterances[0]?.lang).toBe("es");
    expect(utterances[0]?.rate).toBe(1);
    expect(speaking).toHaveBeenCalledWith({
      text: "Hello",
      isSystemTts: true,
    });
    expect(complete).toHaveBeenCalledWith({ completed: true });
  });

  it("maps speech synthesis errors without throwing", async () => {
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        queueMicrotask(() => value.onerror?.({ error: "interrupted" }));
      }),
    };
    setWindow({ speechSynthesis: synthesis });
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);

    await expect(new TalkModeWeb().speak({ text: "Stop" })).resolves.toEqual({
      completed: false,
      interrupted: true,
      usedSystemTts: true,
      error: "interrupted",
    });
  });
});
