/**
 * Selection + routing-state logic for ProviderSwitcher.
 *
 * Owns the cross-cutting state that drives which provider panel is active
 * (cloud / local / subscription / api-key) plus the saga of switching between
 * them. Extracted so the ProviderSwitcher.tsx orchestrator can stay focused on
 * composition.
 */
import {
  asRecord,
  normalizeSubscriptionProviderSelectionId,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import { useBranding } from "../../config/branding";
import { isElizaCloudRuntimeLocked } from "../../onboarding/mobile-runtime-mode";
import {
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";

export type ProviderPanelId = "__cloud__" | "__local__" | string;

interface AiProviderLike {
  id: string;
}

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

function readSubscriptionProvider(
  cfg: Record<string, unknown>,
): SubscriptionProviderSelectionId | null {
  const agents = asRecord(cfg.agents);
  const defaults = asRecord(agents?.defaults);
  return normalizeSubscriptionProviderSelectionId(
    defaults?.subscriptionProvider,
  );
}

export interface ProviderSelection {
  cloudCallsDisabled: boolean;
  /**
   * True when the host app requires cloud (branding.cloudOnly or
   * mobile runtime is locked to cloud). Local-only switching is blocked.
   */
  cloudRuntimeLocked: boolean;
  routingModeSaving: boolean;
  localEmbeddings: boolean;
  resolvedSelectedId: string | null;
  visibleProviderPanelId: ProviderPanelId;
  isCloudSelected: boolean;
  initializeFromConfig: (cfg: Record<string, unknown>) => void;
  handleSwitchProvider: (newId: string, providerId: string) => Promise<void>;
  handleSelectSubscription: (
    providerId: SubscriptionProviderSelectionId,
    activate?: boolean,
  ) => Promise<void>;
  handleSelectCloud: () => Promise<void>;
  handleSelectLocalOnly: () => Promise<void>;
  handleToggleLocalEmbeddings: (next: boolean) => Promise<void>;
  handleProviderPanelSelect: (panelId: string) => void;
}

export function useProviderSelection(
  availableProviderIds: Set<string>,
  notifySelectionFailure: (prefix: string, err: unknown) => void,
): ProviderSelection {
  const app = useApp();
  const branding = useBranding();
  const cloudRuntimeLocked =
    branding.cloudOnly === true || isElizaCloudRuntimeLocked();
  const [cloudCallsDisabled, setCloudCallsDisabled] = useState(false);
  const [routingModeSaving, setRoutingModeSaving] = useState(false);
  const [localEmbeddings, setLocalEmbeddings] = useState(false);
  const hasManualSelection = useRef(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const hasManualPanelSelection = useRef(false);
  const [selectedProviderPanelId, setSelectedProviderPanelId] =
    useState<ProviderPanelId | null>(null);

  const readCloudCallsDisabled = useCallback(
    (cfg: Record<string, unknown>): boolean => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      if (
        llmText?.transport === "cloud-proxy" ||
        llmText?.transport === "direct" ||
        llmText?.transport === "remote"
      ) {
        return false;
      }
      const cloud = asRecord(cfg.cloud);
      const services = asRecord(cloud?.services);
      return Boolean(
        cloud?.inferenceMode === "local" || services?.inference === false,
      );
    },
    [],
  );

  const readLocalEmbeddingsFromConfig = useCallback(
    (cfg: Record<string, unknown>): boolean => {
      const embeddings = resolveServiceRoutingInConfig(cfg)?.embeddings;
      if (embeddings === undefined) return true;
      return !(
        embeddings.transport === "cloud-proxy" &&
        embeddings.backend === "elizacloud"
      );
    },
    [],
  );

  const initializeFromConfig = useCallback(
    (cfg: Record<string, unknown>) => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
      const savedSubscriptionProvider = readSubscriptionProvider(cfg);
      const nextSelectedId =
        llmText?.transport === "cloud-proxy" && providerId === "elizacloud"
          ? "__cloud__"
          : llmText?.transport === "direct"
            ? (providerId ?? null)
            : llmText?.transport === "remote" && providerId
              ? providerId
              : savedSubscriptionProvider;

      if (!hasManualSelection.current) {
        setSelectedProviderId(nextSelectedId);
      }
      setCloudCallsDisabled(readCloudCallsDisabled(cfg));
      setLocalEmbeddings(readLocalEmbeddingsFromConfig(cfg));
    },
    [readCloudCallsDisabled, readLocalEmbeddingsFromConfig],
  );

  const resolvedSelectedId = useMemo(
    () =>
      selectedProviderId === "__cloud__"
        ? "__cloud__"
        : selectedProviderId &&
            (availableProviderIds.has(selectedProviderId) ||
              isSubscriptionProviderSelectionId(selectedProviderId))
          ? selectedProviderId
          : null,
    [availableProviderIds, selectedProviderId],
  );

  const restoreSelection = useCallback(
    (previousSelectedId: string | null, previousManualSelection: boolean) => {
      hasManualSelection.current = previousManualSelection;
      setSelectedProviderId(previousSelectedId);
    },
    [],
  );

  const handleSwitchProvider = useCallback(
    async (newId: string, providerId: string) => {
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      const previousCloudCallsDisabled = cloudCallsDisabled;
      hasManualSelection.current = true;
      setSelectedProviderId(newId);
      setCloudCallsDisabled(false);
      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        setCloudCallsDisabled(previousCloudCallsDisabled);
        notifySelectionFailure("Failed to switch AI provider", err);
      }
    },
    [
      cloudCallsDisabled,
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
    ],
  );

  const handleSelectSubscription = useCallback(
    async (
      providerId: SubscriptionProviderSelectionId,
      activate: boolean = true,
    ) => {
      if (!cloudCallsDisabled && resolvedSelectedId === providerId) return;
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      const previousCloudCallsDisabled = cloudCallsDisabled;
      hasManualSelection.current = true;
      setSelectedProviderId(providerId);
      if (!activate) return;
      setCloudCallsDisabled(false);
      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        setCloudCallsDisabled(previousCloudCallsDisabled);
        notifySelectionFailure("Failed to update subscription provider", err);
      }
    },
    [
      cloudCallsDisabled,
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
    ],
  );

  const handleSelectCloud = useCallback(async () => {
    if (!cloudCallsDisabled && resolvedSelectedId === "__cloud__") return;
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    const previousCloudCallsDisabled = cloudCallsDisabled;
    hasManualSelection.current = true;
    setSelectedProviderId("__cloud__");
    setCloudCallsDisabled(false);
    setRoutingModeSaving(true);
    try {
      await client.switchProvider("elizacloud");
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      setCloudCallsDisabled(previousCloudCallsDisabled);
      notifySelectionFailure("Failed to select Eliza Cloud", err);
    } finally {
      setRoutingModeSaving(false);
    }
  }, [
    cloudCallsDisabled,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const handleSelectLocalOnly = useCallback(async () => {
    if (cloudRuntimeLocked) {
      app.setActionNotice?.(
        "Eliza Cloud is required while this app is running in cloud mode.",
        "error",
        6000,
      );
      return;
    }
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    const previousCloudCallsDisabled = cloudCallsDisabled;
    hasManualSelection.current = true;
    setCloudCallsDisabled(true);
    setRoutingModeSaving(true);
    try {
      await app.handleCloudDisconnect({ skipConfirmation: true });
      void client.restartAgent().catch((err) => {
        notifySelectionFailure("Local-only mode saved; restart failed", err);
      });
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      setCloudCallsDisabled(previousCloudCallsDisabled);
      notifySelectionFailure("Failed to enable local-only mode", err);
    } finally {
      setRoutingModeSaving(false);
    }
  }, [
    app,
    cloudCallsDisabled,
    cloudRuntimeLocked,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const handleToggleLocalEmbeddings = useCallback(
    async (nextValue: boolean) => {
      const previous = localEmbeddings;
      setLocalEmbeddings(nextValue);
      try {
        await client.switchProvider("elizacloud", undefined, undefined, {
          useLocalEmbeddings: nextValue,
        });
      } catch (err) {
        setLocalEmbeddings(previous);
        notifySelectionFailure("Failed to update embeddings preference", err);
      }
    },
    [localEmbeddings, notifySelectionFailure],
  );

  const isCloudSelected =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  // When the runtime is locked to cloud, ignore local persistence in the
  // routing config — the user can't be on local even if config says so.
  const effectiveCloudCallsDisabled = cloudRuntimeLocked
    ? false
    : cloudCallsDisabled;
  const activeProviderPanelId: ProviderPanelId = effectiveCloudCallsDisabled
    ? "__local__"
    : (resolvedSelectedId ?? "__cloud__");
  const visibleProviderPanelId: ProviderPanelId =
    selectedProviderPanelId ?? activeProviderPanelId;

  useEffect(() => {
    if (cloudRuntimeLocked && selectedProviderPanelId === "__local__") {
      hasManualPanelSelection.current = false;
      setSelectedProviderPanelId("__cloud__");
      return;
    }
    if (hasManualPanelSelection.current) return;
    setSelectedProviderPanelId(activeProviderPanelId);
  }, [activeProviderPanelId, cloudRuntimeLocked, selectedProviderPanelId]);

  const handleProviderPanelSelect = useCallback(
    (panelId: string) => {
      if (cloudRuntimeLocked && panelId === "__local__") return;
      hasManualPanelSelection.current = true;
      setSelectedProviderPanelId(panelId);
    },
    [cloudRuntimeLocked],
  );

  return {
    cloudCallsDisabled: effectiveCloudCallsDisabled,
    cloudRuntimeLocked,
    routingModeSaving,
    localEmbeddings,
    resolvedSelectedId,
    visibleProviderPanelId,
    isCloudSelected,
    initializeFromConfig,
    handleSwitchProvider,
    handleSelectSubscription,
    handleSelectCloud,
    handleSelectLocalOnly,
    handleToggleLocalEmbeddings,
    handleProviderPanelSelect,
  };
}

/**
 * Compute the canonical provider id to send to client.switchProvider() given
 * a panel id. Mirrors the existing normalize-and-look-up flow.
 */
export function resolveProviderIdForSwitch(
  newId: string,
  aiProviders: AiProviderLike[],
): string {
  const target =
    aiProviders.find(
      (provider) =>
        (getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
          ?.id ?? normalizeAiProviderPluginId(provider.id)) === newId,
    ) ?? null;
  return (
    getOnboardingProviderOption(
      normalizeAiProviderPluginId(target?.id ?? newId),
    )?.id ?? newId
  );
}
