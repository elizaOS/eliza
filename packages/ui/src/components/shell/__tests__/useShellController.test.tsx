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
    activeConversationId: null as string | null | undefined,
    conversationMessages: [] as Array<{
      id: string;
      role: string;
      text: string;
      timestamp: number;
    }>,
    chatSending: false,
    chatFirstTokenReceived: false,
    sendChatText: vi.fn(),
    agentStatus: { state: "running", canRespond: true },
    // Conversation-management callbacks the controller wraps in the loading
    // flag (clear / swipe). Default to instant resolution; the watchdog tests
    // override handleNewConversation with a controllable promise.
    handleNewConversation: vi.fn(() => Promise.resolve()),
    handleSelectConversation: vi.fn(() => Promise.resolve()),
    conversations: [] as Array<{ id: string }>,
    setTab: vi.fn(),
    handleChatStop: vi.fn(),
    uiLanguage: "en",
    elizaCloudVoiceProxyAvailable: false,
  },
  // Live server-reported turn status (#8813), read via useChatTurnStatus().
  serverTurnStatus: null as { kind: string } | null,
}));

const composerMock = vi.hoisted(() => ({
  value: {
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    setChatInput: vi.fn(),
    setChatPendingImages: vi.fn(),
  },
}));

// Mirror the real store selector by applying the selector to the mock value
// (useShellController reads via useAppSelectorShallow, #9141). Hoisted so both
// the barrel and the deep app-store mock factories below can reference it.
const { useAppSelectorShallowMock } = vi.hoisted(() => ({
  useAppSelectorShallowMock: (
    selector: (value: typeof appMock.value) => unknown,
  ) => selector(appMock.value),
}));

vi.mock("../../../state", () => ({
  useApp: () => appMock.value,
  useAppSelectorShallow: useAppSelectorShallowMock,
  useConversationMessages: () => ({
    conversationMessages: appMock.value.conversationMessages,
    removeConversationMessage: vi.fn(),
  }),
  useChatComposer: () => composerMock.value,
  useChatTurnStatus: () => ({
    serverTurnStatus: appMock.serverTurnStatus,
    setServerTurnStatus: vi.fn(),
  }),
}));

// useShellController imports useAppSelectorShallow from the deep app-store path
// (not the ../../state barrel) so the selector hook stays decoupled from the
// barrel's transitive shell imports (#9141/#9249). Mock that exact specifier or
// the controller reads the real empty store instead of appMock.value.
vi.mock("../../../state/app-store", () => ({
  useAppSelectorShallow: useAppSelectorShallowMock,
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
  appMock.value.activeConversationId = null;
  appMock.value.conversationMessages = [];
  appMock.value.chatSending = false;
  composerMock.value.chatSending = false;
  appMock.value.chatFirstTokenReceived = false;
  appMock.serverTurnStatus = null;
  appMock.value.sendChatText.mockClear();
  appMock.value.agentStatus = { ...READY_STATUS };
  appMock.value.handleNewConversation = vi.fn(() => Promise.resolve());
  appMock.value.handleSelectConversation = vi.fn(() => Promise.resolve());
  appMock.value.activeConversationId = null;
  appMock.value.conversations = [];
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

  // Regression: a steady-state empty active conversation (greeting generation
  // failed silently, or an existing zero-message conversation was selected) must
  // NOT report conversationLoading=true. A message-count heuristic latched the
  // flag true forever, pinning a perpetual loading spinner and letting the
  // grabber/pill open the chat sheet into a never-resolving loader. Revealability
  // must come from the explicit, sequence-guarded loading flag only.
  it("does not report loading for a steady-state empty active conversation", () => {
    appMock.value.activeConversationId = "conv-empty";
    appMock.value.conversationMessages = [];

    const { result } = renderHook(() => useShellController());

    expect(result.current.conversationLoading).toBe(false);
  });
});

// ── Conversation loading watchdog + swipe (clear/new-chat robustness) ────────

describe("useShellController — conversation loading watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("force-clears the loading spinner when the new-chat create hangs", async () => {
    // A create that never resolves — the on-device agent queued behind a
    // warming/loading model or an in-flight generation. The spinner must NOT
    // hang there forever ("reset shows a spinner but never makes the new chat").
    let resolveCreate: (() => void) | undefined;
    appMock.value.handleNewConversation = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveCreate = () => r();
        }),
    );

    const { result } = renderHook(() => useShellController());

    act(() => result.current.clearConversation());
    expect(result.current.conversationLoading).toBe(true);

    // Self-clears after the bounded watchdog window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(result.current.conversationLoading).toBe(false);

    // A late create resolution neither errors nor re-sticks the spinner.
    await act(async () => {
      resolveCreate?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.conversationLoading).toBe(false);
  });

  it("clears the loading flag as soon as a fast switch resolves (no needless wait)", async () => {
    appMock.value.conversations = [{ id: "a" }, { id: "b" }];
    appMock.value.activeConversationId = "a";

    const { result } = renderHook(() => useShellController());

    // Swipe to the next (older) conversation — the path that "thumbs back and
    // forth". It resolves instantly, so the flag clears well before the cap and
    // never strands the UI.
    await act(async () => {
      result.current.conversationNav.goNext();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(appMock.value.handleSelectConversation).toHaveBeenCalledWith("b");
    expect(result.current.conversationLoading).toBe(false);
  });
});

