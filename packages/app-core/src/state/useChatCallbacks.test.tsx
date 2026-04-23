// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversation, ConversationMessage } from "../api";
import type { Tab } from "../navigation";
import type { LoadConversationMessagesResult } from "./internal";
import {
  useChatCallbacks,
  type UseChatCallbacksDeps,
} from "./useChatCallbacks";

const { clientMock, sendHookMock } = vi.hoisted(() => ({
  clientMock: {
    cleanupEmptyConversations: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getConversationMessages: vi.fn(),
    getStatus: vi.fn(),
    listConversations: vi.fn(),
    renameConversation: vi.fn(),
    requestGreeting: vi.fn(),
    sendWsMessage: vi.fn(),
  },
  sendHookMock: {
    interruptActiveChatPipeline: vi.fn(),
  },
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("./useChatLifecycle", () => ({
  useChatLifecycle: () => ({}),
}));

vi.mock("./useChatSend", () => ({
  useChatSend: () => sendHookMock,
}));

type HookState = ReturnType<typeof createHookState>;

function createConversation(
  id: string,
  title = "New Chat",
): Conversation {
  const isoNow = new Date().toISOString();
  return {
    id,
    roomId: `room-${id}`,
    title,
    createdAt: isoNow,
    updatedAt: isoNow,
  };
}

function createMessage(
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  return {
    id: `${role}-${text}`,
    role,
    text,
    timestamp: Date.now(),
  };
}

function createHookState(options?: {
  conversations?: Conversation[];
  activeConversationId?: string | null;
  conversationMessages?: ConversationMessage[];
  unreadConversations?: Set<string>;
  companionMessageCutoffTs?: number;
}) {
  let conversationsState = options?.conversations ?? [];
  let activeConversationIdState = options?.activeConversationId ?? null;
  let conversationMessagesState = options?.conversationMessages ?? [];
  let unreadConversationsState =
    options?.unreadConversations ?? new Set<string>();
  let companionMessageCutoffTsState =
    options?.companionMessageCutoffTs ?? 0;

  const activeConversationIdRef = { current: activeConversationIdState };
  const conversationMessagesRef = { current: conversationMessagesState };

  const setConversations = vi.fn(
    (
      next:
        | Conversation[]
        | ((prev: Conversation[]) => Conversation[]),
    ) => {
      conversationsState =
        typeof next === "function" ? next(conversationsState) : next;
    },
  );
  const setActiveConversationId = vi.fn((next: string | null) => {
    activeConversationIdState = next;
  });
  const setCompanionMessageCutoffTs = vi.fn((next: number) => {
    companionMessageCutoffTsState = next;
  });
  const setConversationMessages = vi.fn(
    (
      next:
        | ConversationMessage[]
        | ((
            prev: ConversationMessage[],
          ) => ConversationMessage[]),
    ) => {
      conversationMessagesState =
        typeof next === "function"
          ? next(conversationMessagesState)
          : next;
    },
  );
  const setUnreadConversations = vi.fn(
    (
      next:
        | Set<string>
        | ((prev: Set<string>) => Set<string>),
    ) => {
      unreadConversationsState =
        typeof next === "function"
          ? next(unreadConversationsState)
          : next;
    },
  );

  return {
    activeConversationIdRef,
    conversationMessagesRef,
    get activeConversationId() {
      return activeConversationIdState;
    },
    get companionMessageCutoffTs() {
      return companionMessageCutoffTsState;
    },
    get conversationMessages() {
      return conversationMessagesState;
    },
    get conversations() {
      return conversationsState;
    },
    get unreadConversations() {
      return unreadConversationsState;
    },
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setConversations,
    setUnreadConversations,
  };
}

function createDeps(state: HookState): UseChatCallbacksDeps {
  const noopAsync = vi.fn(async () => undefined);
  const loadConversationMessages = vi.fn(
    async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
  );

  return {
    t: (key: string) => key,
    uiLanguage: "en",
    uiShellMode: "native",
    tab: "chat" as Tab,
    agentStatus: null,
    chatInput: "",
    chatMode: "simple",
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    companionMessageCutoffTs: state.companionMessageCutoffTs,
    conversationMessages: state.conversationMessages,
    ptySessions: [],
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations: state.setConversations,
    setActiveConversationId: state.setActiveConversationId,
    setCompanionMessageCutoffTs: state.setCompanionMessageCutoffTs,
    setConversationMessages: state.setConversationMessages,
    setUnreadConversations: state.setUnreadConversations,
    resetConversationDraftState: vi.fn(),
    activeConversationIdRef: state.activeConversationIdRef,
    chatInputRef: { current: "" },
    chatPendingImagesRef: { current: [] },
    conversationMessagesRef: state.conversationMessagesRef,
    conversationHydrationEpochRef: { current: 0 },
    chatAbortRef: { current: null },
    chatSendBusyRef: { current: false },
    chatSendNonceRef: { current: 0 },
    greetingFiredRef: { current: false },
    greetingInFlightConversationRef: { current: null },
    companionStaleConversationRefreshRef: { current: null },
    lifecycleAction: null,
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
    loadConversations: vi.fn(async () => null),
    loadConversationMessages,
    loadPlugins: noopAsync,
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => false),
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
    onboardingCompletionCommittedRef: { current: false },
    setOnboardingUiRevealNonce: vi.fn(),
    setOnboardingLoading: vi.fn(),
    setOnboardingComplete: vi.fn(),
    setOnboardingStep: vi.fn(),
    setOnboardingMode: vi.fn(),
    setOnboardingActiveGuide: vi.fn(),
    setOnboardingDeferredTasks: vi.fn(),
    setPostOnboardingChecklistDismissed: vi.fn(),
    setOnboardingName: vi.fn(),
    setOnboardingStyle: vi.fn(),
    setOnboardingServerTarget: vi.fn(),
    setOnboardingProvider: vi.fn(),
    setOnboardingApiKey: vi.fn(),
    setOnboardingVoiceProvider: vi.fn(),
    setOnboardingVoiceApiKey: vi.fn(),
    setOnboardingPrimaryModel: vi.fn(),
    setOnboardingOpenRouterModel: vi.fn(),
    setOnboardingRemoteConnected: vi.fn(),
    setOnboardingRemoteApiBase: vi.fn(),
    setOnboardingRemoteToken: vi.fn(),
    setOnboardingSmallModel: vi.fn(),
    setOnboardingLargeModel: vi.fn(),
    setOnboardingOptions: vi.fn(),
    setSelectedVrmIndex: vi.fn(),
    setCustomVrmUrl: vi.fn(),
    setCustomBackgroundUrl: vi.fn(),
    setPlugins: vi.fn(),
    setSkills: vi.fn(),
    setLogs: vi.fn(),
    coordinatorResetRef: { current: null },
  };
}

describe("useChatCallbacks handleNewConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.cleanupEmptyConversations.mockResolvedValue({ deleted: [] });
    clientMock.createConversation.mockResolvedValue({
      conversation: createConversation("next-draft"),
      greeting: { text: "Fresh intro" },
    });
    clientMock.deleteConversation.mockResolvedValue({ ok: true });
    clientMock.requestGreeting.mockResolvedValue({ text: "" });
  });

  afterEach(() => {
    cleanup();
  });

  it("replaces the active intro-only draft instead of keeping duplicate New Chat rooms", async () => {
    const existingDraft = createConversation("draft-1");
    const state = createHookState({
      conversations: [existingDraft, createConversation("saved-1", "Saved")],
      activeConversationId: existingDraft.id,
      conversationMessages: [createMessage("assistant", "Existing intro")],
      unreadConversations: new Set([existingDraft.id, "saved-1"]),
      companionMessageCutoffTs: 12,
    });
    const { result } = renderHook(() => useChatCallbacks(createDeps(state)));

    await act(async () => {
      await result.current.handleNewConversation();
    });

    expect(sendHookMock.interruptActiveChatPipeline).toHaveBeenCalledTimes(1);
    expect(clientMock.createConversation).toHaveBeenCalledWith(undefined, {
      bootstrapGreeting: true,
      lang: "en",
    });
    expect(clientMock.deleteConversation).toHaveBeenCalledWith("draft-1");
    expect(clientMock.cleanupEmptyConversations).toHaveBeenCalledWith({
      keepId: "next-draft",
    });
    expect(state.activeConversationId).toBe("next-draft");
    expect(state.conversations.map((conversation) => conversation.id)).toEqual([
      "next-draft",
      "saved-1",
    ]);
    expect(state.unreadConversations.has("draft-1")).toBe(false);
    expect(state.conversationMessages).toHaveLength(1);
    expect(state.conversationMessages[0]?.text).toBe("Fresh intro");
  });

  it("keeps prior conversations once the user has already spoken", async () => {
    const activeConversation = createConversation("chat-1");
    const state = createHookState({
      conversations: [activeConversation, createConversation("saved-1", "Saved")],
      activeConversationId: activeConversation.id,
      conversationMessages: [
        createMessage("assistant", "Intro"),
        createMessage("user", "hello"),
      ],
    });
    const { result } = renderHook(() => useChatCallbacks(createDeps(state)));

    await act(async () => {
      await result.current.handleNewConversation();
    });

    expect(clientMock.deleteConversation).not.toHaveBeenCalled();
    expect(state.conversations.map((conversation) => conversation.id)).toEqual([
      "next-draft",
      "chat-1",
      "saved-1",
    ]);
  });
});
