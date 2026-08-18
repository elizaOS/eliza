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
import { useCallback, useMemo, useRef, useState } from "react";
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
  /** Cloud is selected AND able to serve. Use this for "who is serving". */
  isCloudSelected: boolean;
  /** Cloud is named by the routing config, regardless of sign-in state. */
  isCloudConfigured: boolean;
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
  const [hasClickedProviderPanel, setHasClickedProviderPanel] = useState(false);
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

  // Config intent: the routing entry names Cloud. This stays true when the
  // account is signed out, because that is what the config says (#20045 U1).
  const isCloudConfigured =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  // Reconciled: Cloud is only *selected* for serving when it can actually
  // serve. Consumers previously each had to remember to qualify the raw
  // config flag with `elizaCloudConnected`; forgetting once is how the Cloud
  // tile came to be marked current while local answered every turn.
  const isCloudSelected = isCloudConfigured && elizaCloudConnected;
  // When the runtime is locked to cloud, ignore local persistence in the
  // routing config — the user can't be on local even if config says so.
  const configuredCloudCallsDisabled = cloudRuntimeLocked
    ? false
    : cloudCallsDisabled;
  // Cloud calls are equally unavailable when configured-but-unreachable, so
  // the flag now flips for that state too rather than staying config-only
  // (#20045 U2). `cloudRuntimeLocked` still wins: a cloud-only build has no
  // local path to fall back to.
  const effectiveCloudCallsDisabled =
    configuredCloudCallsDisabled ||
    (!cloudRuntimeLocked && isCloudConfigured && !elizaCloudConnected);
  const activeProviderPanelId = resolveDefaultIntelligencePanelId({
    cloudCallsDisabled: effectiveCloudCallsDisabled,
    cloudRuntimeLocked,
    elizaCloudConnected,
    isCloudSelected,
    resolvedSelectedId,
  });
  // Keep the default panel derived instead of mirroring it into state from a
  // passive effect. Besides avoiding an unnecessary render, this prevents a
  // provider section mounted during Settings navigation from recursively
  // scheduling updates while React is still committing that screen (#20974).
  const visibleProviderPanelId: ProviderPanelId =
    cloudRuntimeLocked &&
    elizaCloudConnected &&
    selectedProviderPanelId === "__local__"
      ? "__cloud__"
      : !elizaCloudConnected &&
          selectedProviderPanelId === "__cloud__" &&
          !hasClickedProviderPanel
        ? "__local__"
        : (selectedProviderPanelId ?? activeProviderPanelId);

  const handleProviderPanelSelect = useCallback(
    (panelId: string) => {
      if (
        cloudRuntimeLocked &&
        elizaCloudConnected &&
        panelId === "__local__"
      ) {
        return;
      }
      setHasClickedProviderPanel(true);
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
    isCloudConfigured,
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
