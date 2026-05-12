import type { SubscriptionProviderStatus } from "@elizaos/shared";
import { Cloud, Cpu, KeyRound } from "lucide-react";
import { type ComponentType, useCallback, useMemo } from "react";
import type { PluginParamDef } from "../../api";
import {
  getDirectAccountProviderForOnboardingProvider,
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  ONBOARDING_PROVIDER_CATALOG,
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
      const leftCatalog = getOnboardingProviderOption(
        normalizeAiProviderPluginId(left.id),
      );
      const rightCatalog = getOnboardingProviderOption(
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
          getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
            ?.id,
      ),
      ...ONBOARDING_PROVIDER_CATALOG.filter(
        (option) =>
          option.authMode === "api-key" &&
          getDirectAccountProviderForOnboardingProvider(option.id),
      ).map((option) => option.id),
    ].filter((id): id is NonNullable<typeof id> => id != null),
  );
}

interface UseProviderEntriesArgs {
  allAiProviders: PluginInfo[];
  elizaCloudConnected: boolean;
  cloudCallsDisabled: boolean;
  isCloudSelected: boolean;
  resolvedSelectedId: string | null;
  subscriptionStatus: SubscriptionProviderStatus[];
  anthropicCliDetected: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export interface UseProviderEntriesResult {
  apiProviderChoices: ApiProviderChoice[];
  providerEntries: ProviderListEntry[];
}

export function useProviderEntries({
  allAiProviders,
  elizaCloudConnected,
  cloudCallsDisabled,
  isCloudSelected,
  resolvedSelectedId,
  subscriptionStatus,
  anthropicCliDetected,
  t,
}: UseProviderEntriesArgs): UseProviderEntriesResult {
  const apiProviderChoices = useMemo<ApiProviderChoice[]>(() => {
    const pluginChoices = allAiProviders
      .map((provider) => {
        const option = getOnboardingProviderOption(
          normalizeAiProviderPluginId(provider.id),
        );
        return option ? { id: option.id, label: option.name, provider } : null;
      })
      .filter(
        (choice): choice is NonNullable<typeof choice> => choice !== null,
      );
    const seen = new Set(pluginChoices.map((choice) => choice.id));
    const accountManagedChoices = ONBOARDING_PROVIDER_CATALOG.filter(
      (option) =>
        option.authMode === "api-key" &&
        getDirectAccountProviderForOnboardingProvider(option.id) &&
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
        getOnboardingProviderOption(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        getOnboardingProviderOption(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }, [allAiProviders]);

  /**
   * Single source of truth for sidebar entry status.
   * Replaces three diverging functions (Cloud/Local hardcoded rows,
   * getSubscriptionPanelStatus, inline apiProviderChoices status).
   */
  const getProviderStatus = useCallback(
    (entryId: ProviderPanelId): ProviderStatus => {
      if (entryId === "__cloud__") {
        return elizaCloudConnected
          ? { tone: "ok", label: "Connected" }
          : { tone: "muted", label: "Available" };
      }
      if (entryId === "__local__") {
        return cloudCallsDisabled
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
      subscriptionStatus,
    ],
  );

  const providerEntries = useMemo<ProviderListEntry[]>(() => {
    const entries: ProviderListEntry[] = [];
    entries.push({
      id: "__cloud__",
      icon: Cloud,
      label: "Eliza Cloud",
      category: "cloud",
      status: getProviderStatus("__cloud__"),
      current: !cloudCallsDisabled && isCloudSelected,
    });
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
    entries.push({
      id: "__local__",
      icon: Cpu,
      label: "Local provider",
      category: "local",
      status: getProviderStatus("__local__"),
      current: cloudCallsDisabled,
    });
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
    t,
  ]);

  return {
    apiProviderChoices,
    providerEntries,
  };
}
