/**
 * Chat callbacks — extracted from AppContext.
 *
 * Assembler hook: composes useChatLifecycle + useChatSend and owns the
 * greeting / conversation-management callbacks that depend on both.
 */

import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type {
  ChatTurnStatus,
  CodingAgentSession,
  Conversation,
  FirstRunOptions,
} from "../api";
import {
  type AgentStatus,
  type ConversationMessage,
  client,
  type ImageAttachment,
} from "../api";
import type { Tab } from "../navigation";
import { isTtsDebugEnabled } from "../utils/tts-debug";
import {
  isConversationRecord,
  normalizeConversationList,
} from "./chat-conversation-guards";
import type { AppState, LifecycleAction, UiShellMode } from "./internal";
import {
  type LoadConversationMessagesResult,
  loadActiveConversationId,
} from "./internal";
import { deriveAgentReady, type FirstRunMode, type SetupStep } from "./types";

import { useChatLifecycle } from "./useChatLifecycle";
import { useChatSend } from "./useChatSend";

// ── Helpers (file-local) ────────────────────────────────────────────

function shouldKeepConversationMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant") return true;
  if (message.text.trim().length > 0) return true;
  return Boolean(message.blocks?.length);
}

function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}

function hasConversationBootstrapMessage(
  messages: ConversationMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" && shouldKeepConversationMessage(message),
  );
}

/** Enable with `ELIZA_TTS_DEBUG=1` or `localStorage.setItem("elizaos:debug:greeting", "1")`. */
function greetingDebugEnabled(): boolean {
  if (isTtsDebugEnabled()) return true;
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("elizaos:debug:greeting") === "1"
    );
  } catch {
    return false;
  }
}

function traceGreeting(phase: string, detail?: Record<string, unknown>): void {
  if (!greetingDebugEnabled()) return;
  if (detail && Object.keys(detail).length > 0) {
    console.info(`[eliza][greeting] ${phase}`, detail);
  } else {
    console.info(`[eliza][greeting] ${phase}`);
  }
}

import { isRoutineCodingAgentMessage } from "../chat";

const COMPANION_STALE_THREAD_MAX_AGE_MS = 30 * 60 * 1000;
const COMPANION_STALE_THREAD_VISIBLE_MESSAGE_LIMIT = 2;

function isPersistedGreetingMessage(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.source === "agent_greeting" &&
    message.text.trim().length > 0
  );
}

/** The subset of the API client the initial-conversation hydration needs.
 *  Injected (not the module singleton) so the policy below is unit-testable. */
export type HydrateConversationClient = Pick<
  typeof client,
  | "listConversations"
  | "getConversationMessages"
  | "sendWsMessage"
  | "createConversation"
>;

export interface HydrateInitialConversationDeps {
  client: HydrateConversationClient;
  conversationHydrationEpochRef: MutableRefObject<number>;
  activeConversationIdRef: MutableRefObject<string | null>;
  greetingFiredRef: MutableRefObject<boolean>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversationId: (id: string | null) => void;
  setConversationMessages: (messages: ConversationMessage[]) => void;
  uiLanguage: string;
}

/**
 * Hydrate the app's single active conversation on boot.
 *
 * INVARIANT: the ContinuousChatOverlay is mounted over EVERY surface, so the
 * chat must ALWAYS end up with an active, greeted conversation — never an empty
 * thread — regardless of which route the shell launched on. So when the server
 * has zero conversations this ALWAYS creates one with a bootstrap greeting (it
 * is NOT gated on the URL being /chat, the bug that left the overlay
 * permanently empty when the shell booted at /views or a cached app slug).
 *
 * Returns a conversation id when the caller should still backfill a greeting
 * (restored-but-empty, or created without an inline greeting), else null.
 * Extracted from the hook so it can be tested directly with a fake client.
 */