// ── Rich turn status derivation (#8813) ──────────────────────────────────────

describe("useShellController — turnStatus derivation", () => {
  it("is null when idle", () => {
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toBeNull();
  });

  it("is thinking while sending before the first token", () => {
    composerMock.value.chatSending = true;
    appMock.value.chatFirstTokenReceived = false;
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toEqual({ kind: "thinking" });
  });

  it("is streaming once the first token has arrived", () => {
    composerMock.value.chatSending = true;
    appMock.value.chatFirstTokenReceived = true;
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toEqual({ kind: "streaming" });
  });

  it("prefers the live server status (e.g. running_action) while sending", () => {
    composerMock.value.chatSending = true;
    appMock.value.chatFirstTokenReceived = false;
    appMock.serverTurnStatus = {
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    } as { kind: string };
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toEqual({
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    });
  });

  it("surfaces a waking server status even before chatSending settles", () => {
    composerMock.value.chatSending = false;
    appMock.serverTurnStatus = { kind: "waking" } as { kind: string };
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toEqual({ kind: "waking" });
  });

  it("speaking (voice output) wins over the server status", () => {
    voiceOutputMock.speaking = true;
    composerMock.value.chatSending = true;
    appMock.serverTurnStatus = { kind: "streaming" } as { kind: string };
    const { result } = renderHook(() => useShellController());
    expect(result.current.turnStatus).toEqual({ kind: "speaking" });
    voiceOutputMock.speaking = false;
  });

  it("uses the live composer chatSending value instead of the stale AppContext copy", () => {
    appMock.value.chatSending = false;
    composerMock.value.chatSending = true;
    appMock.value.chatFirstTokenReceived = false;

    const { result } = renderHook(() => useShellController());

    expect(result.current.responding).toBe(true);
    expect(result.current.turnStatus).toEqual({ kind: "thinking" });
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

  it("a spoken 'start transcription' in converse flips into transcription mode and is not sent", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    appMock.value.sendChatText.mockClear();

    act(() => fireFinalTranscript("ok start transcription"));
    // The command flips INTO record-only transcription mode (disabling
    // hands-free) and is NOT sent as a normal conversational turn.
    expect(result.current.transcriptionMode).toBe(true);
    expect(result.current.handsFree).toBe(false);
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
  });

  it("transcript button OFF leaves the mic ON (resumes the paused hands-free loop)", async () => {
    const { result } = renderHook(() => useShellController());
    // Mic on (hands-free) is the base state.
    await act(async () => result.current.toggleHandsFree());
    expect(result.current.handsFree).toBe(true);

    // Transcript ON pauses the reply loop but the mic stays on (transcribing).
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(true);
    expect(result.current.handsFree).toBe(false);

    // Transcript OFF (the transcript button) must LEAVE THE MIC ON — the
    // hands-free loop it paused resumes; it does not kill the mic.
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(false);
    expect(result.current.handsFree).toBe(true);
  });

  it("the mic button while transcribing turns the mic AND transcript fully off", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => result.current.toggleHandsFree());
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(true);

    // stopTranscriptionAndMic is the mic button's action: mic = parent, so
    // turning the mic off turns transcript off too — nothing resumes.
    await act(async () => result.current.stopTranscriptionAndMic());
    expect(result.current.transcriptionMode).toBe(false);
    expect(result.current.handsFree).toBe(false);
  });

  it("transcript OFF does not resume the mic when it was started from cold (no prior mic)", async () => {
    const { result } = renderHook(() => useShellController());
    // Enter transcription with the mic NOT already on (e.g. a server command).
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(true);
    expect(result.current.handsFree).toBe(false);

    // Turning it off leaves the mic off — there was no mic loop to resume.
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(false);
    expect(result.current.handsFree).toBe(false);
  });

  it("wake word DURING transcription sends one inline reply and KEEPS recording (#9880)", async () => {
    const { result } = renderHook(() => useShellController());
    // Enter transcription mode directly (record-only; replies suppressed).
    await act(async () => result.current.toggleTranscriptionMode());
    expect(result.current.transcriptionMode).toBe(true);
    // Let the transcription re-listen loop open a transcription-intent capture.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    appMock.value.sendChatText.mockClear();

    // A plain utterance is recorded silently — NOT sent.
    act(() => fireFinalTranscript("the meeting starts at noon"));
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();

    // The wake phrase makes the agent reply inline (parallel chat) while
    // transcription continues — sent as a VOICE_DM, WITHOUT transcriptionMode
    // metadata (so the server reply gate doesn't suppress it).
    act(() => fireFinalTranscript("hey eliza what is on my calendar"));
    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText.mock.calls[0]?.[0]).toBe(
      "what is on my calendar",
    );
    const meta = appMock.value.sendChatText.mock.calls[0]?.[1] as {
      channelType?: string;
      metadata?: { transcriptionMode?: boolean };
    };
    expect(meta?.channelType).toBe("VOICE_DM");
    expect(meta?.metadata?.transcriptionMode).toBeUndefined();
    // Crucially, transcription did NOT exit — recording continues.
    expect(result.current.transcriptionMode).toBe(true);
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

// ── Transcription mode (#8789): record-only until an exit phrase ─────────────

describe("useShellController — transcription mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastCaptureOpts = null;
    captureHandles = [];
    createVoiceCaptureMock.mockReset();
    installFakeCapture();
    voiceOutputMock.speaking = false;
    appMock.value.agentStatus = { ...READY_STATUS };
    appMock.value.sendChatText.mockClear();
    try {
      window.localStorage.clear();
    } catch {}
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts/stops transcription on a voice-control window event (agent action)", () => {
    const { result } = renderHook(() => useShellController());
    expect(result.current.transcriptionMode).toBe(false);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:voice-control", {
          detail: { command: "start" },
        }),
      );
    });
    expect(result.current.transcriptionMode).toBe(true);
    // Idempotent: a second "start" is a no-op.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:voice-control", {
          detail: { command: "start" },
        }),
      );
    });
    expect(result.current.transcriptionMode).toBe(true);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("eliza:voice-control", { detail: { command: "stop" } }),
      );
    });
    expect(result.current.transcriptionMode).toBe(false);
  });

  /** Capture finalized recording sessions delivered to the sink. */
  function sinkSessions(result: {
    current: ReturnType<typeof useShellController>;
  }) {
    const sessions: Array<{
      segments: Array<{ text: string }>;
      startedAt: number;
    }> = [];
    act(() =>
      result.current.setTranscriptSessionSink((segments, startedAt) =>
        sessions.push({
          segments: segments as Array<{ text: string }>,
          startedAt,
        }),
      ),
    );
    return sessions;
  }

  it("accumulates finals into ONE recording session, not per-utterance DMs", async () => {
    const { result } = renderHook(() => useShellController());
    const sessions = sinkSessions(result);
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(result.current.transcriptionMode).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    act(() => fireFinalTranscript("schedule a meeting with"));
    act(() => fireFinalTranscript("the design team tomorrow"));
    // No per-utterance chat bubbles, and not finalized while still recording.
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(0);

    // Toggling off finalizes the session with both utterances as segments.
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((s) => s.text)).toEqual([
      "schedule a meeting with",
      "the design team tomorrow",
    ]);
  });

  it("an exit phrase finalizes the session and exits (exit utterance not recorded)", async () => {
    const { result } = renderHook(() => useShellController());
    const sessions = sinkSessions(result);
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    act(() => fireFinalTranscript("first paragraph of my notes"));
    act(() => fireFinalTranscript("exit transcription mode"));
    expect(result.current.transcriptionMode).toBe(false);
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((s) => s.text)).toEqual([
      "first paragraph of my notes",
    ]);
  });

  it("includes the text preceding an inline exit phrase, then exits", async () => {
    const { result } = renderHook(() => useShellController());
    const sessions = sinkSessions(result);
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    act(() => fireFinalTranscript("wrap up here stop transcription"));
    expect(result.current.transcriptionMode).toBe(false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((s) => s.text)).toEqual(["wrap up here"]);
  });

  it("toggling it off stops the capture and disables hands-free", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(result.current.transcriptionMode).toBe(true);
    expect(result.current.handsFree).toBe(false);

    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(result.current.transcriptionMode).toBe(false);
    expect(captureHandles[0]?.stop).toHaveBeenCalled();
  });
});
