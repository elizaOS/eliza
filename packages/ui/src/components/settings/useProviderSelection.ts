/**
 * Selection + routing-state logic for ProviderSwitcher.
 *
 * Owns the cross-cutting state that drives which provider panel is active
 * (cloud / local / subscription / api-key) plus the saga of switching between
 * them. A configured-but-unsigned-in cloud-proxy session defaults the open
 * panel to Local so first paint matches the provider actually serving.
 */
import {
  asRecord,
  normalizeSubscriptionProviderSelectionId,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import { useBranding } from "../../config/branding";
import { isElizaCloudRuntimeLocked } from "../../first-run/mobile-runtime-mode";
import {
  getFirstRunProviderOption,
  isSubscriptionProviderSelectionId,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useAppSelectorShallow } from "../../state";
import { shellHistory, shellLocalStorage } from "../../surface-realm-channel";

export type ProviderPanelId = "__cloud__" | "__local__" | string;

const PROVIDER_PANEL_STORAGE_KEY = "eliza.settings.ai-model.panel";

function readRememberedProviderPanel(
  elizaCloudConnected: boolean,
): ProviderPanelId | null {
  if (typeof window === "undefined") return null;
  try {
    const remembered =
      new URLSearchParams(window.location.search).get("provider") ??
      window.localStorage.getItem(PROVIDER_PANEL_STORAGE_KEY);
    // A leftover Cloud panel pin from a previous visit would open Cloud
    // while Local is serving, so both tiles look active. Ignore it until
    // the account is actually connected.
    if (remembered === "__cloud__" && !elizaCloudConnected) return null;
    return remembered;
  } catch {
    return null;
  }
}

/**
 * Which intelligence panel should be open when the user has not picked one
 * this session. A configured-but-unsigned-in cloud-proxy session serves
 * Local, so the open panel follows Local rather than the stale Cloud pin.
 */
export function resolveDefaultIntelligencePanelId({
  cloudCallsDisabled,
  cloudRuntimeLocked,
  elizaCloudConnected,
  isCloudSelected,
  resolvedSelectedId,
}: {
  cloudCallsDisabled: boolean;
  cloudRuntimeLocked: boolean;
  elizaCloudConnected: boolean;
  isCloudSelected: boolean;
  resolvedSelectedId: string | null;
}): ProviderPanelId {
  if (cloudRuntimeLocked && elizaCloudConnected) return "__cloud__";
  if (cloudCallsDisabled) return "__local__";
  if (isCloudSelected && !elizaCloudConnected) return "__local__";
  if (cloudRuntimeLocked) return "__cloud__";
  return resolvedSelectedId ?? "__cloud__";
}

function rememberProviderPanel(panelId: ProviderPanelId): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(PROVIDER_PANEL_STORAGE_KEY, panelId);
    const url = new URL(window.location.href);
    url.searchParams.set("provider", panelId);
    shellHistory.replaceState(null, "", url);
  } catch {
    // error-policy:J4 Panel selection remains usable for this session when persistence is unavailable.
    return;
  }
}

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
  handleProviderPanelSelect: (panelId: string) => void;
}

export function useProviderSelection(
  availableProviderIds: Set<string>,
  notifySelectionFailure: (prefix: string, err: unknown) => void,
  elizaCloudConnected: boolean = false,
): ProviderSelection {
  const { setActionNotice, handleCloudDisconnect } = useAppSelectorShallow(
    (s) => ({
      setActionNotice: s.setActionNotice,
      handleCloudDisconnect: s.handleCloudDisconnect,
    }),
  );
  const branding = useBranding();
  const cloudRuntimeLocked =
    branding.cloudOnly === true || isElizaCloudRuntimeLocked();
  const [cloudCallsDisabled, setCloudCallsDisabled] = useState(false);
  const [routingModeSaving, setRoutingModeSaving] = useState(false);
  const hasManualSelection = useRef(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const hasClickedProviderPanel = useRef(false);
  const [selectedProviderPanelId, setSelectedProviderPanelId] =
    useState<ProviderPanelId | null>(() =>
      readRememberedProviderPanel(elizaCloudConnected),
    );

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

  const initializeFromConfig = useCallback(
    (cfg: Record<string, unknown>) => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      const providerId = getFirstRunProviderOption(llmText?.backend)?.id;
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
    },
    [readCloudCallsDisabled],
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
      setActionNotice?.(
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
      await handleCloudDisconnect({ skipConfirmation: true });
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
    setActionNotice,
    handleCloudDisconnect,
    cloudCallsDisabled,
    cloudRuntimeLocked,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const isCloudSelected =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  // When the runtime is locked to cloud, ignore local persistence in the
  // routing config — the user can't be on local even if config says so.
  const effectiveCloudCallsDisabled = cloudRuntimeLocked
    ? false
    : cloudCallsDisabled;
  const activeProviderPanelId = resolveDefaultIntelligencePanelId({
    cloudCallsDisabled: effectiveCloudCallsDisabled,
    cloudRuntimeLocked,
    elizaCloudConnected,
    isCloudSelected,
    resolvedSelectedId,
  });
  const visibleProviderPanelId: ProviderPanelId =
    selectedProviderPanelId ?? activeProviderPanelId;

  useEffect(() => {
    if (
      cloudRuntimeLocked &&
      elizaCloudConnected &&
      selectedProviderPanelId === "__local__"
    ) {
      hasClickedProviderPanel.current = false;
      setSelectedProviderPanelId("__cloud__");
      return;
    }
    // A restored Cloud pin (or a boot-time connected=true flip) must not
    // keep Cloud open once we know the account is disconnected — unless the
    // user clicked Cloud this session to inspect it.
    if (
      !elizaCloudConnected &&
      selectedProviderPanelId === "__cloud__" &&
      !hasClickedProviderPanel.current
    ) {
      setSelectedProviderPanelId("__local__");
      rememberProviderPanel("__local__");
      return;
    }
    if (hasClickedProviderPanel.current) return;
    setSelectedProviderPanelId(activeProviderPanelId);
  }, [
    activeProviderPanelId,
    cloudRuntimeLocked,
    elizaCloudConnected,
    selectedProviderPanelId,
  ]);

  const handleProviderPanelSelect = useCallback(
    (panelId: string) => {
      if (
        cloudRuntimeLocked &&
        elizaCloudConnected &&
        panelId === "__local__"
      ) {
        return;
      }
      hasClickedProviderPanel.current = true;
      setSelectedProviderPanelId(panelId);
      rememberProviderPanel(panelId);
    },
    [cloudRuntimeLocked, elizaCloudConnected],
  );

  return {
    cloudCallsDisabled: effectiveCloudCallsDisabled,
    cloudRuntimeLocked,
    routingModeSaving,
    resolvedSelectedId,
    visibleProviderPanelId,
    isCloudSelected,
    initializeFromConfig,
    handleSwitchProvider,
    handleSelectSubscription,
    handleSelectCloud,
    handleSelectLocalOnly,
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
        (getFirstRunProviderOption(normalizeAiProviderPluginId(provider.id))
          ?.id ?? normalizeAiProviderPluginId(provider.id)) === newId,
    ) ?? null;
  return (
    getFirstRunProviderOption(normalizeAiProviderPluginId(target?.id ?? newId))
      ?.id ?? newId
  );
}
