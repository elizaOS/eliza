/**
 * Data-loading callbacks — extracted from AppContext.
 *
 * Covers: autonomy event merge / replay / append, conversation loaders,
 * BSC trade + steward wrappers, loadInventory, ownerName hydration,
 * character language sync, loadWorkbench, loadUpdateStatus,
 * checkExtensionStatus.
 */

import { logger } from "@elizaos/logger";
import {
  resolveStylePresetByAvatarIndex,
  resolveStylePresetByName,
} from "@elizaos/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentStatus,
  type BscTradeExecuteRequest,
  type BscTradeExecuteResponse,
  type BscTradePreflightResponse,
  type BscTradeQuoteRequest,
  type BscTradeQuoteResponse,
  type BscTradeTxStatusResponse,
  type BscTransferExecuteRequest,
  type BscTransferExecuteResponse,
  type CharacterData,
  type Conversation,
  type ConversationMessage,
  client,
  type ExtensionStatus,
  type StewardWebhookEventType,
  type StreamEventEnvelope,
  type StylePreset,
  type UpdateStatus,
  type WalletTradingProfileResponse,
  type WalletTradingProfileSourceFilter,
  type WalletTradingProfileWindow,
  type WorkbenchOverview,
} from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { useIsAuthenticated } from "../hooks/useAuthStatus";
import type { UiLanguage } from "../i18n";
import { normalizeOwnerName } from "../utils/owner-name";
import {
  type AutonomyRunHealthMap,
  buildAutonomyGapReplayRequests,
  hasPendingAutonomyGaps,
  markPendingAutonomyGapsPartial,
  mergeAutonomyEvents,
} from "./autonomy";
import { normalizeConversationList } from "./chat-conversation-guards";
import {
  filterRenderableConversationMessages,
  type LoadConversationMessagesResult,
  shouldKeepConversationMessage,
} from "./internal";

// ── Helpers (module-level, no React deps) ────────────────────────────

function hasConversationBootstrapMessage(
  messages: ConversationMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" && shouldKeepConversationMessage(message),
  );
}

function buildLocalizedCharacterPayload(
  preset: StylePreset,
  name?: string | null,
): CharacterData {
  const resolvedName = name?.trim() || preset.name;
  return {
    name: resolvedName,
    bio: [...preset.bio],
    system: preset.system,
    adjectives: [...preset.adjectives],
    topics: [...preset.topics],
    style: {
      all: [...preset.style.all],
      chat: [...preset.style.chat],
      post: [...preset.style.post],
    },
    messageExamples: preset.messageExamples.map((conversation) => ({
      examples: conversation.map((message) => ({
        name: message.user,
        content: { text: message.content.text },
      })),
    })),
    postExamples: [...preset.postExamples],
  };
}

// ── Hook deps ─────────────────────────────────────────────────────────────

// Upper bound on the in-memory conversation-message prefetch cache. Holds the
// active conversation plus several neighbors in each swipe direction; oldest
// entries are evicted first.
const CONVERSATION_MESSAGE_CACHE_MAX = 16;

export interface DataLoadersDeps {
  // Autonomy refs + setters (from useChatState)
  autonomousStoreRef: RefObject<
    ReturnType<typeof mergeAutonomyEvents>["store"]
  >;
  autonomousEventsRef: RefObject<StreamEventEnvelope[]>;
  autonomousLatestEventIdRef: RefObject<string | null>;
  autonomousRunHealthByRunIdRef: RefObject<AutonomyRunHealthMap>;
  autonomousReplayInFlightRef: RefObject<boolean>;
  setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
  setAutonomousLatestEventId: (v: string | null) => void;
  setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;

  // Conversation refs + setters (from useChatState)
  activeConversationIdRef: RefObject<string | null>;
  conversationMessagesRef: RefObject<ConversationMessage[]>;
  greetingFiredRef: RefObject<boolean>;
  setConversations: (v: Conversation[]) => void;
  setActiveConversationId: (v: string | null) => void;
  setConversationMessages: (v: ConversationMessage[]) => void;

  // Wallet
  loadWalletConfig: () => Promise<void>;

  // Character
  agentStatus: AgentStatus | null;
  characterData: CharacterData | null;
  characterDraft: CharacterData | null;
  loadCharacter: () => Promise<void>;
  selectedVrmIndex: number;
  firstRunComplete: boolean;
  uiLanguage: UiLanguage;