export async function hydrateInitialConversation(
  deps: HydrateInitialConversationDeps,
): Promise<string | null> {
  const {
    client: api,
    conversationHydrationEpochRef,
    activeConversationIdRef,
    greetingFiredRef,
    conversationMessagesRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    uiLanguage,
  } = deps;
  const hydrationEpoch = ++conversationHydrationEpochRef.current;
  const isCurrentHydration = () =>
    conversationHydrationEpochRef.current === hydrationEpoch;

  try {
    const { conversations: rawConversations } = await api.listConversations();
    const conversations = normalizeConversationList(rawConversations);
    traceGreeting("hydrate:listConversations", {
      count: conversations.length,
    });
    if (!isCurrentHydration()) {
      return null;
    }
    setConversations(conversations);
    if (conversations.length > 0) {
      const savedConversationId = loadActiveConversationId();
      const restoredConversation =
        conversations.find(
          (conversation) => conversation.id === savedConversationId,
        ) ?? conversations[0];
      if (!isCurrentHydration()) {
        return null;
      }
      setActiveConversationId(restoredConversation.id);
      activeConversationIdRef.current = restoredConversation.id;
      api.sendWsMessage({
        type: "active-conversation",
        conversationId: restoredConversation.id,
      });
      try {
        const { messages } = await api.getConversationMessages(
          restoredConversation.id,
        );
        if (!isCurrentHydration()) {
          return null;
        }
        const nextMessages = filterRenderableConversationMessages(messages);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return nextMessages.length === 0 ? restoredConversation.id : null;
      } catch {
        if (!isCurrentHydration()) {
          return null;
        }
        // transient fetch failures are expected on early load; others are silent
        greetingFiredRef.current = false;
        conversationMessagesRef.current = [];
        setConversationMessages([]);
        return restoredConversation.id;
      }
    }

    if (!isCurrentHydration()) {
      return null;
    }
    traceGreeting("hydrate:no_conversations_on_server");
    greetingFiredRef.current = false;
    conversationMessagesRef.current = [];
    setConversationMessages([]);
    setActiveConversationId(null);
    activeConversationIdRef.current = null;
    setConversations([]);

    traceGreeting("hydrate:auto_create_initial_conversation");
    try {
      const { conversation: rawConversation, greeting: inlineGreeting } =
        await api.createConversation(undefined, {
          bootstrapGreeting: true,
          lang: uiLanguage,
        });
      if (!isConversationRecord(rawConversation)) {
        throw new Error("Conversation creation returned an invalid payload.");
      }
      const conversation = rawConversation;

      if (!isCurrentHydration()) {
        return null;
      }

      setConversations([conversation]);
      setActiveConversationId(conversation.id);
      activeConversationIdRef.current = conversation.id;
      api.sendWsMessage({
        type: "active-conversation",
        conversationId: conversation.id,
      });

      const greetingText = inlineGreeting?.text?.trim() || "";
      if (greetingText) {
        const nextMessages: ConversationMessage[] = [
          {
            id: `greeting-${Date.now()}`,
            role: "assistant",
            text: greetingText,
            timestamp: Date.now(),
            source: "agent_greeting",
            ...(inlineGreeting?.localInference
              ? { localInference: inlineGreeting.localInference }
              : {}),
          },
        ];
        greetingFiredRef.current = true;
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return null;
      }

      return conversation.id;
    } catch {
      if (!isCurrentHydration()) {
        return null;
      }
      return null;
    }
  } catch {
    return null;
  }
}

function shouldStartFreshCompanionConversation(
  messages: ConversationMessage[],
  now = Date.now(),
): boolean {
  const visibleMessages = messages
    .filter((message) => shouldKeepConversationMessage(message))
    .filter((message) => !isRoutineCodingAgentMessage(message))
    .slice(-COMPANION_STALE_THREAD_VISIBLE_MESSAGE_LIMIT);

  if (visibleMessages.length === 0) {
    return false;
  }

  if (
    visibleMessages.length === 1 &&
    isPersistedGreetingMessage(visibleMessages[0])
  ) {
    return false;
  }

  return visibleMessages.every((message) => {
    if (!Number.isFinite(message.timestamp)) {
      return false;
    }
    return now - message.timestamp > COMPANION_STALE_THREAD_MAX_AGE_MS;
  });
}

// ── Deps interface ──────────────────────────────────────────────────

export interface UseChatCallbacksDeps {
  // Translation
  t: (key: string) => string;

  // UI state
  uiLanguage: string;
  uiShellMode: UiShellMode;
  tab: Tab;

  // Agent status
  agentStatus: AgentStatus | null;

  // Chat state from useChatState
  chatInput: string;
  conversations: Conversation[];
  activeConversationId: string | null;
  companionMessageCutoffTs: number;
  conversationMessages: ConversationMessage[];
  ptySessions: CodingAgentSession[];

