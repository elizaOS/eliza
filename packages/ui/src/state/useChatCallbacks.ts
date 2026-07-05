/**
 * Chat callbacks, one of the domain hooks AppContext composes.
 *
 * Assembler hook: composes useChatLifecycle + useChatSend and owns the
 * greeting / conversation-management callbacks that depend on both.
 */

import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import { logger } from "@elizaos/logger";
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
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
} from "./ChatComposerContext.hooks";
import {
  isConversationRecord,
  isReservedLegacyChatTitle,
  normalizeConversationList,
} from "./chat-conversation-guards";
import { appendGreetingOnce } from "./greeting-dedupe";
import type { AppState, LifecycleAction } from "./internal";
import {
  type LoadConversationMessagesResult,
  loadActiveConversationId,
} from "./internal";
import { deriveAgentReady } from "./types";

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

function isPersistedGreetingMessage(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.source === MESSAGE_SOURCE_AGENT_GREETING &&
    message.text.trim().length > 0
  );
}

function hasUserConversationMessage(messages: ConversationMessage[]): boolean {
  return messages.some((message) => message.role === "user");
}

function isDraftOnlyConversationMessages(
  messages: ConversationMessage[],
): boolean {
  if (hasUserConversationMessage(messages)) return false;
  if (messages.length === 0) return true;
  return messages.every(isPersistedGreetingMessage);
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
  /** Which conversation's messages `conversationMessagesRef` holds (owned by
   *  useDataLoaders; null = unknown). Updated in lockstep with every
   *  `conversationMessagesRef.current` write so the empty-draft cleanup can
   *  never judge a conversation by another conversation's messages. */
  loadedConversationIdRef: MutableRefObject<string | null>;
  setConversations: (conversations: Conversation[]) => void;
  setActiveConversationId: (id: string | null) => void;
  setConversationMessages: (messages: ConversationMessage[]) => void;
  uiLanguage: string;
}

function conversationRecency(conversation: Conversation): number {
  const updated = Date.parse(conversation.updatedAt);
  return Number.isNaN(updated) ? 0 : updated;
}

async function resolveRestoredConversationWithMessages(
  api: HydrateConversationClient,
  conversations: Conversation[],
): Promise<{
  conversation: Conversation;
  messages: ConversationMessage[];
  /** False when the fetch failed: `messages` is then a placeholder `[]`, NOT
   *  proof the conversation is empty, so it must never feed draft cleanup. */
  messagesLoaded: boolean;
}> {
  const savedConversationId = loadActiveConversationId();
  const restoredConversation =
    conversations.find(
      (conversation) => conversation.id === savedConversationId,
    ) ?? conversations[0];
  let restoredMessages: ConversationMessage[] = [];
  try {
    restoredMessages = filterRenderableConversationMessages(
      (await api.getConversationMessages(restoredConversation.id)).messages,
    );
  } catch (err) {
    // error-policy:J4 explicit not-loaded signal — messagesLoaded:false is the
    // distinguishable "load failed" state (not healthy-empty); the caller renders
    // it differently from a genuinely empty conversation.
    logger.warn(
      { err, conversationId: restoredConversation.id },
      "[useChatCallbacks] failed to load restored conversation messages",
    );
    return {
      conversation: restoredConversation,
      messages: [],
      messagesLoaded: false,
    };
  }

  if (
    conversations.length <= 1 ||
    !isDraftOnlyConversationMessages(restoredMessages)
  ) {
    return {
      conversation: restoredConversation,
      messages: restoredMessages,
      messagesLoaded: true,
    };
  }

  // Scan most-recently-updated first so we restore the user's latest real chat,
  // not the oldest. Sort defensively client-side instead of relying on the
  // server's list ordering. Common case is a single extra fetch (the draft sits
  // at index 0, the latest real chat next); the loop is bounded by the rare
  // case where every conversation is a greeting-only draft.
  const candidatesByRecencyDesc = [...conversations].sort(
    (a, b) => conversationRecency(b) - conversationRecency(a),
  );
  for (const candidate of candidatesByRecencyDesc) {
    if (candidate.id === restoredConversation.id) continue;
    let candidateMessages: ConversationMessage[];
    try {
      candidateMessages = filterRenderableConversationMessages(
        (await api.getConversationMessages(candidate.id)).messages,
      );
    } catch {
      continue;
    }
    if (hasUserConversationMessage(candidateMessages)) {
      return {
        conversation: candidate,
        messages: candidateMessages,
        messagesLoaded: true,
      };
    }
  }

  return {
    conversation: restoredConversation,
    messages: restoredMessages,
    messagesLoaded: true,
  };
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
    loadedConversationIdRef,
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
      const {
        conversation: restoredConversation,
        messages: nextMessages,
        messagesLoaded,
      } = await resolveRestoredConversationWithMessages(api, conversations);
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
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        conversationMessagesRef.current = nextMessages;
        // A failed restore fetch yields a placeholder [] — leave the holder
        // unknown so the empty-draft cleanup can never judge (and delete) the
        // restored conversation from messages that were never actually loaded.
        loadedConversationIdRef.current = messagesLoaded
          ? restoredConversation.id
          : null;
        setConversationMessages(nextMessages);
        return nextMessages.length === 0 ? restoredConversation.id : null;
      } catch {
        if (!isCurrentHydration()) {
          return null;
        }
        // transient fetch failures are expected on early load; others are silent
        greetingFiredRef.current = false;
        conversationMessagesRef.current = [];
        loadedConversationIdRef.current = null;
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
    loadedConversationIdRef.current = null;
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
      // The thread was cleared above and a fresh create is empty by
      // construction, so the [] in conversationMessagesRef IS this
      // conversation's content.
      loadedConversationIdRef.current = conversation.id;
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
            source: MESSAGE_SOURCE_AGENT_GREETING,
            ...(inlineGreeting?.localInference
              ? { localInference: inlineGreeting.localInference }
              : {}),
          },
        ];
        greetingFiredRef.current = true;
        conversationMessagesRef.current = nextMessages;
        loadedConversationIdRef.current = conversation.id;
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

