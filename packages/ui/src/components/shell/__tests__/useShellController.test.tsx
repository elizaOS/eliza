// @vitest-environment jsdom
//
// The shell controller hook end to end in jsdom: conversation load watchdog,
// swipe interleaving (#9954), turnStatus derivation, voice-capture routing,
// transcription mode, TTS reset on conversation change, mic-failure notices,
// wake-word gating, and the no-provider path. The voice-capture factory, app
// store, and voice-output hook are mocked; localStorage is backed by an
// in-memory Storage so hands-free persistence is real.

import { VOICE_SETTINGS_APPLY_EVENT } from "@elizaos/shared/events";
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
import { emitViewEvent } from "../../../views/view-event-bus";
import {
  createVoiceCapture,
  type VoiceCaptureFactoryOptions,
} from "../../../voice/voice-capture-factory";
import { resolveAdjacentConversationId } from "../conversation-nav";
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
      failureKind?: string;
    }>,
    chatSending: false,
    chatFirstTokenReceived: false,
    sendChatText: vi.fn(),
    // Mirrors the real store shape (AgentStatus | null — null before the first
    // status broadcast lands).
    agentStatus: { state: "running", canRespond: true } as {
      state: string;
      canRespond?: boolean;
    } | null,
    // Conversation-management callbacks the controller wraps in the loading
    // flag (clear / swipe). Default to instant resolution; the watchdog tests
    // override handleNewConversation with a controllable promise.
    handleNewConversation: vi.fn(() => Promise.resolve()),
    handleSelectConversation: vi.fn(() => Promise.resolve()),
    conversations: [] as Array<{ id: string }>,
    setTab: vi.fn(),
    handleChatStop: vi.fn(),
    setActionNotice: vi.fn(),
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

// Microphone-permission probe: stubbed so tests can drive the last-known
// grant the engage-time gate reads. Defaults to "unknown" (the jsdom reality:
// no `navigator.permissions.microphone`), so the common engage path stays
// synchronous and proceeds exactly as before. Keeps the rest of the module
// real (WAV/silence helpers used elsewhere).
const micPermissionMock = vi.hoisted(() => ({
  state: "unknown" as "granted" | "denied" | "prompt" | "unknown",
}));
vi.mock("../../../voice/local-asr-capture", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../voice/local-asr-capture")>();
  return {
    ...actual,
    queryMicrophonePermission: vi.fn(async () => micPermissionMock.state),
  };
});

// Voice OUTPUT is stubbed to a quiet, controllable surface so the hands-free
// re-listen loop is deterministic (never spuriously "speaking").
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