  // Setters from useChatState
  setChatInput: (v: string) => void;
  setChatSending: (v: boolean) => void;
  setChatFirstTokenReceived: (v: boolean) => void;
  /** Set/clear the live server-reported phase of the in-flight turn (#8813). */
  setServerTurnStatus: (status: ChatTurnStatus | null) => void;
  setChatLastUsage: (v: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string | undefined;
    updatedAt: number;
  }) => void;
  setChatPendingImages: (v: ImageAttachment[]) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  setActiveConversationId: (v: string | null) => void;
  setCompanionMessageCutoffTs: (v: number) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setUnreadConversations: (
    v: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  resetConversationDraftState: () => void;

  // Refs from useChatState
  activeConversationIdRef: MutableRefObject<string | null>;
  chatInputRef: MutableRefObject<string>;
  chatPendingImagesRef: MutableRefObject<ImageAttachment[]>;
  conversationsRef: MutableRefObject<Conversation[]>;
  conversationMessagesRef: MutableRefObject<ConversationMessage[]>;
  conversationHydrationEpochRef: MutableRefObject<number>;
  chatAbortRef: MutableRefObject<AbortController | null>;
  chatSendBusyRef: MutableRefObject<boolean>;
  chatSendNonceRef: MutableRefObject<number>;
  greetingFiredRef: MutableRefObject<boolean>;
  greetingInFlightConversationRef: MutableRefObject<string | null>;
  companionStaleConversationRefreshRef: MutableRefObject<string | null>;

  // Lifecycle
  lifecycleAction: LifecycleAction | null;
  beginLifecycleAction: (action: LifecycleAction) => boolean;
  finishLifecycleAction: () => void;
  lifecycleBusyRef: MutableRefObject<boolean>;
  lifecycleActionRef: MutableRefObject<LifecycleAction | null>;
  setAgentStatus: (s: AgentStatus | null) => void;
  setActionNotice: (
    text: string,
    tone: "success" | "error" | "info",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Pending restart
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  setPendingRestart: (v: boolean) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;

  // Backend connection
  setBackendDisconnectedBannerDismissed: (v: boolean) => void;
  resetBackendConnection: () => void;

  // Loaders
  loadConversations: () => Promise<Conversation[] | null>;
  loadConversationMessages: (
    convId: string,
  ) => Promise<LoadConversationMessagesResult>;
  /** Warm the message cache for adjacent conversations (smooth swipe nav). */
  prefetchConversationMessages: (ids: readonly string[]) => void;
  loadPlugins: () => Promise<unknown>;

  // Cloud state
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  pollCloudCredits: () => Promise<boolean>;
  elizaCloudPreferDisconnectedUntilLoginRef: MutableRefObject<boolean>;
  setElizaCloudEnabled: (v: boolean) => void;
  setElizaCloudConnected: (v: boolean) => void;
  setElizaCloudVoiceProxyAvailable: (v: boolean) => void;
  setElizaCloudHasPersistedKey: (v: boolean) => void;
  setElizaCloudCredits: (v: number | null) => void;
  setElizaCloudCreditsLow: (v: boolean) => void;
  setElizaCloudCreditsCritical: (v: boolean) => void;
  setElizaCloudAuthRejected: (v: boolean) => void;
  setElizaCloudCreditsError: (v: string | null) => void;
  setElizaCloudTopUpUrl: (v: string) => void;
  setElizaCloudUserId: (v: string | null) => void;
  setElizaCloudStatusReason: (v: string | null) => void;
  setElizaCloudLoginError: (v: string | null) => void;

  // First-run setters (used by completeResetLocalStateAfterServerWipe)
  firstRunCompletionCommittedRef: MutableRefObject<boolean>;
  setFirstRunUiRevealNonce: (fn: (n: number) => number) => void;
  setFirstRunLoading: (v: boolean) => void;
  setFirstRunComplete: (v: boolean) => void;
  setSetupStep: (v: SetupStep) => void;
  setFirstRunMode: (v: FirstRunMode) => void;
  setFirstRunActiveGuide: (v: string | null) => void;
  setFirstRunDeferredTasks: (v: string[]) => void;
  setPostFirstRunChecklistDismissed: (v: boolean) => void;
  setFirstRunName: (v: string) => void;
  setFirstRunStyle: (v: string) => void;
  setFirstRunRuntimeTarget: (v: AppState["firstRunRuntimeTarget"]) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunApiKey: (v: string) => void;
  setFirstRunVoiceProvider: (v: string) => void;
  setFirstRunVoiceApiKey: (v: string) => void;
  setFirstRunPrimaryModel: (v: string) => void;
  setFirstRunOpenRouterModel: (v: string) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
  setFirstRunSmallModel: (v: string) => void;
  setFirstRunLargeModel: (v: string) => void;
  setFirstRunOptions: (v: FirstRunOptions | null) => void;

  // Character / avatar
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: (v: string) => void;
  setCustomBackgroundUrl: (v: string) => void;

  // Plugins / skills / logs
  setPlugins: (v: never[]) => void;
  setSkills: (v: never[]) => void;
  setLogs: (v: never[]) => void;

  // Startup coordinator
  coordinatorResetRef: MutableRefObject<(() => void) | null>;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useChatCallbacks(deps: UseChatCallbacksDeps) {
  const {
    t,
    uiLanguage,
    uiShellMode,
    tab,
    agentStatus,
    activeConversationId,
    companionMessageCutoffTs,
    conversationMessages,
    ptySessions,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    companionStaleConversationRefreshRef,
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    lifecycleBusyRef,
    lifecycleActionRef,
    setAgentStatus,
    setActionNotice,
    pendingRestart,
    pendingRestartReasons,
    setPendingRestart,
    setPendingRestartReasons,
    setBackendDisconnectedBannerDismissed,
    resetBackendConnection,
    loadConversations,
    loadConversationMessages,
    prefetchConversationMessages,
    loadPlugins,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled,
    setElizaCloudConnected,
    setElizaCloudVoiceProxyAvailable,
    setElizaCloudHasPersistedKey,
    setElizaCloudCredits,
    setElizaCloudCreditsLow,
    setElizaCloudCreditsCritical,
    setElizaCloudAuthRejected,
    setElizaCloudCreditsError,
    setElizaCloudTopUpUrl,
    setElizaCloudUserId,
    setElizaCloudStatusReason,
    setElizaCloudLoginError,
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce,
    setFirstRunLoading,
    setFirstRunComplete,
    setSetupStep,
    setFirstRunMode,
    setFirstRunActiveGuide,
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunVoiceProvider,
    setFirstRunVoiceApiKey,
    setFirstRunPrimaryModel,
    setFirstRunOpenRouterModel,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunSmallModel,
    setFirstRunLargeModel,
    setFirstRunOptions,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setPlugins,
    setSkills,
    setLogs,
    coordinatorResetRef,
  } = deps;

  // ── Greeting / hydration (defined here; passed into lifecycle) ──────

  const fetchGreeting = useCallback(
    async (convId: string): Promise<boolean> => {
      if (greetingInFlightConversationRef.current === convId) {
        traceGreeting("fetchGreeting:skip_duplicate_in_flight", {
          convId,
        });
        return false;
      }
      greetingInFlightConversationRef.current = convId;
      traceGreeting("fetchGreeting:request", { convId });
      try {
        const data = await client.requestGreeting(convId, uiLanguage);
        if (data.text) {
          const stillActive = activeConversationIdRef.current === convId;
          traceGreeting("fetchGreeting:response", {
            convId,
            stillActive,
            textLength: data.text.length,
            persisted: data.persisted === true,
          });
          if (stillActive) {
            setConversationMessages((prev: ConversationMessage[]) => {
              if (
                prev.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.source === "agent_greeting" &&
                    message.text === data.text,
                )
              ) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: `greeting-${Date.now()}`,
                  role: "assistant",
                  text: data.text,
                  timestamp: Date.now(),
                  source: "agent_greeting",
                  ...(data.localInference
                    ? { localInference: data.localInference }
                    : {}),
                },
              ];
            });
            greetingFiredRef.current = true;
          }
          return stillActive;
        }
        traceGreeting("fetchGreeting:empty_or_whitespace", { convId });
        greetingFiredRef.current = false;
      } catch (err) {
        traceGreeting("fetchGreeting:request_failed", {
          convId,
          error: err instanceof Error ? err.message : String(err),
        });
        greetingFiredRef.current = false;
        /* greeting failed silently — user can still chat */
      } finally {
        if (greetingInFlightConversationRef.current === convId) {
          greetingInFlightConversationRef.current = null;
        }
      }
      return false;
    },
    [
      uiLanguage,
      activeConversationIdRef,
      greetingFiredRef,
      greetingInFlightConversationRef,
      setConversationMessages,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: greetingFiredRef is intentionally read from the ref at call time
  const requestGreetingWhenRunning = useCallback(
    async (convId: string | null): Promise<void> => {
      if (!convId || greetingFiredRef.current) {
        traceGreeting("requestGreetingWhenRunning:skip", {
          convId: convId ?? null,
          greetingFired: greetingFiredRef.current,
        });
        return;
      }
      try {
        const status = await client.getStatus();
        traceGreeting("requestGreetingWhenRunning:status", {
          convId,
          state: status.state,
        });
        if (status.state === "running" && !greetingFiredRef.current) {
          await fetchGreeting(convId);
        }
      } catch {
        // best-effort greeting; will be triggered on next connect
      }
    },
    [fetchGreeting],
  );

  const hydrateInitialConversationState = useCallback(
    (): Promise<string | null> =>
      hydrateInitialConversation({
        client,
        conversationHydrationEpochRef,
        activeConversationIdRef,
        greetingFiredRef,
        conversationMessagesRef,
        setConversations,
        setActiveConversationId,
        setConversationMessages,
        uiLanguage,
      }),
    [
      activeConversationIdRef,
      conversationHydrationEpochRef,
      conversationMessagesRef,
      greetingFiredRef,
      uiLanguage,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
    ],
  );

  // Backfill the bootstrap greeting once the agent first becomes ready. The
  // initial post-hydrate `requestGreetingWhenRunning` is one-shot and bails when
  // the agent isn't running yet (a slow on-device model still warming, or no
  // provider wired at boot) — without this retry a restored/created conversation
  // that hydrated empty would stay permanently blank, so the chat would have no
  // chat in it even though an active conversation exists. The helper self-gates
  // on `greetingFiredRef`, so this never double-greets.
  const agentReady = deriveAgentReady(agentStatus);
  useEffect(() => {
    if (!agentReady) return;
    if (greetingFiredRef.current) return;
    if (conversationMessagesRef.current.length > 0) return;
    const convId = activeConversationIdRef.current;
    if (!convId) return;
    void requestGreetingWhenRunning(convId);
  }, [
    agentReady,
    requestGreetingWhenRunning,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
  ]);

  // ── Send sub-hook ───────────────────────────────────────────────────

  // Stable ref so handleChatStop doesn't get a new reference on every 5-second
  // ptySessions poll. The ref is updated here (synchronously, before useChatSend
  // runs) so it always reflects the latest sessions at call-time.
  const ptySessionsRef = useRef(ptySessions);
  ptySessionsRef.current = ptySessions;

  const send = useChatSend({
    t,
    uiLanguage,
    tab,
    activeConversationId,
    ptySessionsRef,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    setActionNotice,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    loadConversations,
    loadConversationMessages,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
  });

  // ── Lifecycle sub-hook ──────────────────────────────────────────────

  const lifecycle = useChatLifecycle({
    agentStatus,
    setAgentStatus,
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    lifecycleBusyRef,
    lifecycleActionRef,
    setActionNotice,
    pendingRestart,
    pendingRestartReasons,
    setPendingRestart,
    setPendingRestartReasons,
    setBackendDisconnectedBannerDismissed,
    resetBackendConnection,
    loadConversations,
    loadPlugins,
    hydrateInitialConversationState,
    requestGreetingWhenRunning,
    interruptActiveChatPipeline: send.interruptActiveChatPipeline,
    resetConversationDraftState,
    setActiveConversationId,
    setConversationMessages,
    setConversations,
    activeConversationIdRef,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled,
    setElizaCloudConnected,
    setElizaCloudVoiceProxyAvailable,
    setElizaCloudHasPersistedKey,
    setElizaCloudCredits,
    setElizaCloudCreditsLow,
    setElizaCloudCreditsCritical,
    setElizaCloudAuthRejected,
    setElizaCloudCreditsError,
    setElizaCloudTopUpUrl,
    setElizaCloudUserId,
    setElizaCloudStatusReason,
    setElizaCloudLoginError,
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce,
    setFirstRunLoading,
    setFirstRunComplete,
    setSetupStep,
    setFirstRunMode,
    setFirstRunActiveGuide,
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunVoiceProvider,
    setFirstRunVoiceApiKey,
    setFirstRunPrimaryModel,
    setFirstRunOpenRouterModel,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunSmallModel,
    setFirstRunLargeModel,
    setFirstRunOptions,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setPlugins,
    setSkills,
    setLogs,
    coordinatorResetRef,
  });

  // ── Conversation management ─────────────────────────────────────────

  const handleNewConversation = useCallback(
    async (title?: string) => {
      const previousConversationId = activeConversationIdRef.current;
      const previousMessages = conversationMessagesRef.current;
      const previousCutoffTs = companionMessageCutoffTs;
      const hasUserMessage = previousMessages.some(
        (message) => message.role === "user",
      );
      const shouldReplacePreviousDraftConversation =
        !title &&
        Boolean(previousConversationId) &&
        !hasUserMessage &&
        previousMessages.length <= 1;

      send.interruptActiveChatPipeline();
      resetConversationDraftState();
      // Snapshot the navigation epoch AFTER the draft reset — `resetConversationDraftState`
      // itself bumps this epoch, so capturing it before (the old order) made the
      // navigated-away guard below fire on EVERY call, silently abandoning the
      // freshly-created conversation instead of activating it (clear showed no new
      // chat and orphan drafts piled up). Now only a genuine handleSelectConversation
      // during the create await — a real navigation away — changes it.
      const creationEpoch = conversationHydrationEpochRef.current;

      try {
        const { conversation: rawConversation, greeting: inlineGreeting } =
          await client.createConversation(title, {
            bootstrapGreeting: true,
            lang: uiLanguage,
          });
        if (!isConversationRecord(rawConversation)) {
          throw new Error("Conversation creation returned an invalid payload.");
        }
        const conversation = rawConversation;
        // Bail if the user navigated away while the conversation was being
        // created: switching now would override their selected conversation
        // with this throwaway fresh thread. The
        // orphaned empty conversation is reaped by cleanupEmptyConversations.
        if (conversationHydrationEpochRef.current !== creationEpoch) {
          return;
        }
        const nextCutoffTs = Date.now();
        setConversations((prev) => {
          const next = shouldReplacePreviousDraftConversation
            ? prev.filter((existing) => existing.id !== previousConversationId)
            : prev;
          return [conversation, ...next];
        });
        setActiveConversationId(conversation.id);
        activeConversationIdRef.current = conversation.id;
        setCompanionMessageCutoffTs(nextCutoffTs);
        // Try inline greeting first; fall back to dedicated greeting endpoint
        let greetingText = inlineGreeting?.text?.trim() || "";
        let greetingLocalInference = inlineGreeting?.localInference;
        if (!greetingText) {
          try {
            const resp = await client.requestGreeting(
              conversation.id,
              uiLanguage,
            );
            greetingText = resp.text?.trim() || "";
            greetingLocalInference = resp.localInference;
          } catch {
            // Greeting generation failed — continue without greeting
          }
        }

        // The greeting may have been fetched across an `await`; if the user
        // navigated away meanwhile, do not clobber their current thread or run
        // follow-up side effects for this fresh conversation.
        const stillOnNewConversation =
          activeConversationIdRef.current === conversation.id &&
          conversationHydrationEpochRef.current === creationEpoch;
        if (!stillOnNewConversation) {
          return;
        }
        if (greetingText) {
          greetingFiredRef.current = true;
          const initMessages: ConversationMessage[] = [
            {
              id: `greeting-${Date.now()}`,
              role: "assistant",
              text: greetingText,
              timestamp: Date.now(),
              source: "agent_greeting",
              ...(greetingLocalInference
                ? { localInference: greetingLocalInference }
                : {}),
            },
          ];
          conversationMessagesRef.current = initMessages;
          setConversationMessages(initMessages);
        } else {
          greetingFiredRef.current = false;
          conversationMessagesRef.current = [];
          setConversationMessages([]);
          // Fallback: if inline greeting wasn't returned (e.g. old server),
          // request one via the dedicated /greeting endpoint.
          void fetchGreeting(conversation.id);
        }
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: conversation.id,
        });
        if (
          shouldReplacePreviousDraftConversation &&
          previousConversationId &&
          previousConversationId !== conversation.id
        ) {
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(previousConversationId);
            return next;
          });
          void client
            .deleteConversation(previousConversationId)
            .catch(() => {});
        }
        void client
          .cleanupEmptyConversations({ keepId: conversation.id })
          .then((result) => {
            if (result.deleted.length === 0) return;
            const deletedSet = new Set(result.deleted);
            setConversations((prev) =>
              prev.filter((existing) => !deletedSet.has(existing.id)),
            );
            setUnreadConversations((prev) => {
              const next = new Set(prev);
              for (const id of deletedSet) next.delete(id);
              return next;
            });
          })
          .catch(() => {});
      } catch {
        setActiveConversationId(previousConversationId);
        activeConversationIdRef.current = previousConversationId;
        setConversationMessages(previousMessages);
        setCompanionMessageCutoffTs(previousCutoffTs);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(previousMessages);
        if (previousConversationId) {
          client.sendWsMessage({
            type: "active-conversation",
            conversationId: previousConversationId,
          });
        }
      }
    },
    [
      companionMessageCutoffTs,
      fetchGreeting,
      resetConversationDraftState,
      uiLanguage,
      activeConversationIdRef,
      conversationHydrationEpochRef,
      conversationMessagesRef,
      greetingFiredRef,
      send.interruptActiveChatPipeline,
      setActiveConversationId,
      setCompanionMessageCutoffTs,
      setConversationMessages,
      setConversations,
      setUnreadConversations,
    ],
  );

  useEffect(() => {
    if (uiShellMode !== "companion" || tab !== "companion") {
      companionStaleConversationRefreshRef.current = null;
      return;
    }

    if (!activeConversationId) {
      return;
    }

    if (!shouldStartFreshCompanionConversation(conversationMessages)) {
      companionStaleConversationRefreshRef.current = null;
      return;
    }

    if (companionStaleConversationRefreshRef.current === activeConversationId) {
      return;
    }

    companionStaleConversationRefreshRef.current = activeConversationId;
    void handleNewConversation();
  }, [
    activeConversationId,
    conversationMessages,
    handleNewConversation,
    tab,
    uiShellMode,
    companionStaleConversationRefreshRef,
  ]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      conversationHydrationEpochRef.current += 1;
      // Read the LIVE active id from the ref, not the closure: callers can hold
      // a stale `handleSelectConversation` captured before another navigation
      // changes `activeConversationId`. Using the closure here made selecting
      // that previous conversation hit this early-return and silently no-op.
      const currentActiveId = activeConversationIdRef.current;
      if (id === currentActiveId && conversationMessagesRef.current.length > 0)
        return;

      send.interruptActiveChatPipeline();

      // Clean up empty conversations: if the previous conversation has only
      // system/greeting messages and no user messages, delete it silently.
      const prevId = currentActiveId;
      if (prevId && prevId !== id) {
        const prevMessages = conversationMessagesRef.current;
        const hasUserMessage = prevMessages.some((m) => m.role === "user");
        if (!hasUserMessage && prevMessages.length <= 1) {
          void client.deleteConversation(prevId).catch(() => {});
          setConversations((prev) => prev.filter((c) => c.id !== prevId));
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(prevId);
            return next;
          });
        }
      }

      const previousActive = currentActiveId;
      setActiveConversationId(id);
      activeConversationIdRef.current = id;
      client.sendWsMessage({ type: "active-conversation", conversationId: id });
      setUnreadConversations((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Warm the neighbors in both swipe directions so the next horizontal swipe
      // paints instantly from cache (the list is most-recent-first). Best-effort
      // and fire-and-forget; the active load below still fetches `id` itself.
      const order = conversationsRef.current;
      const idx = order.findIndex((c) => c.id === id);
      if (idx >= 0) {
        const neighbors = [
          order[idx - 2]?.id,
          order[idx - 1]?.id,
          order[idx + 1]?.id,
          order[idx + 2]?.id,
        ].filter((n): n is string => typeof n === "string");
        if (neighbors.length > 0) prefetchConversationMessages(neighbors);
      }
      const loaded = await loadConversationMessages(id);
      if (loaded.ok === true) return;
      const loadedMessage = loaded.message;

      if (loaded.ok === false && loaded.status === 404) {
        const refreshed = await loadConversations();
        const fallbackId = refreshed?.[0]?.id ?? null;
        if (fallbackId) {
          setActiveConversationId(fallbackId);
          activeConversationIdRef.current = fallbackId;
          client.sendWsMessage({
            type: "active-conversation",
            conversationId: fallbackId,
          });
          const fallbackLoaded = await loadConversationMessages(fallbackId);
          if (fallbackLoaded.ok === false) {
            setActionNotice(
              `Failed to load fallback conversation: ${fallbackLoaded.message}`,
              "error",
              4200,
            );
          }
        } else {
          setActiveConversationId(null);
          activeConversationIdRef.current = null;
          setConversationMessages([]);
        }
        setActionNotice(
          "Conversation was not found. Refreshed the conversation list.",
          "info",
          3200,
        );
        return;
      }

      setActiveConversationId(previousActive);
      activeConversationIdRef.current = previousActive;
      if (previousActive) {
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: previousActive,
        });
        const restored = await loadConversationMessages(previousActive);
        if (restored.ok === false) {
          setActionNotice(
            `Failed to restore previous conversation: ${restored.message}`,
            "error",
            4200,
          );
        }
      } else {
        setConversationMessages([]);
      }
      setActionNotice(
        `Failed to load conversation: ${loadedMessage}`,
        "error",
        4200,
      );
    },
    [
      loadConversationMessages,
      prefetchConversationMessages,
      loadConversations,
      setActionNotice,
      activeConversationIdRef,
      conversationHydrationEpochRef,
      conversationMessagesRef,
      conversationsRef,
      send.interruptActiveChatPipeline,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
      setUnreadConversations,
    ],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const deletingActive = activeConversationId === id;
      if (deletingActive) {
        send.interruptActiveChatPipeline();
      }
      try {
        await client.deleteConversation(id);
        setConversations((prev) =>
          prev.filter((conversation) => conversation.id !== id),
        );
        setUnreadConversations((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        if (deletingActive) {
          setActiveConversationId(null);
          activeConversationIdRef.current = null;
          setConversationMessages([]);
        }
        const refreshed = await loadConversations();
        if (deletingActive) {
          const fallbackId = refreshed?.[0]?.id ?? null;
          if (fallbackId) {
            setActiveConversationId(fallbackId);
            activeConversationIdRef.current = fallbackId;
            client.sendWsMessage({
              type: "active-conversation",
              conversationId: fallbackId,
            });
            const fallbackLoaded = await loadConversationMessages(fallbackId);
            if (fallbackLoaded.ok === false) {
              setActionNotice(
                `Failed to load fallback conversation: ${fallbackLoaded.message}`,
                "error",
                4200,
              );
            }
          }
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          setConversations((prev) =>
            prev.filter((conversation) => conversation.id !== id),
          );
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          if (deletingActive) {
            setActiveConversationId(null);
            activeConversationIdRef.current = null;
            setConversationMessages([]);
          }
          await loadConversations();
          setActionNotice(
            "Conversation was already deleted. Refreshed the conversation list.",
            "info",
            3200,
          );
          return;
        }
        setActionNotice(
          `Failed to delete conversation: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
      }
    },
    [
      activeConversationId,
      send.interruptActiveChatPipeline,
      loadConversationMessages,
      loadConversations,
      setActionNotice,
      activeConversationIdRef,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
      setUnreadConversations,
    ],
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        setActionNotice("Conversation title cannot be empty.", "error", 2800);
        return;
      }
      try {
        const { conversation } = await client.renameConversation(id, trimmed);
        setConversations((prev) =>
          prev.map((existing) =>
            existing.id === id ? conversation : existing,
          ),
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          await loadConversations();
          setActionNotice(
            "Conversation was not found. Refreshed the conversation list.",
            "info",
            3200,
          );
          return;
        }
        setActionNotice(
          `Failed to rename conversation: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
      }
    },
    [loadConversations, setActionNotice, setConversations],
  );

  const suggestConversationTitle = useCallback(
    async (id: string) => {
      try {
        const { conversation } = await client.renameConversation(id, "", {
          generate: true,
        });
        setConversations((prev) =>
          prev.map((existing) =>
            existing.id === id ? conversation : existing,
          ),
        );
        const next = conversation.title?.trim();
        return next && next.length > 0 ? next : null;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          await loadConversations();
          setActionNotice(
            "Conversation was not found. Refreshed the conversation list.",
            "info",
            3200,
          );
          return null;
        }
        setActionNotice(
          `Failed to suggest conversation title: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return null;
      }
    },
    [loadConversations, setActionNotice, setConversations],
  );

  return {
    // Greeting / hydration
    fetchGreeting,
    requestGreetingWhenRunning,
    hydrateInitialConversationState,
    // Conversation management
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
    suggestConversationTitle,
    // Lifecycle (from useChatLifecycle)
    ...lifecycle,
    // Send (from useChatSend)
    ...send,
  };
}
