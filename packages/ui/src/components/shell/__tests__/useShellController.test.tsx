// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import {
  createVoiceCapture,
  type VoiceCaptureFactoryOptions,
} from "../../../voice/voice-capture-factory";
import { useShellController } from "../useShellController";

// jsdom in this env ships a `window.localStorage` whose methods throw (the
// beforeEach clear() is wrapped in try/catch for exactly that reason). The
// hands-free persistence tests need a real one, so back it with an in-memory
// Storage.
{
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: memoryStorage,
    configurable: true,
  });
}

const NOT_REQUIRED_STATUS = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

// Readiness is now driven by the agent's first-turn capability
// (agentStatus.canRespond), NOT the startup-coordinator phase — the shell mounts
// early and the composer queues sends until capability fades in.
const READY_STATUS = { state: "running", canRespond: true };
const WARMING_STATUS = { state: "starting", canRespond: false };

const appMock = vi.hoisted(() => ({
  value: {
    startupCoordinator: { phase: "ready" },
    conversationMessages: [] as Array<{
      id: string;
      role: string;
      text: string;
      timestamp: number;
    }>,
    chatSending: false,
    sendChatText: vi.fn(),
    agentStatus: { state: "running", canRespond: true },
  },
}));

vi.mock("../../../state", () => ({
  useApp: () => appMock.value,
}));

vi.mock("../../local-inference/useHomeModelStatus", () => ({
  useHomeModelStatus: () => NOT_REQUIRED_STATUS,
}));

vi.mock("../../../voice/voice-capture-factory", () => ({
  createVoiceCapture: vi.fn(),
}));

// Voice OUTPUT is stubbed to a quiet, controllable surface so the hands-free
// re-listen loop is deterministic (never spuriously "speaking").
const voiceOutputMock = vi.hoisted(() => ({
  speaking: false,
  stopSpeaking: vi.fn(),
  agentVoiceMuted: false,
  toggleAgentVoiceMute: vi.fn(),
  needsAudioUnlock: false,
  unlockAudio: vi.fn(),
}));
vi.mock("../useShellVoiceOutput", () => ({
  useShellVoiceOutput: () => voiceOutputMock,
}));

afterEach(() => {
  cleanup();
  appMock.value.startupCoordinator.phase = "ready";
  appMock.value.conversationMessages = [];
  appMock.value.chatSending = false;
  appMock.value.sendChatText.mockClear();
  appMock.value.agentStatus = { ...READY_STATUS };
});

describe("useShellController", () => {
  it("opens the shared chat state even while startup is still booting", () => {
    appMock.value.agentStatus = { ...WARMING_STATUS };

    const { result } = renderHook(() => useShellController());

    expect(result.current.phase).toBe("booting");
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.open());

    expect(result.current.phase).toBe("booting");
    expect(result.current.isOpen).toBe(true);
    // Composer accepts input while booting — pre-ready sends queue (see below).
    expect(result.current.canSend).toBe(true);
  });

  it("sends through immediately even while warming — the server holds the turn", () => {
    appMock.value.agentStatus = { ...WARMING_STATUS };

    const { result } = renderHook(() => useShellController());

    // No client-side queue: sendChatText fires now (optimistic bubble + typing
    // indicator), and the server holds the turn until capability comes online.
    act(() => result.current.send("hello while booting"));

    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText.mock.calls[0]?.[0]).toBe(
      "hello while booting",
    );
  });

  it("sends immediately when already ready", () => {
    appMock.value.agentStatus = { ...READY_STATUS };

    const { result } = renderHook(() => useShellController());

    act(() => result.current.send("hi"));

    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText.mock.calls[0]?.[0]).toBe("hi");
  });
});

// ── Voice: push-to-talk routing, hands-free loop, and #5 typing-pause ────────

type CaptureOpts = VoiceCaptureFactoryOptions;

const createVoiceCaptureMock = vi.mocked(createVoiceCapture);

/** Records the callbacks of the most recent capture + its handle's stop()/start(). */
let lastCaptureOpts: CaptureOpts | null = null;
let captureHandles: Array<{
  start: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<void>>;
}> = [];

function installFakeCapture(): void {
  createVoiceCaptureMock.mockImplementation((opts: CaptureOpts) => {
    lastCaptureOpts = opts;
    const handle = {
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(),
      getAnalyser: vi.fn(() => null),
    };
    captureHandles.push(handle);
    // The real onStateChange("stopped") path clears recording/capture; mirror it
    // when the handle is stopped so the re-listen loop can re-arm.
    handle.stop.mockImplementation(() => {
      opts.onStateChange?.("stopped");
      return Promise.resolve();
    });
    return handle as never;
  });
}

/** Fire a final transcript through the most recent capture. */
function fireFinalTranscript(text: string): void {
  lastCaptureOpts?.onTranscript?.({ text, final: true, backend: "browser" });
}

