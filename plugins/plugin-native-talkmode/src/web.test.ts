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

  it.each(["end", "error"] as const)(
    "preserves a newer reply when the replaced utterance reports %s",
    async (completion) => {
      const utterances: FakeUtterance[] = [];
      setWindow({
        SpeechRecognition: FakeRecognition,
        speechSynthesis: {
          cancel: vi.fn(),
          speaking: false,
          speak: (utterance: FakeUtterance) => utterances.push(utterance),
        },
      });
      setNavigator({});
      vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
      const plugin = new TalkModeWeb();
      const states: string[] = [];
      await plugin.addListener("stateChange", (event) =>
        states.push(event.state),
      );
      await plugin.start();
      const first = plugin.speak({ text: "First reply" });
      const next = plugin.speak({ text: "Next reply" });
      const statesBeforeCompletion = [...states];
      if (completion === "end") utterances[0]?.onend?.();
      else utterances[0]?.onerror?.({ error: "interrupted" });
      await expect(first).resolves.toMatchObject({ usedSystemTts: true });
      expect(states).toEqual(statesBeforeCompletion);
      await expect(plugin.getState()).resolves.toEqual({
        state: "speaking",
        statusText: "Speaking",
      });
      utterances[1]?.onend?.();
      await expect(next).resolves.toMatchObject({ completed: true });
      await expect(plugin.getState()).resolves.toEqual({
        state: "listening",
        statusText: "Listening",
      });
      await plugin.stop();
    },
  );

  it.each(["stop", "stopSpeaking"] as const)(
    "%s marks the complete browser queue interrupted before synchronous cancel callbacks",
    async (operation) => {
      const utterances: FakeUtterance[] = [];
      setWindow({
        SpeechRecognition: FakeRecognition,
        speechSynthesis: {
          cancel: () => {
            for (const utterance of utterances) utterance.onend?.();
          },
          speaking: false,
          speak: (utterance: FakeUtterance) => utterances.push(utterance),
        },
      });
      setNavigator({});
      vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
      const plugin = new TalkModeWeb();
      const completed: boolean[] = [];
      await plugin.addListener("speakComplete", (event) =>
        completed.push(event.completed),
      );
      await plugin.start();
      const first = plugin.speak({ text: "Queued first reply" });
      const second = plugin.speak({ text: "Queued next reply" });
      await plugin[operation]();
      expect(await Promise.all([first, second])).toEqual([
        { completed: false, interrupted: true, usedSystemTts: true },
        { completed: false, interrupted: true, usedSystemTts: true },
      ]);
      expect(completed).toEqual([false, false]);
      await expect(plugin.getState()).resolves.toEqual(
        operation === "stop"
          ? { state: "idle", statusText: "Off" }
          : { state: "listening", statusText: "Listening" },
      );
    },
  );

  it("restarts the recognizer when the session ends mid-utterance while speaking (issue #22369)", async () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        utterances.push(value);
      }),
    };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();
    const transcripts = vi.fn();
    await plugin.addListener("transcript", transcripts);

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const recognition = FakeRecognition.latest;
    expect(recognition?.start).toHaveBeenCalledTimes(1);

    // An agent reply flips the session into "speaking" with the utterance held
    // pending; the recognizer keeps running and is never paused.
    const speaking = plugin.speak({ text: "Here is your answer." });
    await expect(plugin.getState()).resolves.toEqual({
      state: "speaking",
      statusText: "Speaking",
    });

    // Chrome spontaneously ends the continuous session mid-utterance. Before
    // the fix this onend was swallowed because state !== "listening", leaving
    // the single-shot recognizer permanently dead.
    recognition?.onend?.();

    utterances[0]?.onend?.();
    await expect(speaking).resolves.toEqual({
      completed: true,
      interrupted: false,
      usedSystemTts: true,
    });
    await expect(plugin.getState()).resolves.toEqual({
      state: "listening",
      statusText: "Listening",
    });

    // The recognizer must have been restarted, and the user's next utterance
    // must still surface a transcript rather than being silently dropped.
    expect(recognition?.start).toHaveBeenCalledTimes(2);
    recognition?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: "still here" } }],
    });
    expect(transcripts).toHaveBeenCalledWith({
      transcript: "still here",
      isFinal: true,
    });
  });

  it("does not resurrect listening when an utterance ends after stop() (#27977)", async () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        utterances.push(value);
      }),
    };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();
    const complete = vi.fn();
    await plugin.addListener("speakComplete", complete);

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const speaking = plugin.speak({ text: "Here is your answer." });
    await expect(plugin.getState()).resolves.toEqual({
      state: "speaking",
      statusText: "Speaking",
    });

    // The user turns talk mode off while the reply is still being spoken.
    await plugin.stop();
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });

    // The browser delivers the cancelled utterance's completion afterwards.
    // Before the fix this wrote "listening" over the idle state the teardown
    // had set, showing a live session that no longer existed.
    utterances[0]?.onend?.();
    await expect(speaking).resolves.toEqual({
      completed: false,
      interrupted: true,
      usedSystemTts: true,
    });
    expect(complete).toHaveBeenCalledWith({ completed: false });
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: false });
  });

  it("returns to listening when stopSpeaking() interrupts a live session and the utterance ends late", async () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        utterances.push(value);
      }),
    };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const speaking = plugin.speak({ text: "A long reply the user cuts off." });
    await expect(plugin.getState()).resolves.toEqual({
      state: "speaking",
      statusText: "Speaking",
    });

    // The user interrupts speech; the session itself stays on.
    await expect(plugin.stopSpeaking()).resolves.toEqual({
      interruptedAt: undefined,
    });
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: true });
    await expect(plugin.getState()).resolves.toEqual({
      state: "listening",
      statusText: "Listening",
    });

    // The cancelled utterance's late end or error event must leave that
    // listening state alone, and must still settle the speak() promise.
    utterances[0]?.onerror?.({ error: "interrupted" });
    await expect(speaking).resolves.toEqual({
      completed: false,
      interrupted: true,
      usedSystemTts: true,
      error: "interrupted",
    });
    await expect(plugin.getState()).resolves.toEqual({
      state: "listening",
      statusText: "Listening",
    });
  });

  it("does not touch state when stopSpeaking() runs on a session that is off", async () => {
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn(),
    };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();

    await expect(plugin.stopSpeaking()).resolves.toEqual({});
    expect(synthesis.cancel).not.toHaveBeenCalled();
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });
  });

  it("keeps the idle teardown state when a cancelled utterance errors after stop()", async () => {
    const utterances: FakeUtterance[] = [];
    const synthesis = {
      cancel: vi.fn(),
      speaking: false,
      speak: vi.fn((value: FakeUtterance) => {
        utterances.push(value);
      }),
    };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    const plugin = new TalkModeWeb();

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const speaking = plugin.speak({ text: "Here is your answer." });
    await plugin.stop();

    // Browsers report a cancelled utterance as an "interrupted" error.
    utterances[0]?.onerror?.({ error: "interrupted" });
    await expect(speaking).resolves.toMatchObject({
      completed: false,
      interrupted: true,
      usedSystemTts: true,
    });
    await expect(plugin.getState()).resolves.toEqual({
      state: "idle",
      statusText: "Off",
    });
  });

  it("restarts the recognizer on a spontaneous onend while listening (regression)", async () => {
    const synthesis = { cancel: vi.fn(), speak: vi.fn(), speaking: false };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    const plugin = new TalkModeWeb();

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const recognition = FakeRecognition.latest;
    expect(recognition?.start).toHaveBeenCalledTimes(1);

    // While still in the "listening" state, a spontaneous onend must restart
    // the continuous session (the original always-on capture behavior).
    recognition?.onend?.();
    expect(recognition?.start).toHaveBeenCalledTimes(2);
  });

  it("does not restart the recognizer after stop() disables the session", async () => {
    const synthesis = { cancel: vi.fn(), speak: vi.fn(), speaking: false };
    setWindow({
      SpeechRecognition: FakeRecognition,
      speechSynthesis: synthesis,
    });
    setNavigator({});
    const plugin = new TalkModeWeb();

    await expect(plugin.start()).resolves.toEqual({ started: true });
    const recognition = FakeRecognition.latest;
    // stop() calls recognition.stop(), whose fake fires onend once.
    await plugin.stop();
    const callsAfterStop = recognition?.start.mock.calls.length ?? 0;

    // Any further spontaneous onend while disabled must not resurrect capture.
    recognition?.onend?.();
    expect(recognition?.start).toHaveBeenCalledTimes(callsAfterStop);
    await expect(plugin.isEnabled()).resolves.toEqual({ enabled: false });
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
