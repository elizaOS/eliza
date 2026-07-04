// @vitest-environment jsdom
//
// Rapid-conversation-switch data-loss race.
//
// handleSelectConversation / handleNewConversation silently delete the
// PREVIOUS conversation when it looks like an empty greeting-only draft — but
// they judged it from `conversationMessagesRef`, which useDataLoaders only
// commits AFTER a fetch resolves. During a rapid draft → B → C switch the ref
// still held the DRAFT's greeting while B's fetch was in flight, so B — a real
// conversation with real history — was judged "empty draft" and permanently
// deleted server-side (`client.deleteConversation(B)` with a swallowed catch).
//
// The fix binds the emptiness check to the conversation the ref actually
// holds: useDataLoaders writes `loadedConversationIdRef` in lockstep with
// every `conversationMessagesRef` commit, and the cleanup/replace paths only
// run when that id matches the previous conversation. On a mismatch the
// cleanup is skipped entirely — a genuinely empty orphan is reaped later by
// the server-side cleanupEmptyConversations({ keepId }) sweep that
// handleNewConversation fires after every create.
//
// This suite drives the REAL handleSelectConversation / handleNewConversation
// (real useChatCallbacks + real useChatSend interrupt) composed with the REAL
// useDataLoaders.loadConversationMessages, against a mocked client whose
// getConversationMessages resolves on command — reproducing the exact race.

import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import type { LifecycleAction } from "./internal";
import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

