import {
  getOnboardingProviderListLabelKey,
  getOnboardingProviderOption,
  normalizeOnboardingProviderId,
} from "@elizaos/shared/contracts/onboarding";

/**
 * Label for an **ai-provider** plugin row in settings / pickers. Uses the
 * onboarding catalog + `provider.*` / `labelKey` i18n entries, with
 * **plugin.name** and catalog **name** as fallbacks.
 */
export function formatOnboardingPluginProviderLabel(
  rawPluginId: string,
  pluginDisplayName: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const normalized =
    normalizeOnboardingProviderId(rawPluginId) ??
    rawPluginId
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/^plugin-/, "");

  const opt = getOnboardingProviderOption(normalized);
  const fallback = opt?.name ?? pluginDisplayName;

  const key =
    getOnboardingProviderListLabelKey(normalized) ?? `provider.${normalized}`;
  const translated = t(key, { defaultValue: fallback });
  return translated !== key ? translated : fallback;
}