// Wake-listen window is stubbed to a capture-only surface: it records the
// `enabled` option (the Settings wake-word toggle → persisted pref → shell) and
// otherwise stays inert, so the wake-gating assertions are deterministic and the
// real native subscription never runs in jsdom.
const wakeListenMock = vi.hoisted(() => ({
  lastEnabled: undefined as boolean | undefined,
}));
vi.mock("../../../voice/useWakeListenWindow", () => ({
  useWakeListenWindow: (opts: { enabled: boolean }) => {
    wakeListenMock.lastEnabled = opts.enabled;
    return { phase: "idle" as const };
  },
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
  appMock.value.setActionNotice.mockClear();
  appMock.value.agentStatus = { ...READY_STATUS };
  appMock.value.handleNewConversation = vi.fn(() => Promise.resolve());
  appMock.value.handleSelectConversation = vi.fn(() => Promise.resolve());
  appMock.value.activeConversationId = null;
  appMock.value.conversations = [];
  voiceOutputMock.stopSpeaking.mockClear();
  voiceOutputMock.lastTurnVoiceSeen = undefined;
  wakeListenMock.lastEnabled = undefined;
  try {
    window.localStorage.clear();
  } catch {}
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

  it("drops stale swipe callbacks while a conversation switch is pending", async () => {
    let resolveSwitch: (() => void) | undefined;
    appMock.value.conversations = [{ id: "a" }, { id: "b" }, { id: "c" }];
    appMock.value.activeConversationId = "b";
    appMock.value.handleSelectConversation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );

    const { result } = renderHook(() => useShellController());
    const staleNav = result.current.conversationNav;

    await act(async () => {
      staleNav.goNext();
      staleNav.goPrev();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      appMock.value.handleSelectConversation,
    ).toHaveBeenCalledExactlyOnceWith("c");
    expect(result.current.conversationLoading).toBe(true);

    await act(async () => {
      resolveSwitch?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.conversationLoading).toBe(false);
  });

  it("re-resolves a stale swipe callback against the latest active conversation", async () => {
    appMock.value.conversations = [{ id: "a" }, { id: "b" }, { id: "c" }];
    appMock.value.activeConversationId = "b";

    const { result, rerender } = renderHook(() => useShellController());
    const staleNav = result.current.conversationNav;

    appMock.value.activeConversationId = "a";
    rerender();

    await act(async () => {
      staleNav.goNext();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      appMock.value.handleSelectConversation,
    ).toHaveBeenCalledExactlyOnceWith("b");
    expect(result.current.conversationLoading).toBe(false);
  });
});

// ── Conversation-nav interleaving fuzz over the REAL hook (#9954 item 1) ──────
// The headline #9954 gap: rapid swipe ↔ new-conversation ↔ select interleavings
// could select the wrong conversation against a stale nav closure. #10042 made
// the swipe callbacks re-resolve through refs and drop a swipe while a switch is
// in flight; the two hand-written cases above pin those specific shapes. This
// block fuzzes the real `useShellController` over a LIVE mutating conversation
// list (select flips the active id; new prepends at index 0 and activates it),
// asserting the most-recent-first index invariants after EVERY step across the
// named sequence plus seeded random walks — so a reintroduced stale-index or
// off-by-one regression fails here regardless of ordering.
describe("useShellController — conversation-nav interleaving (#9954)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Ctl = ReturnType<typeof useShellController>;
  type Action = "next" | "prev" | "new" | "select";

  // Records any SWIPE select (goNext/goPrev → handleSelectConversation) that
  // targeted a conversation which is NOT a neighbour of the active id at the
  // moment the call fired. That is exactly the stale-closure bug: with the
  // #10042 seq/epoch guard every swipe re-resolves through refs against the
  // LIVE active index, so this stays empty. (External `select` mutates the
  // active id directly and never routes through handleSelectConversation, so it
  // can't pollute this signal.) The post-rerender index invariants in
  // `assertInvariants` alone do NOT catch a reverted guard — they hold for a
  // wrong-but-present selection — so this call-time check is the actual teeth.
  let staleSwipeSelects: Array<{ requested: string; activeAtCall: string }> =
    [];

  function wireMutableConversations(initialIds: string[]): void {
    staleSwipeSelects = [];
    appMock.value.conversations = initialIds.map((id) => ({ id }));
    // Start on the oldest (highest index) so both swipe directions are live.
    appMock.value.activeConversationId =
      initialIds[initialIds.length - 1] ?? null;
    appMock.value.handleSelectConversation = vi.fn((id: string) => {
      const active = appMock.value.activeConversationId ?? null;
      const neighbours = [
        resolveAdjacentConversationId(
          appMock.value.conversations,
          active,
          "prev",
        ),
        resolveAdjacentConversationId(
          appMock.value.conversations,
          active,
          "next",
        ),
      ];
      if (!neighbours.includes(id)) {
        staleSwipeSelects.push({ requested: id, activeAtCall: String(active) });
      }
      appMock.value.activeConversationId = id;
      return Promise.resolve();
    }) as unknown as typeof appMock.value.handleSelectConversation;
    let created = 0;
    appMock.value.handleNewConversation = vi.fn(() => {
      const id = `new-${created++}`;
      appMock.value.conversations = [{ id }, ...appMock.value.conversations];
      appMock.value.activeConversationId = id;
      return Promise.resolve();
    });
  }

  async function drive(
    result: { current: Ctl },
    rerender: () => void,
    action: Action,
    rng: () => number,
  ): Promise<void> {
    await act(async () => {
      if (action === "next") result.current.conversationNav.goNext();
      else if (action === "prev") result.current.conversationNav.goPrev();
      else if (action === "new") result.current.clearConversation();
      else {
        // External (sidebar / deep-link) select interleaved with swipes.
        const list = appMock.value.conversations;
        if (list.length > 0) {
          appMock.value.activeConversationId =
            list[Math.floor(rng() * list.length)].id;
        }
      }
      await vi.advanceTimersByTimeAsync(0);
    });
    rerender();
  }

  function assertInvariants(ctl: Ctl): void {
    const list = appMock.value.conversations;
    const active = appMock.value.activeConversationId ?? null;
    const expectedIndex = list.findIndex((c) => c.id === active);
    const nav = ctl.conversationNav;
    // The active conversation is always a member of the list (never orphaned).
    if (active !== null) {
      expect(list.some((c) => c.id === active)).toBe(true);
    }
    // nav.index tracks the active id's position in the most-recent-first list.
    expect(nav.index).toBe(expectedIndex);
    expect(nav.activeId).toBe(active);
    // Edge hints are exactly the index boundaries — never navigable past an end.
    expect(nav.hasPrev).toBe(expectedIndex > 0);
    expect(nav.hasNext).toBe(
      expectedIndex >= 0 && expectedIndex < list.length - 1,
    );
    // No transition is left in flight once the step settles.
    expect(ctl.conversationLoading ?? false).toBe(false);
    // Every swipe resolved against the LIVE active index — never a stale one.
    // This is the assertion that fails if the #10042 guard is reverted.
    expect(staleSwipeSelects).toEqual([]);
  }

  it("named sequence swipe-back → new → forward → new → forward → swipe-back stays index-consistent", async () => {
    wireMutableConversations(["c0", "c1", "c2"]); // active = c2 (oldest, index 2)
    const { result, rerender } = renderHook(() => useShellController());
    assertInvariants(result.current);

    const rng = mulberry32(1);
    const sequence: Action[] = ["prev", "new", "next", "new", "next", "prev"];
    for (const action of sequence) {
      const before = appMock.value.activeConversationId;
      const atIndex0Boundary =
        action === "prev" && result.current.conversationNav.index === 0;
      await drive(result, rerender, action, rng);
      assertInvariants(result.current);
      if (action === "new") {
        // A new conversation lands at index 0 and becomes active.
        expect(result.current.conversationNav.index).toBe(0);
      }
      if (atIndex0Boundary) {
        // A swipe at the index-0 boundary is a no-op (no wrong-conversation jump).
        expect(appMock.value.activeConversationId).toBe(before);
      }
    }
    expect(
      appMock.value.conversations.some(
        (c) => c.id === appMock.value.activeConversationId,
      ),
    ).toBe(true);
  });

  it("seeded random walks keep the nav invariants on every step", async () => {
    const actions: Action[] = ["next", "prev", "new", "select"];
    for (let seed = 1; seed <= 12; seed++) {
      wireMutableConversations(["a", "b", "c", "d"]);
      const { result, rerender, unmount } = renderHook(() =>
        useShellController(),
      );
      const rng = mulberry32(seed * 0x9e3779b1);
      for (let stepN = 0; stepN < 40; stepN++) {
        const action = actions[Math.floor(rng() * actions.length)];
        await drive(result, rerender, action, rng);
        assertInvariants(result.current);
      }
      unmount();
    }
  });

  // The walks above rerender after EVERY op, so the nav closure is always fresh
  // and the stale-closure race never fires — those invariants hold even with the
  // #10042 guard reverted. The race the guard actually fixes needs TWO ops to
  // share ONE nav closure (a second swipe dispatched before the first switch
  // settles + rerenders). This drives exactly that: rapid bursts of two ops in a
  // single act() with no rerender between, asserting (via the call-time
  // adjacency check in assertInvariants) that the second op never navigates
  // against the now-stale index. Reverting the goNext/goPrev ref-resolution in
  // useShellController makes this fail; the guard keeps it green.
  it("rapid swipe bursts never resolve against a stale index (#10042 regression)", async () => {
    const burstable: Exclude<Action, "select">[] = ["next", "prev", "new"];
    const fire = (ctl: Ctl, action: Action): void => {
      if (action === "next") ctl.conversationNav.goNext();
      else if (action === "prev") ctl.conversationNav.goPrev();
      else if (action === "new") ctl.clearConversation();
    };
    for (let seed = 1; seed <= 12; seed++) {
      wireMutableConversations(["a", "b", "c", "d", "e"]);
      const { result, rerender, unmount } = renderHook(() =>
        useShellController(),
      );
      const rng = mulberry32(seed * 0x85ebca6b);
      for (let stepN = 0; stepN < 25; stepN++) {
        const a = burstable[Math.floor(rng() * burstable.length)];
        const b = burstable[Math.floor(rng() * burstable.length)];
        // Both ops read the SAME `result.current` (no rerender between), so the
        // second runs against the first's about-to-be-stale closure/index.
        await act(async () => {
          fire(result.current, a);
          fire(result.current, b);
          await vi.advanceTimersByTimeAsync(0);
        });
        rerender();
        assertInvariants(result.current);
      }
      unmount();
    }
  });
});

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  dispose: Mock<() => void>;
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
function fireFinalTranscript(
  text: string,
  extra: Partial<Parameters<NonNullable<CaptureOpts["onTranscript"]>>[0]> = {},
): void {
  lastCaptureOpts?.onTranscript?.({
    text,
    final: true,
    backend: "browser",
    ...extra,
  });
}

function makeWav(nSamples: number, sampleRate = 16000): Uint8Array {
  const dataBytes = nSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

describe("useShellController — voice capture routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lastCaptureOpts = null;
    captureHandles = [];
    createVoiceCaptureMock.mockReset();
    installFakeCapture();
    voiceOutputMock.speaking = false;
    // Default the mic grant to "unknown" (jsdom reality) so engage proceeds.
    micPermissionMock.state = "unknown";
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

  it("engage does not open the mic when the mic grant is known-denied", async () => {
    // The OS revoked the installed-PWA grant. The once-per-mount boot probe
    // seeds micPermission "denied"; a hands-free tap must then short-circuit
    // with the "re-enable mic" affordance instead of opening a mic that would
    // reject through getUserMedia.
    micPermissionMock.state = "denied";
    const { result } = renderHook(() => useShellController());
    // Flush the boot permission probe so micPermission is "denied".
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.micPermission).toBe("denied");

    await act(async () => {
      result.current.toggleHandsFree();
    });

    // No capture opened, hands-free stayed at rest, and the affordance surfaced.
    expect(createVoiceCaptureMock).not.toHaveBeenCalled();
    expect(result.current.handsFree).toBe(false);
    expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Microphone access is off"),
      "error",
      expect.any(Number),
    );
  });

  it("recheckMicPermission recovers to 'granted' and clears the block", async () => {
    micPermissionMock.state = "denied";
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.micPermission).toBe("denied");

    // User grants permission in settings, then the affordance's re-check runs.
    micPermissionMock.state = "granted";
    await act(async () => {
      await result.current.recheckMicPermission();
    });
    expect(result.current.micPermission).toBe("granted");

    // A subsequent engage now opens the mic normally.
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);
  });

  it("a denied to re-enable tap engages on the first retry via a fresh probe", async () => {
    // The last-known state can be stale "denied" after the user has since
    // re-enabled permission in settings. The first retry tap must re-probe and
    // engage instead of spending the tap on the stale ref.
    micPermissionMock.state = "denied";
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.micPermission).toBe("denied");

    // User re-enables permission in system settings (ref is still stale-denied
    // — no recheck has run yet). The next tap must catch the recovery itself.
    micPermissionMock.state = "granted";
    await act(async () => {
      result.current.toggleHandsFree();
    });

    expect(result.current.handsFree).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);
    // The stale-denied notice must not fire on this successful retry.
    expect(appMock.value.setActionNotice).not.toHaveBeenCalledWith(
      expect.stringContaining("Microphone access is off"),
      "error",
      expect.any(Number),
    );
    // And always-on is persisted so a reload restores the recovered loop.
    expect(
      window.localStorage.getItem("eliza:voice:continuous-chat-mode"),
    ).toBe("always-on");
  });

  it("a successful capture clears a stale 'denied' mic-permission state", async () => {
    // getUserMedia succeeding proves the grant is live: a prior "denied" must
    // not linger on micPermission after a successful push-to-talk/dictation
    // open, or the re-enable affordance stays lit despite working access.
    micPermissionMock.state = "denied";
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.micPermission).toBe("denied");

    // A push-to-talk dictation capture opens successfully (fake capture always
    // resolves start()). That success must clear the stale denied state.
    await act(async () => {
      result.current.startRecording("dictate");
    });
    expect(result.current.recording).toBe(true);
    expect(result.current.micPermission).toBe("granted");
  });

  it("a denied background refresh rolls back a phantom always-on engage", async () => {
    // Fast-path engage while a reply is responding: onProceed sets handsFree but
    // does not open capture yet (gated on !responding). If the background
    // refresh then discovers the grant is revoked, the shell must not stay in a
    // phantom always-on state — it rolls back to rest with the affordance.
    // Mount with a reply already in flight so `responding` is true from the
    // first render (voice gated → no capture opens on engage).
    micPermissionMock.state = "unknown";
    voiceOutputMock.speaking = true;
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.micPermission).toBe("unknown");
    expect(result.current.responding).toBe(true);

    // The grant is actually revoked; the background refresh will discover it.
    micPermissionMock.state = "denied";

    await act(async () => {
      result.current.toggleHandsFree();
      // Flush the background recheckMicPermission promise.
      await Promise.resolve();
      await Promise.resolve();
    });

    // No capture opened (was gated), and the phantom always-on was rolled back.
    expect(createVoiceCaptureMock).not.toHaveBeenCalled();
    expect(result.current.handsFree).toBe(false);
    expect(result.current.micPermission).toBe("denied");
    voiceOutputMock.speaking = false;
  });

  it("voice-settings apply always-on engages the mounted hands-free shell", async () => {
    const { result } = renderHook(() => useShellController());
    expect(result.current.handsFree).toBe(false);

    await act(async () => {
      emitViewEvent(
        VOICE_SETTINGS_APPLY_EVENT,
        { continuous: "always-on" },
        "agent",
      );
      await Promise.resolve();
    });

    expect(result.current.handsFree).toBe(true);
    expect(result.current.isOpen).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);
    expect(captureHandles[0]?.start).toHaveBeenCalledTimes(1);
  });

  it("voice-settings apply off stops the mounted hands-free shell", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      emitViewEvent(VOICE_SETTINGS_APPLY_EVENT, { continuous: "off" }, "agent");
      await Promise.resolve();
    });

    expect(result.current.handsFree).toBe(false);
    expect(captureHandles[0]?.stop).toHaveBeenCalledTimes(1);
    expect(voiceOutputMock.stopSpeaking).toHaveBeenCalled();
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

  it("boot always-on does not engage when the mic grant is denied", async () => {
    // Persisted always-on + a revoked OS grant: the boot effect must await the
    // fresh permission probe (the ref isn't seeded yet on the boot tick) and
    // stay disengaged instead of opening a mic getUserMedia would reject.
    micPermissionMock.state = "denied";
    window.localStorage.setItem(
      "eliza:voice:continuous-chat-mode",
      "always-on",
    );

    const { result } = renderHook(() => useShellController());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(result.current.handsFree).toBe(false);
    expect(createVoiceCaptureMock).not.toHaveBeenCalled();
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

  // ── #voice-V1: capture survives app suspend on iOS PWA ──
  //
  // The installed web PWA gets APP_PAUSE/APP_RESUME from #15179's lifecycle
  // bridge on background/foreground. Mid-capture the WAV recorder's WebAudio
  // graph stalls on suspend; without teardown the shell is stuck in a phantom
  // recording state with an orphaned mic. These assert the pause discards the
  // capture (dispose → recorder.cancel releases the mic) and resume re-arms.
  it("APP_PAUSE discards an in-flight hands-free capture and resets recording", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(result.current.handsFree).toBe(true);
    expect(result.current.recording).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    // Background the app mid-capture.
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-pause"));
    });

    // The capture is discarded via dispose() (recorder.cancel releases the
    // MediaStream tracks — the iOS mic indicator drops), NOT drained via stop()
    // (which would POST an empty/truncated WAV and throw). Recording UI resets
    // so a resume re-arms from a clean idle, but hands-free intent is retained.
    expect(captureHandles[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(captureHandles[0]?.stop).not.toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
    expect(result.current.handsFree).toBe(true);
  });

  it("APP_RESUME re-arms the mic after a suspend when hands-free was live", async () => {
    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.toggleHandsFree();
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-pause"));
    });
    expect(result.current.recording).toBe(false);

    // Foreground: capture re-opens without a user tap (a fresh factory call).
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-resume"));
      await Promise.resolve();
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(2);
    expect(captureHandles[1]?.start).toHaveBeenCalledTimes(1);
    expect(result.current.recording).toBe(true);
  });

  it("APP_RESUME does NOT re-arm the mic when hands-free was never engaged", async () => {
    renderHook(() => useShellController());
    // No capture running, not hands-free.
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-pause"));
    });
    await act(async () => {
      document.dispatchEvent(new Event("eliza:app-resume"));
      await Promise.resolve();
    });
    // Nothing to re-arm — no phantom capture is created on resume.
    expect(createVoiceCaptureMock).not.toHaveBeenCalled();
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
      audioWav: Uint8Array | null;
    }> = [];
    act(() =>
      result.current.setTranscriptSessionSink((segments, startedAt, audioWav) =>
        sessions.push({
          segments: segments as Array<{ text: string }>,
          startedAt,
          audioWav,
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

  it("waits for stop-drained transcript audio before finalizing the session", async () => {
    const capturedWav = makeWav(1600);
    createVoiceCaptureMock.mockImplementationOnce((opts: CaptureOpts) => {
      lastCaptureOpts = opts;
      const handle = {
        start: vi.fn(() => Promise.resolve()),
        stop: vi.fn(async () => {
          await Promise.resolve();
          opts.onTranscript?.({
            text: "captured note",
            final: true,
            backend: "local-inference",
            audioWav: capturedWav,
          });
          opts.onStateChange?.("stopped");
        }),
        dispose: vi.fn(),
        getAnalyser: vi.fn(() => null),
      };
      captureHandles.push(handle);
      return handle as never;
    });

    const { result } = renderHook(() => useShellController());
    const sessions = sinkSessions(result);
    await act(async () => {
      await result.current.toggleTranscriptionMode();
    });
    await act(async () => {
      await result.current.toggleTranscriptionMode();
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((s) => s.text)).toEqual(["captured note"]);
    expect(sessions[0].audioWav?.byteLength).toBeGreaterThan(1000);
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

  it("keeps recording through a composer draft (additive layer — no silent pause)", async () => {
    const { result } = renderHook(() => useShellController());
    const sessions = sinkSessions(result);
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(1);

    // The user types notes alongside the recording (transcription is additive:
    // "the composer keeps working; the mic stays on the whole time").
    act(() => result.current.setComposerHasDraft(true));
    act(() => fireFinalTranscript("first chunk of the meeting"));

    // A one-shot backend (local-inference) ends the capture on end-of-turn
    // silence — a CLEAN auto-stop, not a user stop.
    act(() => lastCaptureOpts?.onStateChange?.("stopped"));
    expect(result.current.recording).toBe(false);

    // The re-listen loop must re-open the capture even though a draft exists;
    // gating on the draft silently dropped meeting audio while the badge still
    // said "Transcribing".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.transcriptionMode).toBe(true);
    expect(createVoiceCaptureMock).toHaveBeenCalledTimes(2);

    // Later utterances keep landing in the SAME session.
    act(() => fireFinalTranscript("second chunk after typing"));
    await act(async () => {
      result.current.toggleTranscriptionMode();
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.map((s) => s.text)).toEqual([
      "first chunk of the meeting",
      "second chunk after typing",
    ]);
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

// ── FIX 1: conversation switch/clear stops in-flight TTS + resets the latch ───
// A voice reply that is still being spoken must not bleed into the conversation
// the user swipes/clears into, and the "speak the next turn" latch (lastTurnVoice)
// must not be inherited by the target thread. Both the swipe/select path and the
// clear path must (a) stop in-flight TTS and (b) reset lastTurnVoice.
describe("useShellController — conversation change stops TTS + resets voice latch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    voiceOutputMock.speaking = false;
    voiceOutputMock.stopSpeaking.mockClear();
    voiceOutputMock.lastTurnVoiceSeen = undefined;
    appMock.value.sendChatText.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("swiping to another conversation stops in-flight TTS and clears lastTurnVoice", async () => {
    appMock.value.conversations = [{ id: "a" }, { id: "b" }];
    appMock.value.activeConversationId = "a";

    const { result } = renderHook(() => useShellController());

    // The last turn was voice → the latch is set (the reply gets spoken).
    act(() =>
      result.current.send("what's the weather", { channelType: "VOICE_DM" }),
    );
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(true);

    voiceOutputMock.stopSpeaking.mockClear();
    await act(async () => {
      result.current.conversationNav.goNext();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(appMock.value.handleSelectConversation).toHaveBeenCalledWith("b");
    // (a) in-flight speech is stopped, (b) the latch is reset for the new thread.
    expect(voiceOutputMock.stopSpeaking).toHaveBeenCalled();
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(false);
  });

  it("clearing the conversation stops in-flight TTS and clears lastTurnVoice", async () => {
    const { result } = renderHook(() => useShellController());

    act(() =>
      result.current.send("remind me later", { channelType: "VOICE_DM" }),
    );
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(true);

    voiceOutputMock.stopSpeaking.mockClear();
    await act(async () => {
      result.current.clearConversation();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(voiceOutputMock.stopSpeaking).toHaveBeenCalled();
    expect(voiceOutputMock.lastTurnVoiceSeen).toBe(false);
  });
});

// ── FIX 2: a swallowed mic permission / capture-start failure surfaces a notice ─
describe("useShellController — mic capture-failure notice", () => {
  beforeEach(() => {
    createVoiceCaptureMock.mockReset();
    appMock.value.setActionNotice.mockClear();
    appMock.value.agentStatus = { ...READY_STATUS };
    voiceOutputMock.speaking = false;
    try {
      window.localStorage.clear();
    } catch {}
  });

  /** Install a capture whose start() rejects with the given error. */
  function installRejectingCapture(err: unknown): void {
    createVoiceCaptureMock.mockImplementation(
      () =>
        ({
          start: vi.fn(() => Promise.reject(err)),
          stop: vi.fn(() => Promise.resolve()),
          dispose: vi.fn(),
          getAnalyser: vi.fn(() => null),
        }) as never,
    );
  }

  /** Let the start() promise chain (.then → .catch) settle under real timers. */
  async function flushCaptureStart(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("surfaces a permission-denied notice (NotAllowedError) instead of failing silently", async () => {
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    installRejectingCapture(denied);

    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.startRecording();
    });
    await flushCaptureStart();

    expect(appMock.value.setActionNotice).toHaveBeenCalledTimes(1);
    const [text, tone] = appMock.value.setActionNotice.mock.calls[0] as [
      string,
      string,
    ];
    expect(text.toLowerCase()).toContain("permission");
    expect(tone).toBe("error");
    // Recording state is cleaned up (not stuck "on").
    expect(result.current.recording).toBe(false);
  });

  it("distinguishes a missing device (NotFoundError) from a denial", async () => {
    const missing = new Error("Requested device not found");
    missing.name = "NotFoundError";
    installRejectingCapture(missing);

    const { result } = renderHook(() => useShellController());
    await act(async () => {
      result.current.startRecording();
    });
    await flushCaptureStart();

    expect(appMock.value.setActionNotice).toHaveBeenCalledTimes(1);
    const [text, tone] = appMock.value.setActionNotice.mock.calls[0] as [
      string,
      string,
    ];
    expect(text.toLowerCase()).toContain("microphone");
    expect(text.toLowerCase()).not.toContain("permission");
    expect(tone).toBe("error");
  });
});

// ── FIX 3: the Settings wake-word toggle actually gates wake listening ────────
describe("useShellController — wake-word enablement", () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {}
  });

  it("enables wake listening by default (no stored pref)", () => {
    renderHook(() => useShellController());
    expect(wakeListenMock.lastEnabled).toBe(true);
  });

  it("disables wake listening when the persisted pref is off", () => {
    window.localStorage.setItem("eliza:voice:wake-word-enabled", "false");
    renderHook(() => useShellController());
    expect(wakeListenMock.lastEnabled).toBe(false);
  });

  it("re-enables wake listening when the pref is on", () => {
    window.localStorage.setItem("eliza:voice:wake-word-enabled", "true");
    renderHook(() => useShellController());
    expect(wakeListenMock.lastEnabled).toBe(true);
  });
});

// ── No LLM/model provider configured → route to Settings, no forever spinner ──
// When no provider is wired the server keeps `canRespond: false` forever, so the
// shell's `ready` never flips and it would sit in the "Waking …" boot phase with
// an infinite spinner. The server also stamps the send's assistant turn with
// `failureKind: "no_provider"` — the authoritative "no LLM configured" signal.
// The controller surfaces it as `noProviderConfigured` (so the overlay swaps the
// boot spinner for the real error gate) and auto-navigates to Settings.
describe("useShellController — no provider configured", () => {
  beforeEach(() => {
    appMock.value.setTab.mockClear();
    // A running agent that can't respond — exactly the no-provider shape (also
    // what a warm-up looks like until the send comes back tagged no_provider).
    appMock.value.agentStatus = { state: "running", canRespond: false };
  });

  it("is false with no messages, and does NOT navigate to Settings", () => {
    appMock.value.conversationMessages = [];
    const { result } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(false);
    expect(appMock.value.setTab).not.toHaveBeenCalled();
  });

  it("is false for a normal assistant reply (a warm-up that succeeded)", () => {
    appMock.value.conversationMessages = [
      { id: "u1", role: "user", text: "hi", timestamp: 1 },
      { id: "a1", role: "assistant", text: "hello!", timestamp: 2 },
    ];
    const { result } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(false);
    expect(appMock.value.setTab).not.toHaveBeenCalled();
  });

  it("detects a no_provider assistant turn and navigates to Settings once", () => {
    appMock.value.conversationMessages = [
      { id: "u1", role: "user", text: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "This agent has no LLM provider configured.",
        timestamp: 2,
        failureKind: "no_provider",
      },
    ];
    const { result, rerender } = renderHook(() => useShellController());

    expect(result.current.noProviderConfigured).toBe(true);
    // Auto-navigated straight to where the provider is configured.
    expect(appMock.value.setTab).toHaveBeenCalledWith("settings");
    // Even though the agent still reports canRespond:false, the shell is NOT
    // silently stuck — the condition is surfaced, not hidden behind a spinner.
    expect(result.current.phase).toBe("booting");

    // Idempotent: a re-render (e.g. streamed token churn) must not re-navigate.
    appMock.value.setTab.mockClear();
    rerender();
    expect(appMock.value.setTab).not.toHaveBeenCalled();
  });

  it("ignores a stale no_provider turn once the agent CAN respond", () => {
    // The failure stamp is persisted in conversation history, so on a later app
    // launch / conversation switch the latest assistant turn can still be the
    // old no_provider gate even though a provider has since been configured.
    // The live server truth (canRespond: true) must veto the history stamp —
    // no flag, no Settings hijack.
    appMock.value.agentStatus = { state: "running", canRespond: true };
    appMock.value.conversationMessages = [
      { id: "u1", role: "user", text: "hi", timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        text: "This agent has no LLM provider configured.",
        timestamp: 2,
        failureKind: "no_provider",
      },
    ];
    const { result } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(false);
    expect(appMock.value.setTab).not.toHaveBeenCalled();
  });

  it("does not trigger off history while the status is still unknown", () => {
    // Before the first status broadcast there is no server verdict; only a
    // definitive canRespond === false may confirm the persisted history stamp.
    appMock.value.agentStatus = null;
    appMock.value.conversationMessages = [
      {
        id: "a1",
        role: "assistant",
        text: "no provider",
        timestamp: 2,
        failureKind: "no_provider",
      },
    ];
    const { result } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(false);
    expect(appMock.value.setTab).not.toHaveBeenCalled();
  });

  it("clears once a later successful reply lands (provider wired in Settings)", () => {
    appMock.value.conversationMessages = [
      {
        id: "a1",
        role: "assistant",
        text: "no provider",
        timestamp: 2,
        failureKind: "no_provider",
      },
    ];
    const { result, rerender } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(true);

    // Provider added → the agent can respond, and the newest assistant turn is a
    // real answer with no failureKind.
    appMock.value.agentStatus = { state: "running", canRespond: true };
    appMock.value.conversationMessages = [
      {
        id: "a1",
        role: "assistant",
        text: "no provider",
        timestamp: 2,
        failureKind: "no_provider",
      },
      { id: "u2", role: "user", text: "hi again", timestamp: 3 },
      {
        id: "a2",
        role: "assistant",
        text: "hi! how can I help?",
        timestamp: 4,
      },
    ];
    rerender();

    expect(result.current.noProviderConfigured).toBe(false);
    // Ready now → out of the booting phase, no spinner.
    expect(result.current.phase).not.toBe("booting");
  });

  it("re-arms: a fresh no_provider miss after recovery navigates again", () => {
    appMock.value.conversationMessages = [
      { id: "a1", role: "assistant", text: "ok", timestamp: 2 },
    ];
    const { result, rerender } = renderHook(() => useShellController());
    expect(result.current.noProviderConfigured).toBe(false);
    expect(appMock.value.setTab).not.toHaveBeenCalled();

    appMock.value.conversationMessages = [
      { id: "a1", role: "assistant", text: "ok", timestamp: 2 },
      {
        id: "a2",
        role: "assistant",
        text: "no provider",
        timestamp: 3,
        failureKind: "no_provider",
      },
    ];
    rerender();

    expect(result.current.noProviderConfigured).toBe(true);
    expect(appMock.value.setTab).toHaveBeenCalledWith("settings");
    expect(appMock.value.setTab).toHaveBeenCalledTimes(1);
  });
});
