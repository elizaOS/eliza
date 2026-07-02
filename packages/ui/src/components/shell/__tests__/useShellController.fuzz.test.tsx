// @vitest-environment jsdom

// Fuzz coverage for #10700: send-text, voice capture, and new-chat all mutate
// shared shell state through overlapping ref-guarded, timer-backed paths (a
// serialized send, a single-ref capture handle, a seq-guarded new-chat loader +
// watchdog). This drives randomized interleavings against the REAL
// `useShellController` and asserts the message-lifecycle invariants: no lost /
// duplicate / misordered messages, a clean reset on new-chat, and no stuck
// recording. Seeded RNG => a failing interleaving is reproducible from its seed.
//
// What is mocked (and why that is honest here): the app-state store + the
// voice-capture I/O leaf, and `sendChatText` (the send-queue leaf). This file's
// job is the SHELL-CONTROLLER lifecycle — that the controller routes each turn
// to `sendChatText` exactly once, in order, from every interleaving of
// text/voice/new-chat. The internal send-QUEUE race (enqueue-time conversation
// pin) is pinned separately against the real hook in
// `../../state/__tests__/useChatSend.send-voice-newchat.race.test.tsx`; this
// suite does not re-prove that leaf and does not claim to.
//
// Voice dimensions: dictation (start → interim/final → stop) hands its final to
// the composer draft (not a send); converse (always-on) routes finals through
// the real `TurnAggregator` (a complete final — sentence-final punctuation —
// commits synchronously) and the commit sends a VOICE_DM through the same send
// path, exercising the single-ref capture guard + the `lastTurnVoice` flag
// interleaved with text sends and new-chats.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useShellController } from "../useShellController";

const READY_STATUS = { state: "running", canRespond: true };

const NOT_REQUIRED_STATUS = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

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
    handleNewConversation: vi.fn(() => Promise.resolve()),
    handleSelectConversation: vi.fn(() => Promise.resolve()),
    conversations: [] as Array<{ id: string }>,
    setTab: vi.fn(),
    handleChatStop: vi.fn(),
    setActionNotice: vi.fn(),
    uiLanguage: "en",
    elizaCloudVoiceProxyAvailable: false,
  },
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

const { useAppSelectorShallowMock } = vi.hoisted(() => ({
  useAppSelectorShallowMock: (
    selector: (value: typeof appMock.value) => unknown,
  ) => selector(appMock.value),
}));

// Controllable voice-capture leaf: records the last handle + the onTranscript
// sink so the test can emit voice segments and drive the real send path.
const voiceCapture = vi.hoisted(() => ({
  onTranscript: null as
    | ((seg: { text: string; final: boolean }) => void)
    | null,
  handleCount: 0,
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

vi.mock("../../../state/app-store", () => ({
  useAppSelectorShallow: useAppSelectorShallowMock,
}));

vi.mock("../../local-inference/useHomeModelStatus", () => ({
  useHomeModelStatus: () => NOT_REQUIRED_STATUS,
}));

vi.mock("../../../voice/voice-capture-factory", () => ({
  createVoiceCapture: vi.fn(
    (opts: {
      onTranscript?: (seg: { text: string; final: boolean }) => void;
    }) => {
      voiceCapture.handleCount += 1;
      voiceCapture.onTranscript = opts.onTranscript ?? null;
      return {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        dispose: vi.fn(() => {
          voiceCapture.onTranscript = null;
        }),
        getAnalyser: vi.fn(() => null),
      };
    },
  ),
}));

const voiceOutputMock = vi.hoisted(() => ({
  speaking: false,
  stopSpeaking: vi.fn(),
  agentVoiceMuted: false,
  toggleAgentVoiceMute: vi.fn(),
  needsAudioUnlock: false,
  unlockAudio: vi.fn(),
  // Captures the `lastTurnVoice` the controller feeds its voice-output consumer
  // each render — lastTurnVoice is internal (not on the public controller
  // return), so this real consumer boundary is where the flag is observable.
  lastTurnVoiceSeen: undefined as boolean | undefined,
}));
vi.mock("../useShellVoiceOutput", () => ({
  useShellVoiceOutput: (opts?: { lastTurnVoice?: boolean }) => {
    voiceOutputMock.lastTurnVoiceSeen = opts?.lastTurnVoice;
    return voiceOutputMock;
  },
}));

// jsdom localStorage in this env throws; back it with an in-memory Storage.
{
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    } as Storage,
  });
}

afterEach(() => {
  cleanup();
  appMock.value.activeConversationId = null;
  appMock.value.conversationMessages = [];
  appMock.value.chatSending = false;
  composerMock.value.chatSending = false;
  appMock.value.agentStatus = { ...READY_STATUS };
  appMock.value.sendChatText.mockClear();
  appMock.value.handleNewConversation = vi.fn(() => Promise.resolve());
  appMock.value.conversations = [];
  voiceCapture.onTranscript = null;
  voiceCapture.handleCount = 0;
  voiceOutputMock.lastTurnVoiceSeen = undefined;
});

// Deterministic PRNG so a failing interleaving is reproducible from its seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The text of every send the controller dispatched, in call order — the ground
// truth against which we assert no-loss / no-dup / correct-ordering.
function sentTexts(): string[] {
  return appMock.value.sendChatText.mock.calls.map((c) => String(c[0]));
}

