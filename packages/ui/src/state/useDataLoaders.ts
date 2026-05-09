/**
 * Data-loading callbacks — extracted from AppContext.
 *
 * Covers: autonomy event merge / replay / append, conversation loaders,
 * BSC trade + steward wrappers, loadInventory, ownerName hydration,
 * character language sync, loadWorkbench, loadUpdateStatus,
 * checkExtensionStatus.
 */

import { resolveStylePresetByAvatarIndex } from "@elizaos/shared";
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
import type { LoadConversationMessagesResult } from "./internal";

// ── Helpers (module-level, no React deps) ────────────────────────────

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
  onboardingComplete: boolean;
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
    onboardingComplete,
    uiLanguage,
    setOwnerNameState,
  } = deps;

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
    } catch (err) {
      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
      console.warn("[eliza] Failed to fetch autonomous event replay", err);
    } finally {
      autonomousReplayInFlightRef.current = false;
    }
  }, [
    applyAutonomyEventMerge,
    autonomousReplayInFlightRef,
    autonomousRunHealthByRunIdRef,
    autonomousStoreRef.current,
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
      try {
        const { messages } = await client.getConversationMessages(convId);
        const nextMessages = filterRenderableConversationMessages(messages);
        greetingFiredRef.current =
          hasConversationBootstrapMessage(nextMessages);
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return { ok: true };
      } catch (err) {
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
        }
        greetingFiredRef.current = false;
        conversationMessagesRef.current = [];
        setConversationMessages([]);
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
      conversationMessagesRef,
      greetingFiredRef,
      setActiveConversationId,
      setConversationMessages,
      setConversations,
    ],
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

  useEffect(() => {
    let cancelled = false;
    void client
      .getConfig()
      .then((cfg) => {
        if (cancelled) {
          return;
        }

        const name = (cfg as Record<string, unknown>).ui as
          | Record<string, unknown>
          | undefined;
        const persisted = normalizeOwnerName(name?.ownerName as string);
        if (persisted) {
          setOwnerNameState(persisted);
        }
      })
      .catch(() => {})
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [setOwnerNameState]);

  // ── Character language sync ─────────────────────────────────────────

  const localizedCharacterLanguageRef = useRef<UiLanguage>(uiLanguage);

  useEffect(() => {
    const previousLanguage = localizedCharacterLanguageRef.current;
    localizedCharacterLanguageRef.current = uiLanguage;

    if (previousLanguage === uiLanguage) {
      return;
    }
    if (!onboardingComplete || selectedVrmIndex <= 0) {
      return;
    }

    const preset = resolveStylePresetByAvatarIndex(
      selectedVrmIndex,
      uiLanguage,
    );
    if (!preset) {
      return;
    }

    const resolvedName =
      characterData?.name?.trim() ||
      characterDraft?.name?.trim() ||
      agentStatus?.agentName?.trim() ||
      preset.name;

    void (async () => {
      try {
        await client.updateCharacter(
          buildLocalizedCharacterPayload(preset, resolvedName),
        );
        await loadCharacter();
      } catch (err) {
        console.warn(
          "[eliza] Failed to sync localized character preset after language change",
          err,
        );
      }
    })();
  }, [
    agentStatus?.agentName,
    characterData?.name,
    characterDraft?.name,
    loadCharacter,
    onboardingComplete,
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
  }, []);

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