const mocks = vi.hoisted(() => ({
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    cleanupEmptyConversations: vi.fn(),
    requestGreeting: vi.fn(),
    sendWsMessage: vi.fn(),
    getStatus: vi.fn(),
    getBaseUrl: vi.fn(() => ""),
    getConfig: vi.fn(),
    abortConversationTurn: vi.fn(),
    truncateConversationMessages: vi.fn(),
    renameConversation: vi.fn(),
    stopCodingAgent: vi.fn(),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

// useChatLifecycle owns start/stop/reset flows that are irrelevant here and
// starts readiness-poll timers on mount; stub it so this suite exercises ONLY
// the real select / new-conversation handlers (plus the real useChatSend
// interrupt they call).
vi.mock("./useChatLifecycle", () => ({ useChatLifecycle: () => ({}) }));

import {
  type UseChatCallbacksDeps,
  useChatCallbacks,
} from "./useChatCallbacks";

// ── Fixtures ──────────────────────────────────────────────────────────

function conversationRecord(id: string): Conversation {
  return {
    id,
    roomId: `room-${id}`,
    title: "New Chat",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

/** A persisted bootstrap greeting — the entire content of an empty draft. */
function greetingMessage(): ConversationMessage {
  return {
    id: "greeting-1",
    role: "assistant",
    text: "hey — what's on your mind?",
    timestamp: 1,
    source: MESSAGE_SOURCE_AGENT_GREETING,
  };
}

/** Real history: the conversation the bug used to delete. */
function realHistory(prefix: string): ConversationMessage[] {
  return [
    {
      id: `${prefix}-u1`,
      role: "user",
      text: "months of important history",
      timestamp: 1,
    },
    { id: `${prefix}-a1`, role: "assistant", text: "noted", timestamp: 2 },
  ];
}

// ── Harness ───────────────────────────────────────────────────────────

interface PendingLoad {
  resolve: (messages: ConversationMessage[]) => void;
}

interface Harness {
  loaderDeps: DataLoadersDeps;
  callbackDepsBase: Omit<
    UseChatCallbacksDeps,
    | "loadConversations"
    | "loadConversationMessages"
    | "prefetchConversationMessages"
    | "loadedConversationIdRef"
  >;
  activeConversationIdRef: MutableRefObject<string | null>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  /** Resolve the oldest in-flight getConversationMessages fetch for `id`. */
  resolveLoad: (id: string, messages: ConversationMessage[]) => void;
  deletedConversationIds: () => string[];
}

function makeHarness(seedConversations: Conversation[]): Harness {
  const activeConversationIdRef: MutableRefObject<string | null> = {
    current: null,
  };
  const conversationMessagesRef: MutableRefObject<ConversationMessage[]> = {
    current: [],
  };
  const conversationsRef: MutableRefObject<Conversation[]> = {
    current: [...seedConversations],
  };
  const unreadRef: MutableRefObject<Set<string>> = { current: new Set() };
  const conversationHydrationEpochRef: MutableRefObject<number> = {
    current: 0,
  };
  const greetingFiredRef: MutableRefObject<boolean> = { current: false };
  const greetingInFlightConversationRef: MutableRefObject<string | null> = {
    current: null,
  };
  const chatInputRef: MutableRefObject<string> = { current: "" };
  const chatPendingImagesRef: MutableRefObject<ImageAttachment[]> = {
    current: [],
  };

  // Mimic useChatState's setters: they sync the paired ref on every write.
  const setConversations: UseChatCallbacksDeps["setConversations"] = (v) => {
    conversationsRef.current =
      typeof v === "function" ? v(conversationsRef.current) : v;
  };
  const setConversationMessages: UseChatCallbacksDeps["setConversationMessages"] =
    (v) => {
      conversationMessagesRef.current =
        typeof v === "function" ? v(conversationMessagesRef.current) : v;
    };
  const setActiveConversationId: UseChatCallbacksDeps["setActiveConversationId"] =
    (v) => {
      activeConversationIdRef.current = v;
    };
  const setUnreadConversations: UseChatCallbacksDeps["setUnreadConversations"] =
    (v) => {
      unreadRef.current = typeof v === "function" ? v(unreadRef.current) : v;
    };
  // Mirrors useChatState.resetDraftState — the exact side effects the real
  // handleNewConversation runs before creating the fresh conversation.
  const resetConversationDraftState = (): void => {
    conversationHydrationEpochRef.current += 1;
    greetingFiredRef.current = false;
    greetingInFlightConversationRef.current = null;
    chatInputRef.current = "";
    chatPendingImagesRef.current = [];
    conversationMessagesRef.current = [];
    activeConversationIdRef.current = null;
  };

  // getConversationMessages resolves ON COMMAND (per conversation id) and
  // rejects with AbortError when a newer load aborts it — like the real client.
  const pendingLoads = new Map<string, PendingLoad[]>();
  mocks.client.getConversationMessages.mockImplementation(
    (id: string, opts?: { signal?: AbortSignal }) =>
      new Promise<{ messages: ConversationMessage[] }>((resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        const queue = pendingLoads.get(id) ?? [];
        queue.push({ resolve: (messages) => resolve({ messages }) });
        pendingLoads.set(id, queue);
      }),
  );
  mocks.client.listConversations.mockResolvedValue({
    conversations: [...seedConversations],
  });
  mocks.client.deleteConversation.mockResolvedValue({ ok: true });
  mocks.client.cleanupEmptyConversations.mockResolvedValue({ deleted: [] });
  let created = 0;
  mocks.client.createConversation.mockImplementation(async () => {
    created += 1;
    return {
      conversation: conversationRecord(`conv-new-${created}`),
      greeting: { text: "hi there", agentName: "Eliza", generated: true },
    };
  });
  mocks.client.requestGreeting.mockResolvedValue({
    text: "hi there",
    agentName: "Eliza",
    generated: true,
  });
  mocks.client.getStatus.mockResolvedValue({ state: "running" });
  mocks.client.getConfig.mockResolvedValue({ ui: {} });
  mocks.client.abortConversationTurn.mockResolvedValue({ aborted: true });
  mocks.client.getBaseUrl.mockReturnValue("");

  const autonomousStoreRef: MutableRefObject<AutonomyEventStore> = {
    current: { eventsById: {}, eventOrder: [], runIndex: {}, watermark: null },
  };
  const autonomousRunHealthByRunIdRef: MutableRefObject<AutonomyRunHealthMap> =
    { current: {} };

  const loaderDeps: DataLoadersDeps = {
    autonomousStoreRef,
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: vi.fn(),
    setAutonomousLatestEventId: vi.fn(),
    setAutonomousRunHealthByRunId: vi.fn(),
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: vi.fn(),
  };

  const callbackDepsBase: Harness["callbackDepsBase"] = {
    t: (key: string) => key,
    uiLanguage: "en",
    tab: "chat",
    agentStatus: null,
    chatInput: "",
    conversations: [...seedConversations],
    activeConversationId: null,
    companionMessageCutoffTs: 0,
    conversationMessages: [],
    ptySessions: [] as CodingAgentSession[],
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations,
    resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef: { current: null },
    chatSendBusyRef: { current: false },
    chatSendNonceRef: { current: 0 },
    greetingFiredRef,
    greetingInFlightConversationRef,
    lifecycleAction: null as LifecycleAction | null,
    beginLifecycleAction: vi.fn(() => true),
    finishLifecycleAction: vi.fn(),
    lifecycleBusyRef: { current: false },
    lifecycleActionRef: { current: null },
    setAgentStatus: vi.fn(),
    setActionNotice: vi.fn(),
    pendingRestart: false,
    pendingRestartReasons: [],
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setBackendDisconnectedBannerDismissed: vi.fn(),
    resetBackendConnection: vi.fn(),
    loadPlugins: vi.fn(async () => null),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
    elizaCloudPreferDisconnectedUntilLoginRef: { current: false },
    setElizaCloudEnabled: vi.fn(),
    setElizaCloudConnected: vi.fn(),
    setElizaCloudVoiceProxyAvailable: vi.fn(),
    setElizaCloudHasPersistedKey: vi.fn(),
    setElizaCloudCredits: vi.fn(),
    setElizaCloudCreditsLow: vi.fn(),
    setElizaCloudCreditsCritical: vi.fn(),
    setElizaCloudAuthRejected: vi.fn(),
    setElizaCloudCreditsError: vi.fn(),
    setElizaCloudTopUpUrl: vi.fn(),
    setElizaCloudUserId: vi.fn(),
    setElizaCloudStatusReason: vi.fn(),
    setElizaCloudLoginError: vi.fn(),
    firstRunComplete: false,
    firstRunCompletionCommittedRef: { current: false },
    setFirstRunUiRevealNonce: vi.fn(),
    setFirstRunLoading: vi.fn(),
    setFirstRunComplete: vi.fn(),
    setFirstRunDeferredTasks: vi.fn(),
    setPostFirstRunChecklistDismissed: vi.fn(),
    setFirstRunName: vi.fn(),
    setFirstRunStyle: vi.fn(),
    setFirstRunRuntimeTarget: vi.fn(),
    setFirstRunProvider: vi.fn(),
    setFirstRunRemoteConnected: vi.fn(),
    setFirstRunRemoteApiBase: vi.fn(),
    setFirstRunRemoteToken: vi.fn(),
    setFirstRunOptions: vi.fn(),
    setSelectedVrmIndex: vi.fn(),
    setCustomVrmUrl: vi.fn(),
    setCustomBackgroundUrl: vi.fn(),
    setPlugins: vi.fn(),
    setSkills: vi.fn(),
    setLogs: vi.fn(),
    coordinatorResetRef: { current: null },
  };

  return {
    loaderDeps,
    callbackDepsBase,
    activeConversationIdRef,
    conversationMessagesRef,
    conversationsRef,
    resolveLoad: (id, messages) => {
      pendingLoads.get(id)?.shift()?.resolve(messages);
    },
    deletedConversationIds: () =>
      mocks.client.deleteConversation.mock.calls.map(
        (call) => call[0] as string,
      ),
  };
}

/** Mount the REAL useDataLoaders + useChatCallbacks composed like AppContext. */
function mountChat(h: Harness) {
  return renderHook(() => {
    const loaders = useDataLoaders(h.loaderDeps);
    const callbacks = useChatCallbacks({
      ...h.callbackDepsBase,
      loadConversations: loaders.loadConversations,
      loadConversationMessages: loaders.loadConversationMessages,
      prefetchConversationMessages: loaders.prefetchConversationMessages,
      loadedConversationIdRef: loaders.loadedConversationIdRef,
    });
    return { loaders, callbacks };
  });
}

/** Select `id` and COMMIT its messages (the load resolves before returning). */
async function selectAndCommit(
  result: ReturnType<typeof mountChat>["result"],
  h: Harness,
  id: string,
  messages: ConversationMessage[],
): Promise<void> {
  await act(async () => {
    const selection = result.current.callbacks.handleSelectConversation(id);
    h.resolveLoad(id, messages);
    await selection;
  });
}

const SEED = [
  conversationRecord("draft-d"),
  conversationRecord("conv-b"),
  conversationRecord("conv-c"),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("rapid conversation switching must never delete a real conversation", () => {
  it("draft → B → C: B (real, load still in flight) is NOT judged by the draft's stale messages and survives", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    // Land on the greeting-only draft and let its load COMMIT.
    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "draft-d",
    );

    // Select REAL conversation B — its fetch stays IN FLIGHT (uncached).
    let selectB: Promise<void> = Promise.resolve();
    act(() => {
      selectB = result.current.callbacks.handleSelectConversation("conv-b");
    });
    // The committed draft is legitimately cleaned up…
    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    // …while the thread STILL holds the draft's greeting (B has not committed).
    expect(h.activeConversationIdRef.current).toBe("conv-b");
    expect(h.conversationMessagesRef.current).toEqual([greetingMessage()]);
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "draft-d",
    );

    // Before B's messages commit, select C. THE BUG: this call read
    // prevId=conv-b but prevMessages=[draft greeting] and fired
    // deleteConversation("conv-b") — permanent, server-side, swallowed catch.
    let selectC: Promise<void> = Promise.resolve();
    act(() => {
      selectC = result.current.callbacks.handleSelectConversation("conv-c");
    });
    await act(async () => {
      h.resolveLoad("conv-c", realHistory("c"));
      // B's superseded fetch resolves late; the abort path discards it.
      h.resolveLoad("conv-b", realHistory("b"));
      await Promise.all([selectB, selectC]);
    });

    // B was never deleted — not server-side, not from the local list.
    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    expect(h.conversationsRef.current.some((c) => c.id === "conv-b")).toBe(
      true,
    );
    // C's committed load owns the thread now.
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "conv-c",
    );
    expect(h.conversationMessagesRef.current).toEqual(realHistory("c"));
  });

  it("control: a COMMITTED greeting-only draft is still deleted on switch-away (legit cleanup keeps working)", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);

    let selectB: Promise<void> = Promise.resolve();
    act(() => {
      selectB = result.current.callbacks.handleSelectConversation("conv-b");
    });
    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    expect(h.conversationsRef.current.some((c) => c.id === "draft-d")).toBe(
      false,
    );

    await act(async () => {
      h.resolveLoad("conv-b", realHistory("b"));
      await selectB;
    });
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "conv-b",
    );
  });

  it("control: a committed REAL conversation is never cleaned up on switch-away", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "conv-b", realHistory("b"));
    await selectAndCommit(result, h, "conv-c", realHistory("c"));

    expect(mocks.client.deleteConversation).not.toHaveBeenCalled();
  });

  it("new-chat race: handleNewConversation must not delete a real conversation whose load has not committed", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    // Committed draft → select REAL B (fetch in flight; draft legitimately
    // reaped by the select cleanup).
    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);
    let selectB: Promise<void> = Promise.resolve();
    act(() => {
      selectB = result.current.callbacks.handleSelectConversation("conv-b");
    });
    expect(h.deletedConversationIds()).toEqual(["draft-d"]);

    // New chat while B's messages are still in flight. THE BUG: the replace
    // heuristic read previousId=conv-b but judged the draft's stale greeting,
    // so the fresh create deleted B.
    await act(async () => {
      await result.current.callbacks.handleNewConversation();
    });

    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    expect(h.conversationsRef.current.some((c) => c.id === "conv-b")).toBe(
      true,
    );
    // The fresh conversation is active and owns the thread…
    expect(h.activeConversationIdRef.current).toBe("conv-new-1");
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "conv-new-1",
    );
    // …and the server-side sweep (the safety net that reaps any skipped
    // orphan) still ran, keeping the fresh conversation.
    expect(mocks.client.cleanupEmptyConversations).toHaveBeenCalledWith({
      keepId: "conv-new-1",
    });

    // Let B's superseded fetch settle so nothing dangles past the test.
    await act(async () => {
      h.resolveLoad("conv-b", realHistory("b"));
      await selectB;
    });
  });

  it("new-chat control: a COMMITTED greeting-only draft is still replaced (deleted) by the fresh conversation", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);

    await act(async () => {
      await result.current.callbacks.handleNewConversation();
    });

    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    expect(h.conversationsRef.current.some((c) => c.id === "draft-d")).toBe(
      false,
    );
    expect(h.conversationsRef.current.some((c) => c.id === "conv-new-1")).toBe(
      true,
    );
    expect(h.activeConversationIdRef.current).toBe("conv-new-1");
    expect(result.current.loaders.loadedConversationIdRef.current).toBe(
      "conv-new-1",
    );
  });
});
