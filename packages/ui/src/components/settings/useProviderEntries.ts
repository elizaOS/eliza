/**
 * Builds the ordered provider list ProviderSwitcher renders — merging enabled
 * AI-provider plugins, account-managed direct providers, and subscription
 * selections into a deduped, sorted set of entries with icons and categories.
 * Cloud is current only when connected; a configured-but-unsigned-in
 * cloud-proxy session marks Local current instead (#20045).
 */

import type { SubscriptionProviderStatus } from "@elizaos/shared";
import { Cloud, Cpu, KeyRound } from "lucide-react";
import { type ComponentType, useCallback, useMemo } from "react";
import type { PluginParamDef } from "../../api";
import { getFrontendPlatform } from "../../platform/platform-guards";
import {
  FIRST_RUN_PROVIDER_CATALOG,
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
} from "../../providers";
import type { ConfigUiHint } from "../../types";
import type { ProviderCategory, ProviderStatus } from "./ProviderCard";
import type { ProviderPanelId } from "./useProviderSelection";

export interface PluginInfo {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
  parameters: PluginParamDef[];
  configUiHints?: Record<string, ConfigUiHint>;
}

export interface ProviderListEntry {
  id: ProviderPanelId;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  category: ProviderCategory;
  status: ProviderStatus;
  current: boolean;
}

export interface ApiProviderChoice {
  id: string;
  label: string;
  provider: PluginInfo;
}

export function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

export function sortAiProviders(plugins: PluginInfo[]): PluginInfo[] {
  return [...plugins.filter((p) => p.category === "ai-provider")].sort(
    (left, right) => {
      const leftCatalog = getFirstRunProviderOption(
        normalizeAiProviderPluginId(left.id),
      );
      const rightCatalog = getFirstRunProviderOption(
        normalizeAiProviderPluginId(right.id),
      );
      if (leftCatalog && rightCatalog) {
        return leftCatalog.order - rightCatalog.order;
      }
      if (leftCatalog) return -1;
      if (rightCatalog) return 1;
      return left.name.localeCompare(right.name);
    },
  );
}

export function computeAvailableProviderIds(
  allAiProviders: PluginInfo[],
): Set<string> {
  return new Set(
    [
      ...allAiProviders.map(
        (provider) =>
          getFirstRunProviderOption(normalizeAiProviderPluginId(provider.id))
            ?.id,
      ),
      ...FIRST_RUN_PROVIDER_CATALOG.filter(
        (option) =>
          option.authMode === "api-key" &&
          getDirectAccountProviderForFirstRunProvider(option.id),
      ).map((option) => option.id),
    ].filter((id): id is NonNullable<typeof id> => id != null),
  );
}

