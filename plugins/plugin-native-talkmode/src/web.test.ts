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