// ── Deps interface ──────────────────────────────────────────────────

export interface UseChatCallbacksDeps {
  // Translation
  t: (key: string) => string;

  // UI state
  uiLanguage: string;
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
  /** From useDataLoaders: id of the conversation whose messages
   *  `conversationMessagesRef` currently holds (null = unknown). The
   *  empty-draft cleanups below may only judge a conversation by
   *  `conversationMessagesRef` when this id matches it — during a rapid
   *  switch the ref still holds the PREVIOUS thread until the new load
   *  commits, and judging by those stale messages deleted real conversations. */
  loadedConversationIdRef: MutableRefObject<string | null>;
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
  firstRunComplete: boolean;
  firstRunCompletionCommittedRef: MutableRefObject<boolean>;
  setFirstRunUiRevealNonce: (fn: (n: number) => number) => void;
  setFirstRunLoading: (v: boolean) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunDeferredTasks: (v: string[]) => void;
  setPostFirstRunChecklistDismissed: (v: boolean) => void;
  setFirstRunName: (v: string) => void;
  setFirstRunStyle: (v: string) => void;
  setFirstRunRuntimeTarget: (v: AppState["firstRunRuntimeTarget"]) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
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
    tab,
    agentStatus,
    activeConversationId,
    companionMessageCutoffTs,
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
    loadedConversationIdRef,
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
    firstRunComplete,
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce,
    setFirstRunLoading,
    setFirstRunComplete,
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
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
            // Dedupe by SOURCE, not text: a create/fetch race can persist two
            // random preset greetings with DIFFERENT text on the server, so a
            // text-equality guard would let the second bubble through (the
            // device-review duplicate-greeting defect). `appendGreetingOnce`
            // keeps whatever greeting already seeded the thread and drops this
            // late one, so the visible greeting never doubles or swaps.
            setConversationMessages((prev: ConversationMessage[]) =>
              appendGreetingOnce(prev, {
                id: `greeting-${Date.now()}`,
                role: "assistant",
                text: data.text,
                timestamp: Date.now(),
                source: MESSAGE_SOURCE_AGENT_GREETING,
                ...(data.localInference
                  ? { localInference: data.localInference }
                  : {}),
              }),
            );
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
        loadedConversationIdRef,
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
      loadedConversationIdRef,
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
    pollAgentReadiness: firstRunComplete,
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
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
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
      const previousLoadedConversationId = loadedConversationIdRef.current;
      const previousCutoffTs = companionMessageCutoffTs;
      const hasUserMessage = previousMessages.some(
        (message) => message.role === "user",
      );
      // Only judge the previous conversation as an empty draft when
      // `conversationMessagesRef` is KNOWN to hold ITS messages
      // (`loadedConversationIdRef` is written in lockstep with every commit in
      // useDataLoaders). During a rapid switch the ref still holds the prior
      // thread until the in-flight load commits, so without this guard a real
      // conversation switched-to moments ago was judged by the old draft's
      // greeting-only messages and permanently deleted below. On a mismatch we
      // skip the replace entirely; a genuinely empty orphan is reaped
      // server-side by the cleanupEmptyConversations({ keepId }) sweep this
      // handler fires after every create.
      const shouldReplacePreviousDraftConversation =
        !title &&
        Boolean(previousConversationId) &&
        previousLoadedConversationId === previousConversationId &&
        !hasUserMessage &&
        previousMessages.length <= 1;