describe("useShellController — interleaved send/voice/new-chat fuzz (#10700)", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}: no lost / duplicate / misordered messages, no stuck recording`, async () => {
      const rand = mulberry32(seed);
      const { result } = renderHook(() => useShellController());

      const expected: string[] = [];
      let counter = 0;
      let newChats = 0;

      const OPS = 120;
      for (let i = 0; i < OPS; i++) {
        const roll = rand();
        if (roll < 0.45) {
          // send-text — a unique payload so loss/dup/reorder is detectable.
          const text = `t${counter++}`;
          expected.push(text);
          act(() => result.current.send(text));
        } else if (roll < 0.7) {
          // voice capture: open the mic (if idle), emit a final transcript, then
          // close. Half the time in converse mode (final → TurnAggregator →
          // synchronous commit → VOICE_DM send), half in dictation (final →
          // composer draft, no send). Exercises the single-ref capture guard +
          // transcript reset + the lastTurnVoice flag interleaved with
          // sends/new-chats. The guard below counts the turn as a dispatched
          // message ONLY if the controller actually sent it, so this stays
          // correct whether the mode drafts (dictation) or sends (converse).
          const converse = rand() < 0.5;
          if (!result.current.recording) {
            act(() =>
              result.current.startRecording(converse ? "converse" : "dictate"),
            );
          }
          const sink = voiceCapture.onTranscript;
          if (sink && result.current.recording) {
            // Converse needs a COMPLETE final (sentence-final punctuation scores
            // >= the commit threshold) so it commits synchronously; a real phrase
            // (not pure disfluency) so the respond-gate doesn't drop it.
            const text = converse
              ? `converse ${counter++} what is it?`
              : `v${counter++}`;
            act(() => sink({ text, final: true }));
            if (sentTexts().includes(text)) expected.push(text);
          }
          await act(async () => {
            result.current.stopRecording();
          });
        } else if (roll < 0.9) {
          // new-chat — must never drop, duplicate, or reorder prior sends, and
          // must leave no stuck recording/transcript.
          newChats++;
          act(() => result.current.clearConversation());
          // Invariant (d) (#10700): a fresh conversation's bootstrap greeting is
          // not a reply to a voice turn — the flag is cleared so it isn't spoken.
          expect(voiceOutputMock.lastTurnVoiceSeen).toBe(false);
        } else {
          // bare recording toggle — exercises the single-ref capture guard.
          act(() => result.current.toggleRecording());
        }

        // Invariant checked after EVERY op: the send log is exactly the turns we
        // dispatched, in order — no loss, no duplication, no reordering.
        const sent = sentTexts();
        expect(sent).toEqual(expected.slice(0, sent.length));
      }

      // Drain any open capture so the terminal-state assertions are meaningful.
      await act(async () => {
        result.current.stopRecording();
      });

      // Final message-lifecycle invariant: every dispatched turn survived,
      // exactly once, in order.
      expect(sentTexts()).toEqual(expected);
      expect(new Set(sentTexts()).size).toBe(sentTexts().length);
      // Clean terminal state: no stuck recording, no stranded transcript.
      expect(result.current.recording).toBe(false);
      expect(result.current.transcript).toBe("");
      // new-chat actually reached the loader each time it was invoked.
      expect(appMock.value.handleNewConversation).toHaveBeenCalledTimes(
        newChats,
      );
    });
  }

  it("a new-chat fired mid-recording does not strand the mic on", async () => {
    const { result } = renderHook(() => useShellController());
    act(() => result.current.startRecording("dictate"));
    expect(result.current.recording).toBe(true);

    // New chat while the mic is open, then user stops — recording must end.
    // stopRecording drains asynchronously (await handle.stop() → setRecording),
    // so flush microtasks before asserting the terminal state.
    act(() => result.current.clearConversation());
    await act(async () => {
      result.current.stopRecording();
    });

    expect(result.current.recording).toBe(false);
    expect(result.current.transcript).toBe("");
  });

  it("converse: a complete final commits → VOICE_DM send, sets lastTurnVoice, and a new-chat clears it without orphaning the capture", async () => {
    const { result } = renderHook(() => useShellController());

    act(() => result.current.startRecording("converse"));
    expect(result.current.recording).toBe(true);
    const sink = voiceCapture.onTranscript;
    expect(sink).not.toBeNull();

    // A complete final (sentence-final "?") commits synchronously through the
    // real TurnAggregator; onCommit sends a VOICE_DM through the real send path.
    act(() => sink?.({ text: "what time is it in tokyo?", final: true }));

    const call = appMock.value.sendChatText.mock.calls.at(-1);
    expect(call?.[0]).toBe("what time is it in tokyo?");
    // Sent as a spoken voice turn, not a plain DM.
    expect(
      (call?.[1] as { channelType?: string } | undefined)?.channelType,
    ).toBe("VOICE_DM");
    // The reply to a voice turn is spoken back.
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(true);

    // A new-chat mid-converse clears the voice flag (the greeting isn't spoken)
    // and must not strand the mic on.
    act(() => result.current.clearConversation());
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(false);
    await act(async () => {
      result.current.stopRecording();
    });
    expect(result.current.recording).toBe(false);
    expect(result.current.transcript).toBe("");
  });

  it("converse: pure disfluency does NOT send (respond-gate drops it)", () => {
    const { result } = renderHook(() => useShellController());
    act(() => result.current.startRecording("converse"));
    const sink = voiceCapture.onTranscript;
    // "um uh" is pure disfluency AND a short complete-ish final — it commits but
    // the respond-gate drops it, so nothing reaches the send path.
    act(() => sink?.({ text: "um uh.", final: true }));
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(false);
  });

  it("rapid send-text bursts are neither dropped nor duplicated", () => {
    const { result } = renderHook(() => useShellController());
    act(() => {
      for (let i = 0; i < 25; i++) result.current.send(`burst-${i}`);
    });
    const expected = Array.from({ length: 25 }, (_, i) => `burst-${i}`);
    expect(sentTexts()).toEqual(expected);
  });
});