  // Owner name
  setOwnerNameState: (v: string | null) => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useDataLoaders(deps: DataLoadersDeps) {
  const {
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig,
    agentStatus,
    characterData,
    characterDraft,
    loadCharacter,
    selectedVrmIndex,
    firstRunComplete,
    uiLanguage,
    setOwnerNameState,
  } = deps;

  // Auth gate (#11084): AppProvider mounts these loaders before the auth probe
  // resolves, so the shell one-shot fetches must stay dormant until the
  // session is authenticated — an unauthenticated shell makes none of them.
  const authenticated = useIsAuthenticated();

  // ── Autonomy ────────────────────────────────────────────────────────

  const applyAutonomyEventMerge = useCallback(
    (incomingEvents: StreamEventEnvelope[], replay = false) => {
      const merged = mergeAutonomyEvents({
        store: autonomousStoreRef.current,
        incomingEvents,
        runHealthByRunId: autonomousRunHealthByRunIdRef.current,
        replay,
      });
      autonomousStoreRef.current = merged.store;
      autonomousEventsRef.current = merged.events;
      autonomousLatestEventIdRef.current = merged.latestEventId;
      autonomousRunHealthByRunIdRef.current = merged.runHealthByRunId;

      setAutonomousEvents(merged.events);
      setAutonomousLatestEventId(merged.latestEventId);
      setAutonomousRunHealthByRunId(merged.runHealthByRunId);

      return merged;
    },
    [
      autonomousEventsRef,
      autonomousLatestEventIdRef,
      autonomousRunHealthByRunIdRef,
      autonomousStoreRef,
      setAutonomousEvents,
      setAutonomousLatestEventId,
      setAutonomousRunHealthByRunId,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: autonomousStoreRef is a ref — its .current is read at call-time (always latest) and must NOT be a dependency, or this callback's identity churns on every autonomy merge and cascades into useStartupCoordinator's deps.
  const fetchAutonomyReplay = useCallback(async () => {
    if (autonomousReplayInFlightRef.current) return;
    autonomousReplayInFlightRef.current = true;
    try {
      const afterEventId = autonomousStoreRef.current.watermark ?? undefined;
      const replay = await client.getAgentEvents({
        afterEventId,
        limit: 300,
      });

      if (replay.events.length > 0) {
        applyAutonomyEventMerge(replay.events);
      }

      const gapReplays = buildAutonomyGapReplayRequests(
        autonomousRunHealthByRunIdRef.current,
        autonomousStoreRef.current,
      ).slice(0, 4);

      for (const request of gapReplays) {
        const gapReplay = await client.getAgentEvents({
          runId: request.runId,
          fromSeq: request.fromSeq,
          limit: 300,
        });
        if (gapReplay.events.length > 0) {
          applyAutonomyEventMerge(gapReplay.events);
        }
      }

      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
    } catch {
      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
      // best-effort; caller can retry on next poll cycle
    } finally {
      autonomousReplayInFlightRef.current = false;
    }
    // autonomousStoreRef.current is read at call-time inside the body — a ref
    // read is always latest, so it must NOT be a dep (it would churn this
    // callback's identity, cascading into useStartupCoordinator's deps).
  }, [
    applyAutonomyEventMerge,
    autonomousReplayInFlightRef,
    autonomousRunHealthByRunIdRef,
    setAutonomousRunHealthByRunId,
  ]);

  const appendAutonomousEvent = useCallback(
    (event: StreamEventEnvelope) => {
      const merged = applyAutonomyEventMerge([event]);
      if (merged.runsWithNewGaps.length > 0) {
        void fetchAutonomyReplay();
      }
    },
    [applyAutonomyEventMerge, fetchAutonomyReplay],
  );

  // ── Conversations ───────────────────────────────────────────────────

  // Prefetch cache: conversationId → its filtered messages. Adjacent
  // conversations are warmed on every select (prefetchConversationMessages) so a
  // horizontal swipe paints the thread instantly from memory instead of waiting
  // on the network. Capped (LRU-ish via Map insertion order) so it can't grow
  // without bound as the user swipes through a long history.
  const conversationMessageCacheRef = useRef<
    Map<string, ConversationMessage[]>
  >(new Map());
  // Abort the prior in-flight active-conversation load when a newer one starts:
  // a fast swipe stacks selects, and only the latest should win the thread.
  const activeMessageLoadAbortRef = useRef<AbortController | null>(null);
  // Per-id prefetch aborts so a neighbor is never double-fetched.
  const prefetchAbortRef = useRef<Map<string, AbortController>>(new Map());
  // Which conversation's messages `conversationMessagesRef` currently holds.
  // The ref only becomes that conversation's thread AFTER a load commits, so
  // any caller judging a conversation by `conversationMessagesRef` (the
  // empty-draft cleanup deletes in useChatCallbacks) MUST first check this id:
  // during a rapid switch the ref still holds the PREVIOUS thread while the
  // new fetch is in flight, and judging the new conversation by those stale
  // messages silently deleted real conversations. `null` = holder unknown.
  // Every `conversationMessagesRef.current` write below updates it in lockstep.
  const loadedConversationIdRef = useRef<string | null>(null);

  const cacheConversationMessages = useCallback(
    (id: string, messages: ConversationMessage[]) => {
      const cache = conversationMessageCacheRef.current;
      // Re-insert to move to the most-recent position (eviction is oldest-first).
      cache.delete(id);
      cache.set(id, messages);
      while (cache.size > CONVERSATION_MESSAGE_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
    [],
  );

  const loadConversations = useCallback(async (): Promise<
    Conversation[] | null
  > => {
    try {
      const { conversations: c } = await client.listConversations();
      const normalized = normalizeConversationList(c);
      setConversations(normalized);
      return normalized;
    } catch {
      return null;
    }
  }, [setConversations]);

  const loadConversationMessages = useCallback(
    async (convId: string): Promise<LoadConversationMessagesResult> => {
      // A newer active-conversation load supersedes any prior in-flight one so a
      // rapid swipe doesn't let an older fetch clobber the latest thread.
      activeMessageLoadAbortRef.current?.abort();
      const controller = new AbortController();
      activeMessageLoadAbortRef.current = controller;
      const { signal } = controller;

      // Instant paint from the prefetch cache (a swiped-to neighbor) so the
      // thread never flashes empty mid-swipe; the fetch below still revalidates.
      const cached = conversationMessageCacheRef.current.get(convId);
      if (cached) {
        greetingFiredRef.current = hasConversationBootstrapMessage(cached);
        conversationMessagesRef.current = cached;
        loadedConversationIdRef.current = convId;
        setConversationMessages(cached);
      }

      try {
        const { messages } = await client.getConversationMessages(convId, {
          signal,
        });
        // Superseded by a newer load while in flight — let the newer one own the
        // thread instead of committing this stale result.
        if (signal.aborted) return { ok: true };
        const nextMessages = filterRenderableConversationMessages(messages);
        cacheConversationMessages(convId, nextMessages);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        conversationMessagesRef.current = nextMessages;
        loadedConversationIdRef.current = convId;
        setConversationMessages(nextMessages);
        return { ok: true };
      } catch (err) {
        // A newer load aborted this one (fast swipe); the newer load owns the
        // thread, so report success and let the caller skip its error path.
        if (
          signal.aborted ||
          (err as { name?: string }).name === "AbortError"
        ) {
          return { ok: true };
        }
        const status = (err as { status?: number }).status;
        if (status === 404) {
          const refreshed = await client.listConversations().catch(() => null);
          if (refreshed) {
            const normalized = normalizeConversationList(
              refreshed.conversations,
            );
            setConversations(normalized);
            if (activeConversationIdRef.current === convId) {
              const fallbackId = normalized[0]?.id ?? null;
              setActiveConversationId(fallbackId);
              activeConversationIdRef.current = fallbackId;
            }
          } else if (activeConversationIdRef.current === convId) {
            setActiveConversationId(null);
            activeConversationIdRef.current = null;
          }
          // The conversation is definitively gone (404) — clear the thread and
          // drop any stale cache entry so a later swipe can't resurrect it.
          conversationMessageCacheRef.current.delete(convId);
          greetingFiredRef.current = false;
          conversationMessagesRef.current = [];
          loadedConversationIdRef.current = null;
          setConversationMessages([]);
        }
        // For TRANSIENT errors (network drop mid-stream, timeout, 5xx) do NOT
        // wipe the thread. The message store is reused as the on-screen history,
        // and blanking it on a flaky-connection reload looked like the app ate
        // the entire conversation (the data is still server-side; a later reload
        // restores it). If we already painted from the prefetch cache, the user
        // is looking at usable (if slightly stale) content, so treat the failed
        // revalidation as a soft success rather than surfacing an error over it.
        if (cached && status !== 404) return { ok: true };
        return {
          ok: false,
          status,
          message:
            err instanceof Error
              ? err.message
              : "Failed to load conversation messages",
        };
      }
    },
    [
      activeConversationIdRef,
      cacheConversationMessages,
      conversationMessagesRef,
      greetingFiredRef,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
    ],
  );

  // Replace the active thread with a window CENTERED on a specific message so a
  // keyword-search jump can scroll to a hit older than the most-recent window
  // (#9955). The conversation must already be selected (the jump path awaits
  // handleSelectConversation first); the active-id guard drops the result if the
  // user navigated away before it landed. Best-effort — a failure leaves the
  // current thread untouched and the caller simply doesn't scroll.
  const loadConversationMessagesAround = useCallback(
    async (convId: string, messageId: string): Promise<boolean> => {
      try {
        const { messages } = await client.getConversationMessages(convId, {
          around: messageId,
        });
        if (activeConversationIdRef.current !== convId) return false;
        const nextMessages = filterRenderableConversationMessages(messages);
        cacheConversationMessages(convId, nextMessages);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        conversationMessagesRef.current = nextMessages;
        loadedConversationIdRef.current = convId;
        setConversationMessages(nextMessages);
        return true;
      } catch (error) {
        logger.debug(
          { error },
          `[useDataLoaders] around-window load failed for ${convId}`,
        );
        return false;
      }
    },
    [
      activeConversationIdRef,
      cacheConversationMessages,
      conversationMessagesRef,
      greetingFiredRef,
      setConversationMessages,
    ],
  );

  // Warm the prefetch cache for adjacent conversations so a horizontal swipe
  // paints instantly. Best-effort + abortable: an id already cached or already
  // in flight is skipped, and a miss just means the eventual select does a
  // normal (spinner-backed) load.
  const prefetchConversationMessages = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        if (!id) continue;
        if (conversationMessageCacheRef.current.has(id)) continue;
        if (prefetchAbortRef.current.has(id)) continue;
        const controller = new AbortController();
        prefetchAbortRef.current.set(id, controller);
        void client
          .getConversationMessages(id, { signal: controller.signal })
          .then(({ messages }) => {
            if (controller.signal.aborted) return;
            cacheConversationMessages(
              id,
              filterRenderableConversationMessages(messages),
            );
          })
          .catch(() => {
            // Prefetch is opportunistic warming; ignore failures.
          })
          .finally(() => {
            prefetchAbortRef.current.delete(id);
          });
      }
    },
    [cacheConversationMessages],
  );

  // ── BSC trade / steward wrappers ────────────────────────────────────

  const getBscTradePreflight = useCallback(
    async (tokenAddress?: string): Promise<BscTradePreflightResponse> =>
      client.getBscTradePreflight(tokenAddress),
    [],
  );

  const getBscTradeQuote = useCallback(
    async (request: BscTradeQuoteRequest): Promise<BscTradeQuoteResponse> =>
      client.getBscTradeQuote(request),
    [],
  );

  const getBscTradeTxStatus = useCallback(
    async (hash: string): Promise<BscTradeTxStatusResponse> =>
      client.getBscTradeTxStatus(hash),
    [],
  );

  const getStewardStatus = useCallback(
    async () => client.getStewardStatus(),
    [],
  );

  const getStewardAddresses = useCallback(
    async () => client.getStewardAddresses(),
    [],
  );

  const getStewardBalance = useCallback(
    async (chainId?: number) => client.getStewardBalance(chainId),
    [],
  );

  const getStewardTokens = useCallback(
    async (chainId?: number) => client.getStewardTokens(chainId),
    [],
  );

  const getStewardWebhookEvents = useCallback(
    async (opts?: { event?: StewardWebhookEventType; since?: number }) =>
      client.getStewardWebhookEvents(opts),
    [],
  );

  const getStewardHistory = useCallback(
    async (opts?: { status?: string; limit?: number; offset?: number }) =>
      client.getStewardHistory(opts),
    [],
  );

  const getStewardPending = useCallback(
    async () => client.getStewardPending(),
    [],
  );

  const approveStewardTx = useCallback(
    async (txId: string) => client.approveStewardTx(txId),
    [],
  );

  const rejectStewardTx = useCallback(
    async (txId: string, reason?: string) =>
      client.rejectStewardTx(txId, reason),
    [],
  );

  const loadWalletTradingProfile = useCallback(
    async (
      window: WalletTradingProfileWindow = "30d",
      source: WalletTradingProfileSourceFilter = "all",
    ): Promise<WalletTradingProfileResponse> =>
      client.getWalletTradingProfile(window, source),
    [],
  );

  const executeBscTrade = useCallback(
    async (request: BscTradeExecuteRequest): Promise<BscTradeExecuteResponse> =>
      client.executeBscTrade(request),
    [],
  );

  const executeBscTransfer = useCallback(
    async (
      request: BscTransferExecuteRequest,
    ): Promise<BscTransferExecuteResponse> =>
      client.executeBscTransfer(request),
    [],
  );

  const loadInventory = useCallback(async () => {
    await loadWalletConfig();
  }, [loadWalletConfig]);

  // ── ownerName hydration ─────────────────────────────────────────────

  // Owner name lives in agent config, so it can only be read once the agent API
  // is reachable. Gating on agent readiness (rather than firing on mount) avoids
  // issuing the request during first-run / early startup, where it would block
  // until the 10s client timeout, and naturally re-hydrates if the agent
  // reconnects. The boolean keeps the effect from re-running on every status
  // poll, which only changes the AgentStatus object reference.
  const agentReachable = agentStatus !== null;

  useEffect(() => {
    if (!agentReachable || !authenticated) {
      return;
    }

    let cancelled = false;
    void client
      .getConfig()
      .then((cfg) => {
        if (cancelled) {
          return;
        }

        const persisted = normalizeOwnerName(cfg.ui?.ownerName);
        if (persisted) {
          setOwnerNameState(persisted);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        logger.debug({ error }, "[useDataLoaders] owner-name hydration failed");
      });

    return () => {
      cancelled = true;
    };
  }, [agentReachable, authenticated, setOwnerNameState]);

  // ── Character language sync ─────────────────────────────────────────

  const localizedCharacterLanguageRef = useRef<UiLanguage>(uiLanguage);

  useEffect(() => {
    const previousLanguage = localizedCharacterLanguageRef.current;
    localizedCharacterLanguageRef.current = uiLanguage;

    if (previousLanguage === uiLanguage) {
      return;
    }
    if (!firstRunComplete || selectedVrmIndex <= 0) {
      return;
    }

    const characterName =
      characterData?.name?.trim() ||
      characterDraft?.name?.trim() ||
      agentStatus?.agentName?.trim();

    // Resolve the persona by name first: avatarIndex is a VRM art-asset index
    // that several personas can share (Eliza and Chen both render asset 1), so
    // the index alone would relocalize a named persona to its sibling.
    const preset =
      resolveStylePresetByName(characterName, uiLanguage) ??
      resolveStylePresetByAvatarIndex(selectedVrmIndex, uiLanguage);
    if (!preset) {
      return;
    }

    const resolvedName = characterName || preset.name;

    void (async () => {
      try {
        await client.updateCharacter(
          buildLocalizedCharacterPayload(preset, resolvedName),
        );
        await loadCharacter();
      } catch {
        // best-effort; user can retry by changing language again
      }
    })();
  }, [
    agentStatus?.agentName,
    characterData?.name,
    characterDraft?.name,
    loadCharacter,
    firstRunComplete,
    selectedVrmIndex,
    uiLanguage,
  ]);

  // ── Workbench / update / extension ──────────────────────────────────

  const [workbenchLoading, setWorkbenchLoading] = useState(false);
  const [workbench, setWorkbench] = useState<WorkbenchOverview | null>(null);
  const [workbenchTasksAvailable, setWorkbenchTasksAvailable] = useState(false);
  const [workbenchTriggersAvailable, setWorkbenchTriggersAvailable] =
    useState(false);
  const [workbenchTodosAvailable, setWorkbenchTodosAvailable] = useState(false);

  const loadWorkbench = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setWorkbench(null);
      setWorkbenchTasksAvailable(false);
      setWorkbenchTriggersAvailable(false);
      setWorkbenchTodosAvailable(false);
      setWorkbenchLoading(false);
      return;
    }
    setWorkbenchLoading(true);
    try {
      const result = await client.getWorkbenchOverview();
      setWorkbench(result);
      setWorkbenchTasksAvailable(result.tasksAvailable ?? false);
      setWorkbenchTriggersAvailable(result.triggersAvailable ?? false);
      setWorkbenchTodosAvailable(result.todosAvailable ?? false);
    } catch {
      setWorkbench(null);
      setWorkbenchTasksAvailable(false);
      setWorkbenchTriggersAvailable(false);
      setWorkbenchTodosAvailable(false);
    } finally {
      setWorkbenchLoading(false);
    }
  }, [authenticated]);

