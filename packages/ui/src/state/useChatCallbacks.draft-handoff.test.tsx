// @vitest-environment jsdom
//
// Per-conversation composer draft handoff on switch (`useChatCallbacks`).
//
// Composer drafts are persisted per conversation (localStorage, keyed by id).
// Switching conversations must repaint the composer for the TARGET — restore
// the target's own saved draft, or CLEAR the composer when it has none — so a
// half-typed message can never leak into (and be sent to) the wrong
// conversation. The handoff runs inside handleSelectConversation: persist the
// leaving conversation's text under ITS key, then restore the target's draft or
// clear the composer.
//
// Drives the REAL handleSelectConversation composed with the REAL
// useDataLoaders.loadConversationMessages (like the sibling select-race suite),
// with a real setChatInput that mirrors useChatState (syncs chatInputRef), and
// the real localStorage-backed draft helpers.

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
import {
  chatDraftStorageKey,
  readChatDraft,
} from "./ChatComposerContext.hooks";
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

function greetingMessage(): ConversationMessage {
  return {
    id: "greeting-1",
    role: "assistant",
    text: "hey — what's on your mind?",
    timestamp: 1,
    source: MESSAGE_SOURCE_AGENT_GREETING,
  };
}

function realHistory(prefix: string): ConversationMessage[] {
  return [
    { id: `${prefix}-u1`, role: "user", text: "real message", timestamp: 1 },
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
  chatInputRef: MutableRefObject<string>;
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
  // Mirror useChatState.setChatInput: the paired ref is synced on every write.
  const setChatInput: UseChatCallbacksDeps["setChatInput"] = (v) => {
    chatInputRef.current = v;
  };

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
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations,
    resetConversationDraftState: vi.fn(),
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
    chatInputRef,
    resolveLoad: (id, messages) => {
      pendingLoads.get(id)?.shift()?.resolve(messages);
    },
    deletedConversationIds: () =>
      mocks.client.deleteConversation.mock.calls.map(
        (call) => call[0] as string,
      ),
  };
}

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
  conversationRecord("conv-a"),
  conversationRecord("conv-b"),
  conversationRecord("conv-c"),
  conversationRecord("draft-d"),
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("composer draft handoff on conversation switch (#FIX2)", () => {
  it("switching to a DRAFTLESS conversation clears the composer (no leak) and never pollutes the target's key", async () => {
    // conv-a has a saved draft; conv-b does NOT.
    window.localStorage.setItem(
      chatDraftStorageKey("conv-a"),
      "half typed in A",
    );
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    // Open A — its own draft is restored into the composer.
    await selectAndCommit(result, h, "conv-a", realHistory("a"));
    expect(h.chatInputRef.current).toBe("half typed in A");

    // Switch to draftless B.
    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    // Composer is CLEARED — A's text did not leak into B…
    expect(h.chatInputRef.current).toBe("");
    // …and B's draft key was never written with A's text.
    expect(readChatDraft("conv-b")).toBeNull();
    // A's draft is preserved under A's own key.
    expect(readChatDraft("conv-a")).toBe("half typed in A");
  });

  it("switching to a conversation WITH a saved draft restores that draft", async () => {
    window.localStorage.setItem(chatDraftStorageKey("conv-c"), "draft in C");
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "conv-a", realHistory("a"));
    expect(h.chatInputRef.current).toBe("");

    await selectAndCommit(result, h, "conv-c", realHistory("c"));
    expect(h.chatInputRef.current).toBe("draft in C");
  });

  it("persists the LEAVING conversation's in-progress text under its own key on a fast switch", async () => {
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    await selectAndCommit(result, h, "conv-a", realHistory("a"));
    // Simulate the user typing into A after it opened (no debounce flush yet).
    h.chatInputRef.current = "typed but not yet persisted";

    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    // The leaving conversation's text was persisted under ITS key, not lost.
    expect(readChatDraft("conv-a")).toBe("typed but not yet persisted");
    // And the target's composer is clear.
    expect(h.chatInputRef.current).toBe("");
  });

  it("reaping an empty greeting-only draft also drops its persisted composer draft", async () => {
    window.localStorage.setItem(
      chatDraftStorageKey("draft-d"),
      "stale draft text",
    );
    const h = makeHarness(SEED);
    const { result } = mountChat(h);

    // Open the greeting-only draft (its draft text is restored)…
    await selectAndCommit(result, h, "draft-d", [greetingMessage()]);
    expect(h.chatInputRef.current).toBe("stale draft text");

    // …then switch away: the empty draft is reaped AND its draft key cleared.
    await selectAndCommit(result, h, "conv-b", realHistory("b"));

    expect(h.deletedConversationIds()).toEqual(["draft-d"]);
    expect(readChatDraft("draft-d")).toBeNull();
    expect(h.chatInputRef.current).toBe("");
  });
});
