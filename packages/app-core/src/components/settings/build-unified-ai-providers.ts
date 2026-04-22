/**
 * Merges onboarding’s AI-provider catalog with live `ai-provider` plugins for Settings.
 *
 * WHY: Settings must show the **same ordering and coverage** as onboarding “connection” (so users do
 * not see a different universe of rows), but the agent can expose **extra** plugins not in the static
 * catalog — we append those so unknown providers still appear. Subscription-only rows stay out of this
 * slice (`isSettingsCatalogEntry`) because billing/subscription UX is handled elsewhere.
 */
import type { ProviderOption } from "@elizaos/shared/contracts/onboarding";
import type { PluginParamDef } from "../../api";
import type { CustomProviderOption } from "../../config/branding";
import {
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  ONBOARDING_PROVIDER_CATALOG,
  sortOnboardingProviders,
} from "../../providers";
import type { ConfigUiHint } from "../../types";

/** Mirrors `ProviderSwitcher` / plugin API shape. */
export interface UnifiedAiProviderPlugin {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
  parameters: PluginParamDef[];
  configUiHints?: Record<string, ConfigUiHint>;
}

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

function isSettingsCatalogEntry(option: ProviderOption): boolean {
  if (option.id === "elizacloud") return false;
  if (option.authMode === "subscription" || option.group === "subscription") {
    return false;
  }
  return true;
}

function customToProviderOption(custom: CustomProviderOption): ProviderOption {
  return {
    id: custom.id as ProviderOption["id"],
    name: custom.name,
    envKey: custom.envKey,
    pluginName: custom.pluginName,
    keyPrefix: custom.keyPrefix,
    description: custom.description,
    family: custom.family as ProviderOption["family"],
    authMode: custom.authMode,
    group: custom.group,
    order: custom.order,
    recommended: custom.recommended,
  };
}

function findPluginForCatalogEntry(
  plugins: readonly UnifiedAiProviderPlugin[],
  catalogId: string,
): UnifiedAiProviderPlugin | undefined {
  return plugins.find((plugin) => {
    if (plugin.category !== "ai-provider") return false;
    const resolved = getOnboardingProviderOption(
      normalizeAiProviderPluginId(plugin.id),
    )?.id;
    return resolved === catalogId;
  });
}

export function buildUnifiedAiProviderPlugins(
  plugins: readonly UnifiedAiProviderPlugin[],
  customProviders: readonly CustomProviderOption[] | undefined,
): UnifiedAiProviderPlugin[] {
  const catalogSlice = ONBOARDING_PROVIDER_CATALOG.filter(
    isSettingsCatalogEntry,
  ) as ProviderOption[];
  const sortedCatalog = sortOnboardingProviders([...catalogSlice]);
  const catalogIds = new Set(sortedCatalog.map((entry) => entry.id as string));
  const customExtra = (customProviders ?? []).filter(
    (custom) => !catalogIds.has(custom.id),
  );
  const orderedCatalog: ProviderOption[] = [
    ...sortedCatalog,
    ...customExtra.map(customToProviderOption),
  ];

  const usedPluginIds = new Set<string>();
  const rows: UnifiedAiProviderPlugin[] = [];

  for (const opt of orderedCatalog) {
    const match = findPluginForCatalogEntry(plugins, opt.id as string);
    if (match) {
      rows.push(match);
      usedPluginIds.add(match.id);
    } else {
      rows.push({
        id: opt.pluginName,
        name: opt.name,
        category: "ai-provider",
        enabled: false,
        configured: false,
        parameters: [],
      });
    }
  }

  for (const plugin of plugins) {
    if (plugin.category !== "ai-provider") continue;
    if (usedPluginIds.has(plugin.id)) continue;
    const resolvedId =
      getOnboardingProviderOption(normalizeAiProviderPluginId(plugin.id))?.id ??
      null;
    // Eliza Cloud and subscription picks have dedicated rows in ProviderSwitcher.
    if (resolvedId === "elizacloud") continue;
    if (resolvedId && isSubscriptionProviderSelectionId(resolvedId)) continue;
    rows.push(plugin);
  }

  return rows;
}