      // Interrupt FIRST (it restores any undelivered queued sends to the
      // composer), then wipe the draft for the new chat — and re-apply the
      // restore after the wipe so the user's queued words survive new-chat
      // (#10700 "no message is lost").
      const restoredQueuedText = send.interruptActiveChatPipeline();
      resetConversationDraftState();
      if (restoredQueuedText) {
        setChatInput(restoredQueuedText);
      }
      // Snapshot the navigation epoch AFTER the draft reset — `resetConversationDraftState`
      // itself bumps this epoch, so capturing it before (the old order) made the
      // navigated-away guard below fire on EVERY call, silently abandoning the
      // freshly-created conversation instead of activating it (clear showed no new
      // chat and orphan drafts piled up). Now only a genuine handleSelectConversation
      // during the create await — a real navigation away — changes it.
      const creationEpoch = conversationHydrationEpochRef.current;

      try {
        // Create WITHOUT bootstrapGreeting: server-side greeting generation is
        // model-bound, and on the single-threaded on-device agent it queues
        // behind in-flight FFI work (a warming/loading 1.4 GB model, an active
        // generation), so a `bootstrapGreeting` create can block for many
        // seconds — up to its 120 s timeout — before the conversation record
        // even comes back. That froze the new chat behind the loading spinner
        // ("reset shows a spinner but never makes the new chat"). Creating bare
        // is a quick insert, so the fresh conversation activates immediately
        // (below) and the greeting is fetched separately/async (the inline path
        // is still honored if a server ever returns one).
        const { conversation: rawConversation, greeting: inlineGreeting } =
          await client.createConversation(title, {
            lang: uiLanguage,
            // Stamp an explicit scope so the legacy page-chat TITLE heuristic
            // (isMainChatConversation) can never hide this conversation — a
            // scope-less chat renamed/auto-titled to "wallet"/"settings"/…
            // used to vanish from every list.
            metadata: { scope: "general" },
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
              source: MESSAGE_SOURCE_AGENT_GREETING,
              ...(greetingLocalInference
                ? { localInference: greetingLocalInference }
                : {}),
            },
          ];
          conversationMessagesRef.current = initMessages;
          loadedConversationIdRef.current = conversation.id;
          setConversationMessages(initMessages);
        } else {
          greetingFiredRef.current = false;
          conversationMessagesRef.current = [];
          loadedConversationIdRef.current = conversation.id;
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
            .catch((err) => {
              // error-policy:J6 best-effort reap of an empty draft; the
              // server-side cleanupEmptyConversations({ keepId }) sweep is the
              // backstop. Surface the failure rather than swallow it silently.
              logger.warn(
                { err, conversationId: previousConversationId },
                "[useChatCallbacks] failed to delete replaced draft conversation",
              );
            });
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
          .catch((err) => {
            // error-policy:J6 best-effort empty-conversation sweep; failure
            // leaves harmless orphan drafts reaped on the next sweep. Surface
            // it rather than swallow it silently.
            logger.warn(
              { err },
              "[useChatCallbacks] cleanupEmptyConversations failed",
            );
          });
      } catch {
        setActiveConversationId(previousConversationId);
        activeConversationIdRef.current = previousConversationId;
        setConversationMessages(previousMessages);
        // setConversationMessages syncs conversationMessagesRef; restore the
        // holder id captured with `previousMessages` so they stay in lockstep.
        loadedConversationIdRef.current = previousLoadedConversationId;
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
      loadedConversationIdRef,
      send.interruptActiveChatPipeline,
      setActiveConversationId,
      setChatInput,
      setCompanionMessageCutoffTs,
      setConversationMessages,
      setConversations,
      setUnreadConversations,
    ],
  );

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
      let removedPreviousDraft = false;
      if (prevId && prevId !== id) {
        // Judge the previous conversation ONLY when `conversationMessagesRef`
        // is known to hold ITS messages (`loadedConversationIdRef` is written
        // in lockstep with every commit in useDataLoaders). During a rapid
        // draft → B → C switch the ref still holds the draft's greeting until
        // B's fetch commits, so B — a REAL conversation — used to be judged
        // empty here and permanently deleted server-side. On a mismatch skip
        // the cleanup entirely; a genuinely empty orphan is reaped later by
        // the server-side cleanupEmptyConversations({ keepId }) sweep that
        // handleNewConversation fires after every create.
        const prevMessages = conversationMessagesRef.current;
        const prevMessagesBelongToPrev =
          loadedConversationIdRef.current === prevId;
        const hasUserMessage = prevMessages.some((m) => m.role === "user");
        if (
          prevMessagesBelongToPrev &&
          !hasUserMessage &&
          prevMessages.length <= 1
        ) {
          void client.deleteConversation(prevId).catch((err) => {
            // error-policy:J6 best-effort reap of an empty draft on switch; the
            // server-side cleanupEmptyConversations({ keepId }) sweep is the
            // backstop. Surface the failure rather than swallow it silently.
            logger.warn(
              { err, conversationId: prevId },
              "[useChatCallbacks] failed to delete empty draft on select",
            );
          });
          // The draft is gone — drop its persisted composer text too so it
          // can't resurface or bleed into the next conversation's draft.
          clearChatDraft(prevId);
          removedPreviousDraft = true;
          setConversations((prev) => prev.filter((c) => c.id !== prevId));
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(prevId);
            return next;
          });
        }
      }

      // Draft handoff (#FIX2): switching conversations must repaint the composer
      // for the TARGET. Persist the LEAVING conversation's in-progress text
      // under ITS OWN key first (the debounced per-conversation persister may
      // not have flushed a fast edit), unless it was just reaped as an empty
      // draft. Then restore the target's own saved draft — or CLEAR the composer
      // when it has none. Without the explicit clear a draftless target keeps
      // the previous conversation's composer text, which the persister then
      // saves under the TARGET's key: the user's half-typed message silently
      // reappears in — and would be sent to — the wrong conversation.
      if (id !== currentActiveId) {
        if (prevId && prevId !== id && !removedPreviousDraft) {
          writeChatDraft(prevId, chatInputRef.current);
        }
        setChatInput(readChatDraft(id) ?? "");
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
      loadConversations,
      setActionNotice,
      setChatInput,
      activeConversationIdRef,
      chatInputRef,
      conversationHydrationEpochRef,
      conversationMessagesRef,
      loadedConversationIdRef,
      send.interruptActiveChatPipeline,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
      setUnreadConversations,
    ],
  );

  // Warm the message cache for the conversations on either side of the active
  // one (the list is most-recent-first) whenever the active conversation
  // changes — including the initial hydrated one, so even the FIRST horizontal
  // swipe paints instantly from cache instead of waiting on the network.
  // Best-effort and deduped inside prefetchConversationMessages.
  useEffect(() => {
    if (!activeConversationId) return;
    const order = conversationsRef.current;
    const idx = order.findIndex((c) => c.id === activeConversationId);
    if (idx < 0) return;
    const neighbors = [
      order[idx - 2]?.id,
      order[idx - 1]?.id,
      order[idx + 1]?.id,
      order[idx + 2]?.id,
    ].filter((n): n is string => typeof n === "string");
    if (neighbors.length > 0) prefetchConversationMessages(neighbors);
  }, [activeConversationId, prefetchConversationMessages, conversationsRef]);

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
      if (isReservedLegacyChatTitle(trimmed)) {
        // A scope-less conversation with this exact title is classified as a
        // legacy page chat and hidden from every list — apparent data loss.
        setActionNotice(
          `"${trimmed}" is a reserved name. Pick a different title.`,
          "error",
          3600,
        );
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