interface UseProviderEntriesArgs {
  allAiProviders: PluginInfo[];
  elizaCloudConnected: boolean;
  cloudCallsDisabled: boolean;
  /** Cloud is selected AND able to serve. */
  isCloudSelected: boolean;
  /** Cloud is named by the routing config, regardless of sign-in state. */
  isCloudConfigured: boolean;
  resolvedSelectedId: string | null;
  subscriptionStatus: SubscriptionProviderStatus[];
  anthropicCliDetected: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export interface UseProviderEntriesResult {
  apiProviderChoices: ApiProviderChoice[];
  providerEntries: ProviderListEntry[];
  /** Cloud is the configured route but Local is answering because unsigned-in. */
  servingLocalFallback: boolean;
}

export function useProviderEntries({
  allAiProviders,
  elizaCloudConnected,
  cloudCallsDisabled,
  isCloudSelected,
  isCloudConfigured,
  resolvedSelectedId,
  subscriptionStatus,
  anthropicCliDetected,
  t,
}: UseProviderEntriesArgs): UseProviderEntriesResult {
  const apiProviderChoices = useMemo<ApiProviderChoice[]>(() => {
    const pluginChoices = allAiProviders
      .map((provider) => {
        const option = getFirstRunProviderOption(
          normalizeAiProviderPluginId(provider.id),
        );
        return option ? { id: option.id, label: option.name, provider } : null;
      })
      .filter(
        (choice): choice is NonNullable<typeof choice> => choice !== null,
      );
    const seen = new Set(pluginChoices.map((choice) => choice.id));
    const accountManagedChoices = FIRST_RUN_PROVIDER_CATALOG.filter(
      (option) =>
        option.authMode === "api-key" &&
        getDirectAccountProviderForFirstRunProvider(option.id) &&
        !seen.has(option.id),
    ).map((option) => ({
      id: option.id,
      label: option.name,
      provider: {
        id: option.id,
        name: option.name,
        category: "ai-provider",
        enabled: false,
        configured: false,
        parameters: [],
      } satisfies PluginInfo,
    }));
    return [...pluginChoices, ...accountManagedChoices].sort((left, right) => {
      const leftOrder =
        getFirstRunProviderOption(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        getFirstRunProviderOption(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }, [allAiProviders]);

  /**
   * Single source of truth for sidebar entry status.
   * Replaces three diverging functions (Cloud/Local hardcoded rows,
   * getSubscriptionPanelStatus, inline apiProviderChoices status).
   */
  // Configured for Cloud, but Cloud cannot serve — local answers instead.
  // Reads the *configured* flag: `isCloudSelected` is already reconciled
  // against sign-in, so it is false in exactly the state being detected here.
  const servingLocalFallback =
    isCloudConfigured && !elizaCloudConnected && !cloudCallsDisabled;

  const getProviderStatus = useCallback(
    (entryId: ProviderPanelId): ProviderStatus => {
      if (entryId === "__cloud__") {
        if (elizaCloudConnected) {
          return { tone: "ok", label: "Connected" };
        }
        // Configured (cloud-proxy) but not signed in — surface a clear
        // warning instead of the ambiguous "Available" so the user can see
        // why Cloud is not actually serving requests (#20045).
        if (isCloudConfigured) {
          return { tone: "warn", label: "Not signed in" };
        }
        return { tone: "muted", label: "Available" };
      }
      if (entryId === "__local__") {
        // Cloud-proxy without a signed-in account falls through to local
        // inference. Mark Local Active in that state, not just when the
        // user has explicitly chosen local-only (#20045).
        return cloudCallsDisabled || servingLocalFallback
          ? { tone: "ok", label: "Active" }
          : { tone: "muted", label: "Available" };
      }
      if (isSubscriptionProviderSelectionId(entryId)) {
        const subSelection = SUBSCRIPTION_PROVIDER_SELECTIONS.find(
          (provider) => provider.id === entryId,
        );
        const statuses = subscriptionStatus.filter(
          (entry) =>
            entry.provider === entryId ||
            (subSelection
              ? entry.provider === subSelection.storedProvider
              : false),
        );
        if (
          statuses.length > 0 &&
          statuses.every((status) => status.available === false)
        ) {
          return { tone: "warn", label: "Unavailable" };
        }
        if (entryId === "anthropic-subscription" && anthropicCliDetected) {
          return { tone: "ok", label: "CLI detected" };
        }
        if (
          entryId === "gemini-subscription" &&
          statuses.some(
            (status) =>
              status.source === "gemini-cli" &&
              status.configured &&
              status.valid,
          )
        ) {
          return { tone: "ok", label: "CLI detected" };
        }
        if (statuses.some((status) => status.configured && status.valid)) {
          return { tone: "ok", label: "Connected" };
        }
        if (statuses.some((status) => status.configured && !status.valid)) {
          return { tone: "warn", label: "Needs repair" };
        }
        return { tone: "muted", label: "Not connected" };
      }
      const choice = apiProviderChoices.find((c) => c.id === entryId);
      if (!choice) return { tone: "muted", label: "Available" };
      return choice.provider.configured
        ? { tone: "ok", label: "API key set" }
        : { tone: "warn", label: "Needs key" };
    },
    [
      anthropicCliDetected,
      apiProviderChoices,
      cloudCallsDisabled,
      elizaCloudConnected,
      isCloudConfigured,
      servingLocalFallback,
      subscriptionStatus,
    ],
  );

  const providerEntries = useMemo<ProviderListEntry[]>(() => {
    const entries: ProviderListEntry[] = [];
    const localEntry: ProviderListEntry = {
      id: "__local__",
      icon: Cpu,
      label: "Local provider",
      category: "local",
      status: getProviderStatus("__local__"),
      current: cloudCallsDisabled || servingLocalFallback,
    };
    // On phones the headline choice is Cloud vs on-device, so surface the local
    // provider right after Cloud. On desktop/web the subscription + API-key
    // providers come first and local sits after them (its long-standing spot).
    const platform = getFrontendPlatform();
    const localProviderFirst = platform === "ios" || platform === "android";
    entries.push({
      id: "__cloud__",
      icon: Cloud,
      label: "Eliza Cloud",
      category: "cloud",
      status: getProviderStatus("__cloud__"),
      // Only mark Cloud as current when it is actually connected. When
      // cloud-proxy is configured but the user is not signed in, the runtime
      // silently falls back to local inference; marking Cloud "current" in
      // that state is dishonest (#20045).
      current: !cloudCallsDisabled && isCloudSelected,
    });
    if (localProviderFirst) {
      entries.push(localEntry);
    }
    for (const provider of SUBSCRIPTION_PROVIDER_SELECTIONS) {
      entries.push({
        id: provider.id,
        icon: KeyRound,
        label: t(provider.labelKey, { defaultValue: provider.id }),
        category: "subscription",
        status: getProviderStatus(provider.id),
        current: !cloudCallsDisabled && resolvedSelectedId === provider.id,
      });
    }
    if (!localProviderFirst) {
      entries.push(localEntry);
    }
    for (const choice of apiProviderChoices) {
      entries.push({
        id: choice.id,
        icon: KeyRound,
        label: choice.label,
        category: "key",
        status: getProviderStatus(choice.id),
        current: !cloudCallsDisabled && resolvedSelectedId === choice.id,
      });
    }
    return entries;
  }, [
    apiProviderChoices,
    cloudCallsDisabled,
    getProviderStatus,
    isCloudSelected,
    resolvedSelectedId,
    servingLocalFallback,
    t,
  ]);

  return {
    apiProviderChoices,
    providerEntries,
    servingLocalFallback,
  };
}