  // The workbench load normally fires on the agent-state "running" edge
  // (useAgentGreetingEffects). When that edge lands before the auth probe
  // resolves the load is suppressed by the gate above, so fire it once the
  // session flips to authenticated with the agent already reachable.
  const workbenchAuthArmedRef = useRef(authenticated);
  useEffect(() => {
    const was = workbenchAuthArmedRef.current;
    workbenchAuthArmedRef.current = authenticated;
    if (!was && authenticated && agentReachable) {
      void loadWorkbench();
    }
  }, [agentReachable, authenticated, loadWorkbench]);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateChannelSaving, setUpdateChannelSaving] = useState(false);
  const updateChannelSavingRef = useRef(false);

  const loadUpdateStatus = useCallback(async (force = false) => {
    setUpdateLoading(true);
    try {
      const status = await client.getUpdateStatus(force);
      setUpdateStatus(status);
    } catch {
      /* ignore */
    }
    setUpdateLoading(false);
  }, []);

  const [extensionStatus, setExtensionStatus] =
    useState<ExtensionStatus | null>(null);
  const [extensionChecking, setExtensionChecking] = useState(false);

  const checkExtensionStatus = useCallback(async () => {
    setExtensionChecking(true);
    try {
      const ext = await client.getExtensionStatus();
      setExtensionStatus(ext);
    } catch {
      setExtensionStatus({
        relayReachable: false,
        relayPort: 18792,
        extensionPath: null,
        chromeBuildPath: null,
        chromePackagePath: null,
        safariWebExtensionPath: null,
        safariAppPath: null,
        safariPackagePath: null,
      });
    }
    setExtensionChecking(false);
  }, []);

  // ── Channel change ──────────────────────────────────────────────────

  const handleChannelChange = useCallback(
    async (channel: "stable" | "beta" | "nightly") => {
      if (updateChannelSavingRef.current || updateChannelSaving) return;
      if (updateStatus?.channel === channel) return;
      updateChannelSavingRef.current = true;
      setUpdateChannelSaving(true);
      try {
        await client.setUpdateChannel(channel);
        await loadUpdateStatus(true);
      } catch {
        /* ignore */
      } finally {
        updateChannelSavingRef.current = false;
        setUpdateChannelSaving(false);
      }
    },
    [updateChannelSaving, updateStatus, loadUpdateStatus],
  );

  return {
    // Autonomy
    applyAutonomyEventMerge,
    fetchAutonomyReplay,
    appendAutonomousEvent,
    // Conversations
    loadConversations,
    loadConversationMessages,
    loadConversationMessagesAround,
    prefetchConversationMessages,
    loadedConversationIdRef,
    // BSC / Steward / Trading
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    getStewardStatus,
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    loadWalletTradingProfile,
    executeBscTrade,
    executeBscTransfer,
    loadInventory,
    // Workbench
    workbenchLoading,
    workbench,
    workbenchTasksAvailable,
    workbenchTriggersAvailable,
    workbenchTodosAvailable,
    loadWorkbench,
    // Updates
    updateStatus,
    updateLoading,
    updateChannelSaving,
    loadUpdateStatus,
    handleChannelChange,
    // Extension
    extensionStatus,
    extensionChecking,
    checkExtensionStatus,
  };
}
