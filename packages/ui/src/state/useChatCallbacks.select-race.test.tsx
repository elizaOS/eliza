/** Verifies rapid conversation switching must never delete a real conversation through the package's configured test harness. */
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
import { logger } from "@elizaos/logger";
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import { CLOUD_HANDOFF_PHASE_EVENT } from "../events";
import type { AutonomyEventStore, AutonomyRunHealthMap } from "./autonomy";
import { readChatDraft } from "./ChatComposerContext.hooks";
import type { LifecycleAction } from "./internal";
import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

const mocks = vi.hoisted(() => ({
  runtimeAuthoritySwitchListeners: new Set<
    (phase: "before" | "after") => void
  >(),
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    cleanupEmptyConversations: vi.fn(),
    requestGreeting: vi.fn(),
    sendConversationMessageStream: vi.fn(),
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
vi.mock("./switch-runtime", () => ({
  subscribeRuntimeAuthoritySwitch: (
    listener: (phase: "before" | "after") => void,
  ) => {
    mocks.runtimeAuthoritySwitchListeners.add(listener);
    return () => mocks.runtimeAuthoritySwitchListeners.delete(listener);
  },
}));

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
    | "claimConversationMessagesOwnership"
    | "isConversationMessagesOwnershipCurrent"
    | "getConversationMessagesOwnershipGeneration"
    | "registerConversationMessageOverlay"
    | "applyConversationMessageOverlayModification"
    | "removeConversationMessageStateMessages"
    | "discardConversationMessageState"
    | "loadedConversationIdRef"
  >;
  activeConversationIdRef: MutableRefObject<string | null>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  chatInputRef: MutableRefObject<string>;
  chatPendingImagesRef: MutableRefObject<ImageAttachment[]>;
  greetingFiredRef: MutableRefObject<boolean>;
  greetingInFlightConversationRef: MutableRefObject<string | null>;
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
  const setChatInput: UseChatCallbacksDeps["setChatInput"] = vi.fn((v) => {
    chatInputRef.current = v;
  });
  const setChatPendingImages: UseChatCallbacksDeps["setChatPendingImages"] =
    vi.fn((v) => {
      chatPendingImagesRef.current = v;
    });
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
    setChatInput,
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations,
    setChatReplyTarget: vi.fn(),
    resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef: { current: null },
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
    chatInputRef,
    chatPendingImagesRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
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
      claimConversationMessagesOwnership:
        loaders.claimConversationMessagesOwnership,
      isConversationMessagesOwnershipCurrent:
        loaders.isConversationMessagesOwnershipCurrent,
      getConversationMessagesOwnershipGeneration:
        loaders.getConversationMessagesOwnershipGeneration,
      registerConversationMessageOverlay:
        loaders.registerConversationMessageOverlay,
      applyConversationMessageOverlayModification:
        loaders.applyConversationMessageOverlayModification,
      removeConversationMessageStateMessages:
        loaders.removeConversationMessageStateMessages,
      discardConversationMessageState: loaders.discardConversationMessageState,
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

async function flushPendingWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitRuntimeAuthoritySwitch(phase: "before" | "after"): void {
  for (const listener of mocks.runtimeAuthoritySwitchListeners) listener(phase);
}

const SEED = [
  conversationRecord("draft-d"),
  conversationRecord("conv-b"),
  conversationRecord("conv-c"),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeAuthoritySwitchListeners.clear();
  window.localStorage.clear();
});

describe("rapid conversation switching must never delete a real conversation", () => {
  it("fences a pending greeting across a same-id authority switch and hydrates B exactly once", async () => {
    const oldConversation = conversationRecord("authority-collision");
    const newConversation = {
      ...conversationRecord("authority-collision"),
      title: "Authority B initial",
    };
    const h = makeHarness([oldConversation]);
    const { result, unmount } = mountChat(h);
    await selectAndCommit(
      result,
      h,
      oldConversation.id,
      realHistory("authority-a"),
    );
    expect(mocks.runtimeAuthoritySwitchListeners.size).toBe(2);

    type GreetingResponse = {
      text: string;
      agentName: string;
      generated: boolean;
    };
    let resolveGreetingA: ((value: GreetingResponse) => void) | undefined;
    let resolveGreetingB: ((value: GreetingResponse) => void) | undefined;
    mocks.client.requestGreeting
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGreetingA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveGreetingB = resolve;
          }),
      );
    let greetingA: Promise<boolean>;
    act(() => {
      greetingA = result.current.callbacks.fetchGreeting(oldConversation.id);
    });
    expect(mocks.client.requestGreeting).toHaveBeenCalledTimes(1);

    mocks.client.listConversations.mockClear();
    mocks.client.getConversationMessages.mockClear();
    mocks.client.listConversations.mockResolvedValueOnce({
      conversations: [newConversation],
    });

    act(() => emitRuntimeAuthoritySwitch("before"));
    expect(h.conversationMessagesRef.current).toEqual([]);
    expect(h.conversationsRef.current).toEqual([]);
    expect(h.activeConversationIdRef.current).toBeNull();

    act(() => emitRuntimeAuthoritySwitch("after"));
    await flushPendingWork();
    expect(mocks.client.listConversations).toHaveBeenCalledTimes(1);
    expect(h.activeConversationIdRef.current).toBe(newConversation.id);
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);
    expect(mocks.client.getConversationMessages).toHaveBeenCalledWith(
      newConversation.id,
    );

    await act(async () => {
      h.resolveLoad(newConversation.id, []);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.client.requestGreeting).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resolveGreetingA?.({
        text: "private greeting from A",
        agentName: "A",
        generated: true,
      });
      await greetingA;
    });
    expect(h.conversationMessagesRef.current).toEqual([]);
    expect(h.greetingFiredRef.current).toBe(false);
    expect(h.greetingInFlightConversationRef.current).toBe(newConversation.id);

    // A's finally must not clear B's same-id flight. A duplicate B request is
    // still suppressed until the real B request resolves.
    await act(async () => {
      await expect(
        result.current.callbacks.fetchGreeting(newConversation.id),
      ).resolves.toBe(false);
    });
    expect(mocks.client.requestGreeting).toHaveBeenCalledTimes(2);

    act(() => {
      resolveGreetingB?.({
        text: "greeting from B",
        agentName: "B",
        generated: true,
      });
    });
    await vi.waitFor(() => {
      expect(h.conversationMessagesRef.current).toMatchObject([
        { role: "assistant", text: "greeting from B" },
      ]);
    });
    expect(mocks.client.listConversations).toHaveBeenCalledTimes(1);
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);
    expect(mocks.client.requestGreeting).toHaveBeenNthCalledWith(
      2,
      newConversation.id,
      "en",
    );
    expect(h.conversationsRef.current).toEqual([newConversation]);
    expect(h.greetingFiredRef.current).toBe(true);

    unmount();
    expect(mocks.runtimeAuthoritySwitchListeners.size).toBe(0);
  });

  it("drops a pre-switch getStatus result before it can request a greeting", async () => {
    const conversation = conversationRecord("status-authority-a");
    const h = makeHarness([conversation]);
    const { result } = mountChat(h);
    await selectAndCommit(result, h, conversation.id, realHistory("status-a"));
    let resolveStatus: ((value: { state: string }) => void) | undefined;
    mocks.client.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    mocks.client.requestGreeting.mockClear();

    let pendingStatusGreeting: Promise<void>;
    act(() => {
      pendingStatusGreeting =
        result.current.callbacks.requestGreetingWhenRunning(conversation.id);
    });
    act(() => emitRuntimeAuthoritySwitch("before"));
    await act(async () => {
      resolveStatus?.({ state: "running" });
      await pendingStatusGreeting;
    });

    expect(mocks.client.requestGreeting).not.toHaveBeenCalled();
  });

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
    // …while the uncached target clears the visible thread until B commits.
    expect(h.activeConversationIdRef.current).toBe("conv-b");
    expect(h.conversationMessagesRef.current).toEqual([]);
    expect(result.current.loaders.loadedConversationIdRef.current).toBeNull();

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

  // #12267: the empty-draft cleanup delete is best-effort (server-side sweep is
  // the backstop) but must NOT swallow its failure silently — a dropped delete
  // used to be invisible. Drive the real rejection and assert it surfaces.
  it("a failed empty-draft cleanup delete surfaces to the logger, not a silent swallow", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const h = makeHarness(SEED);
    mocks.client.deleteConversation.mockRejectedValue(
      new Error("server rejected delete"),
    );
    const { result } = mountChat(h);

    // Commit the greeting-only draft, then switch away — the real cleanup path
    // fires deleteConversation("draft-d"), which now rejects.
    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);
    await act(async () => {
      const selectB =
        result.current.callbacks.handleSelectConversation("conv-b");
      // Let the fire-and-forget delete's rejection propagate to its catch.
      await Promise.resolve();
      await Promise.resolve();
      h.resolveLoad("conv-b", realHistory("b"));
      await selectB;
    });

    expect(mocks.client.deleteConversation).toHaveBeenCalledWith("draft-d");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "draft-d" }),
      expect.stringContaining("failed to delete empty draft on select"),
    );
    warnSpy.mockRestore();
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

  it("new chat restores queued text and attachments after resetting the old draft", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    const queuedImage: ImageAttachment = {
      data: "AAAA",
      mimeType: "image/png",
      name: "queued.png",
    };

    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
          detail: { agentId: "agent-123", phase: "migrating" },
        }),
      );
    });

    let queuedSend!: Promise<void>;
    await act(async () => {
      queuedSend = result.current.callbacks.sendChatText("keep this", {
        conversationId: "conv-b",
        images: [queuedImage],
      });
      await Promise.resolve();
    });

    expect(h.chatInputRef.current).toBe("");
    expect(h.chatPendingImagesRef.current).toEqual([]);

    await act(async () => {
      await result.current.callbacks.handleNewConversation();
      await queuedSend;
    });

    expect(h.chatInputRef.current).toBe("keep this");
    expect(h.chatPendingImagesRef.current).toEqual([queuedImage]);
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("keeps a pending greeting valid across a same-id reload", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    mocks.client.createConversation.mockResolvedValueOnce({
      conversation: conversationRecord("conv-new-greeting-reload"),
    });
    let resolveGreeting:
      | ((value: {
          text: string;
          agentName: string;
          generated: boolean;
        }) => void)
      | undefined;
    mocks.client.requestGreeting.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGreeting = resolve;
        }),
    );

    const newConversation = result.current.callbacks.handleNewConversation();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.activeConversationIdRef.current).toBe("conv-new-greeting-reload");

    await act(async () => {
      const reload = result.current.loaders.loadConversationMessages(
        "conv-new-greeting-reload",
      );
      h.resolveLoad("conv-new-greeting-reload", []);
      await reload;
    });
    await act(async () => {
      resolveGreeting?.({
        text: "greeting after reload",
        agentName: "Eliza",
        generated: true,
      });
      await newConversation;
    });

    expect(h.conversationMessagesRef.current).toMatchObject([
      {
        role: "assistant",
        text: "greeting after reload",
        source: MESSAGE_SOURCE_AGENT_GREETING,
      },
    ]);
  });

  it("keeps a greeting that commits before an older same-id reload and converges without a phantom duplicate", async () => {
    const conversationId = "conv-greeting-before-reload";
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    mocks.client.createConversation.mockResolvedValueOnce({
      conversation: conversationRecord(conversationId),
    });
    let resolveGreeting:
      | ((value: {
          text: string;
          agentName: string;
          generated: boolean;
        }) => void)
      | undefined;
    mocks.client.requestGreeting.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGreeting = resolve;
        }),
    );

    const newConversation = result.current.callbacks.handleNewConversation();
    await Promise.resolve();
    await Promise.resolve();
    let staleReload: Promise<unknown>;
    act(() => {
      staleReload =
        result.current.loaders.loadConversationMessages(conversationId);
    });
    await act(async () => {
      resolveGreeting?.({
        text: "owned greeting",
        agentName: "Eliza",
        generated: true,
      });
      await newConversation;
    });
    const localGreeting = h.conversationMessagesRef.current[0];
    expect(localGreeting).toMatchObject({
      role: "assistant",
      text: "owned greeting",
      source: MESSAGE_SOURCE_AGENT_GREETING,
    });
    expect(localGreeting?.clientRenderId).toMatch(/^temp-greeting-/);
    expect(h.greetingFiredRef.current).toBe(true);

    await act(async () => {
      h.resolveLoad(conversationId, []);
      await staleReload;
    });
    expect(h.conversationMessagesRef.current).toEqual([localGreeting]);
    expect(h.greetingFiredRef.current).toBe(true);

    const serverGreeting: ConversationMessage = {
      id: "server-greeting",
      role: "assistant",
      text: "owned greeting",
      timestamp: localGreeting?.timestamp ?? Date.now(),
      source: MESSAGE_SOURCE_AGENT_GREETING,
    };
    await act(async () => {
      const convergence =
        result.current.loaders.loadConversationMessages(conversationId);
      h.resolveLoad(conversationId, [serverGreeting]);
      await convergence;
    });
    expect(h.conversationMessagesRef.current).toEqual([serverGreeting]);

    mocks.client.requestGreeting.mockResolvedValueOnce({
      text: "discarded duplicate",
      agentName: "Eliza",
      generated: true,
    });
    await act(async () => {
      await result.current.callbacks.fetchGreeting(conversationId);
    });
    expect(h.conversationMessagesRef.current).toEqual([serverGreeting]);

    await act(async () => {
      const noPhantom =
        result.current.loaders.loadConversationMessages(conversationId);
      h.resolveLoad(conversationId, []);
      await noPhantom;
    });
    expect(h.conversationMessagesRef.current).toEqual([]);
  });

  it("does not let a delayed new-chat greeting overwrite a turn sent meanwhile", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    mocks.client.createConversation.mockResolvedValueOnce({
      conversation: conversationRecord("conv-new-greeting"),
    });
    let resolveGreeting:
      | ((value: {
          text: string;
          agentName: string;
          generated: boolean;
        }) => void)
      | undefined;
    mocks.client.requestGreeting.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGreeting = resolve;
        }),
    );
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "terminal reply",
      completed: true,
      userMessageId: "sent-user",
      messageId: "sent-assistant",
    });
    mocks.client.renameConversation.mockResolvedValue({
      conversation: conversationRecord("conv-new-greeting"),
    });

    const newConversation = result.current.callbacks.handleNewConversation();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.activeConversationIdRef.current).toBe("conv-new-greeting");
    expect(mocks.client.requestGreeting).toHaveBeenCalledWith(
      "conv-new-greeting",
      "en",
    );

    const sentTurn = result.current.callbacks.sendChatText(
      "sent before greeting",
      {
        conversationId: "conv-new-greeting",
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.client.sendConversationMessageStream).toHaveBeenCalled();
    await act(async () => {
      await sentTurn;
    });
    expect(h.conversationMessagesRef.current).toMatchObject([
      { id: "sent-user", text: "sent before greeting" },
      { id: "sent-assistant", text: "terminal reply" },
    ]);

    await act(async () => {
      resolveGreeting?.({
        text: "late greeting",
        agentName: "Eliza",
        generated: true,
      });
      await newConversation;
    });

    expect(h.activeConversationIdRef.current).toBe("conv-new-greeting");
    expect(h.conversationMessagesRef.current).toMatchObject([
      { id: "sent-user", text: "sent before greeting" },
      { id: "sent-assistant", text: "terminal reply" },
    ]);
    expect(
      h.conversationMessagesRef.current.some(
        (message) => message.text === "late greeting",
      ),
    ).toBe(false);
  });

  it("new-chat rollback keeps the flushed partial and does not resurrect a cancelled queued row", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "conv-b", realHistory("b"));
    mocks.client.sendConversationMessageStream.mockImplementation(
      (
        _conversationId: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
        _channelType: string,
        signal: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          onToken("partial", "partial reply");
          signal.addEventListener(
            "abort",
            () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            },
            { once: true },
          );
        }),
    );
    mocks.client.createConversation.mockRejectedValueOnce(new Error("offline"));

    let activeSend!: Promise<void>;
    let queuedSend!: Promise<void>;
    act(() => {
      activeSend = result.current.callbacks.sendChatText("active question", {
        conversationId: "conv-b",
      });
    });
    await flushPendingWork();
    act(() => {
      queuedSend = result.current.callbacks.sendChatText("queued question", {
        conversationId: "conv-b",
      });
    });
    await flushPendingWork();

    await act(async () => {
      await Promise.all([
        result.current.callbacks.handleNewConversation(),
        activeSend,
        queuedSend,
      ]);
    });

    expect(h.activeConversationIdRef.current).toBe("conv-b");
    expect(h.chatInputRef.current).toBe("queued question");
    expect(
      h.conversationMessagesRef.current.filter(
        (message) => message.text === "queued question",
      ),
    ).toEqual([]);
    expect(h.conversationMessagesRef.current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "active question" }),
        expect.objectContaining({
          role: "assistant",
          text: "partial reply",
        }),
      ]),
    );
  });

  it("conversation selection parks cancelled queued text and images on the source conversation", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    const queuedImage: ImageAttachment = {
      data: "BBBB",
      mimeType: "image/png",
      name: "source-only.png",
    };

    await selectAndCommit(result, h, "conv-b", realHistory("b"));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CLOUD_HANDOFF_PHASE_EVENT, {
          detail: { agentId: "agent-123", phase: "migrating" },
        }),
      );
    });

    let queuedSend!: Promise<void>;
    await act(async () => {
      queuedSend = result.current.callbacks.sendChatText("stay with B", {
        conversationId: "conv-b",
        images: [queuedImage],
      });
      await Promise.resolve();
    });

    await selectAndCommit(result, h, "conv-c", realHistory("c"));
    await queuedSend;

    expect(readChatDraft("conv-b")).toBe("stay with B");
    expect(h.chatInputRef.current).toBe("");
    expect(h.chatPendingImagesRef.current).toEqual([]);

    await selectAndCommit(result, h, "conv-b", realHistory("b-return"));

    expect(h.chatInputRef.current).toBe("stay with B");
    expect(h.chatPendingImagesRef.current).toEqual([queuedImage]);
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
  });

  it("waits for a cold startup hydration before routing an action send", async () => {
    const h = makeHarness([]);
    const { result } = mountChat(h);
    let resolveHydrationCreate:
      | ((value: { conversation: Conversation }) => void)
      | undefined;
    mocks.client.createConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHydrationCreate = resolve;
        }),
    );
    mocks.client.listConversations
      .mockResolvedValueOnce({ conversations: [] })
      .mockResolvedValue({
        conversations: [conversationRecord("conv-hydrated")],
      });
    mocks.client.sendConversationMessageStream.mockResolvedValue({
      text: "hydrated action reply",
      completed: true,
      userMessageId: "hydrated-action-user",
      messageId: "hydrated-action-assistant",
    });

    let hydration: Promise<string | null>;
    act(() => {
      hydration = result.current.callbacks.hydrateInitialConversationState();
    });
    await flushPendingWork();
    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);

    let actionSend: Promise<void>;
    act(() => {
      actionSend = result.current.callbacks.sendActionMessage(
        "action during hydration",
      );
    });
    await flushPendingWork();
    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();

    await act(async () => {
      resolveHydrationCreate?.({
        conversation: conversationRecord("conv-hydrated"),
      });
      await hydration;
    });
    await flushPendingWork();
    expect(
      mocks.client.sendConversationMessageStream.mock.calls[0]?.slice(0, 2),
    ).toEqual(["conv-hydrated", "action during hydration"]);

    await act(async () => {
      h.resolveLoad("conv-hydrated", []);
      await actionSend;
    });

    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    expect(h.activeConversationIdRef.current).toBe("conv-hydrated");
    expect(h.conversationsRef.current).toEqual([
      conversationRecord("conv-hydrated"),
    ]);
    expect(h.conversationMessagesRef.current).toMatchObject([
      { id: "hydrated-action-user", text: "action during hydration" },
      { id: "hydrated-action-assistant", text: "hydrated action reply" },
    ]);
  });

  it("does not clear C when deleting B resolves after the user selected C", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);
    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    let resolveDelete: ((value: { ok: boolean }) => void) | undefined;
    mocks.client.deleteConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    let deletion: Promise<void>;
    act(() => {
      deletion = result.current.callbacks.handleDeleteConversation("conv-b");
    });
    await flushPendingWork();
    await selectAndCommit(result, h, "conv-c", realHistory("c"));

    await act(async () => {
      resolveDelete?.({ ok: true });
      await deletion;
    });

    expect(h.activeConversationIdRef.current).toBe("conv-c");
    expect(h.conversationMessagesRef.current).toEqual(realHistory("c"));
    expect(mocks.client.sendWsMessage).not.toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: null,
    });
  });
});