describe("useShellController — voice capture routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastCaptureOpts = null;
    captureHandles = [];
    createVoiceCaptureMock.mockReset();
    installFakeCapture();
    voiceOutputMock.speaking = false;
    appMock.value.agentStatus = { ...READY_STATUS };
    appMock.value.sendChatText.mockClear();
    // Hands-free now persists to localStorage (continuous-chat-mode). Clear it so
    // a write in one test doesn't auto-engage the boot loop in the next.
    try {
      window.localStorage.clear();
    } catch {}
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("push-to-talk dictation fills the draft and does NOT send", async () => {
    const dictated: string[] = [];
    const { result } = renderHook(() => useShellController());
    act(() => result.current.setDictationSink((t) => dictated.push(t)));

    // Press-and-hold → dictation capture.
    await act(async () => {
      result.current.startRecording("dictate");
    });
    expect(result.current.recording).toBe(true);

    // A final transcript routes to the dictation sink, NOT send().
    act(() => fireFinalTranscript("remind me tomorrow"));
    expect(dictated).toEqual(["remind me tomorrow"]);
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
  });

  it("converse capture (hands-free) sends the transcript as a VOICE_DM", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    act(() => fireFinalTranscript("what's the weather"));
    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText.mock.calls[0]?.[1]).toMatchObject({
      channelType: "VOICE_DM",
    });
  });

  it("does NOT respond to pure thinking-noise in always-on (shouldRespond gate)", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    // Pure disfluency the open mic picked up → suppressed, not sent.
    act(() => fireFinalTranscript("um uh"));
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
    // A genuine request still goes through.
    act(() => fireFinalTranscript("what time is it?"));
    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
  });

  it("HOLDS a slow-speaker mid-clause turn and sends only the completed turn (EOT)", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    // An utterance that trails off mid-clause is HELD, not sent.
    act(() => fireFinalTranscript("schedule a meeting with"));
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
    // The speaker resumes after the pause → append → complete → send the FULL turn.
    act(() => fireFinalTranscript("bob tomorrow"));
    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText.mock.calls[0]?.[0]).toBe(
      "schedule a meeting with bob tomorrow",
    );
  });

  it("suppresses a voice turn that echoes the agent's recent reply (self-trigger)", async () => {
    appMock.value.conversationMessages = [
      {
        id: "a1",
        role: "assistant",
        text: "it is sunny today",
        timestamp: Date.now(),
      },
    ];
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    // The open mic hears the agent's own TTS played back → must not re-respond.
    act(() => fireFinalTranscript("it is sunny today"));
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
  });

  it("hands-free loop re-opens the mic after a turn ends", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    // The turn ends (capture stops) → after the 250ms debounce the loop re-opens.
    await act(async () => {
      captureHandles[0]?.stop();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(2);
  });

  it("#5: a typed draft pauses the always-on loop; clearing it (send) resumes", async () => {
    const { result } = renderHook(() => useShellController());

    // Always-on engaged: mic open (capture #1).
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    // User starts typing → the live capture is stopped (always-on paused), but
    // handsFree stays true (the remembered voice state).
    await act(async () => {
      result.current.setComposerHasDraft(true);
    });
    expect(captureHandles[0]?.stop).toHaveBeenCalled();
    expect(result.current.handsFree).toBe(true);

    // While the draft persists the loop must NOT re-open the mic.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    // Clearing the draft (on send) returns to the prior voice state — the loop
    // re-arms and re-opens the mic (capture #2).
    await act(async () => {
      result.current.setComposerHasDraft(false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(2);
  });

  it("#5: typing does nothing when always-on was never engaged", async () => {
    const { result } = renderHook(() => useShellController());

    // No hands-free → typing + clearing the draft never opens the mic.
    await act(async () => {
      result.current.setComposerHasDraft(true);
    });
    await act(async () => {
      result.current.setComposerHasDraft(false);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(createVoiceCaptureMock).not.toHaveBeenCalled();
    expect(result.current.handsFree).toBe(false);
  });

  it("restores a persisted always-on mode by engaging the loop on mount", async () => {
    // A persisted always-on setting is now unified with the hands-free loop: on
    // boot it engages handsFree (the re-listen loop), not a one-shot capture.
    window.localStorage.setItem(
      "eliza:voice:continuous-chat-mode",
      "always-on",
    );

    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.handsFree).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);
    // It is a converse capture (sends + speaks), not a silent one-shot.
    act(() => fireFinalTranscript("hello"));
    expect(appMock.value.sendChatText.mock.calls[0]?.[1]).toMatchObject({
      channelType: "VOICE_DM",
    });
  });

  it("persists always-on on tap and restores the prior mode on tap-off", async () => {
    // A deliberate vad-gated choice (e.g. from the full ChatView toggle) must
    // survive a hands-free on/off cycle in the shell, not collapse to "off".
    window.localStorage.setItem(
      "eliza:voice:continuous-chat-mode",
      "vad-gated",
    );

    const { result } = renderHook(() => useShellController());

    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    expect(
      window.localStorage.getItem("eliza:voice:continuous-chat-mode"),
    ).toBe("always-on");

    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(false);
    expect(
      window.localStorage.getItem("eliza:voice:continuous-chat-mode"),
    ).toBe("vad-gated");
  });
});
