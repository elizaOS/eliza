/** Provider logo mapping — maps AI provider IDs to their logo image paths. */
export {
  getDirectAccountProviderForOnboardingProvider,
  getOnboardingProviderFamily,
  getOnboardingProviderOption,
  getStoredOnboardingProviderId,
  getStoredSubscriptionProvider,
  getSubscriptionProviderFamily,
  isSubscriptionProviderSelectionId,
  normalizeOnboardingProviderId,
  normalizeSubscriptionProviderSelectionId,
  ONBOARDING_PROVIDER_CATALOG,
  type OnboardingProviderId,
  type ProviderOption as OnboardingProviderOption,
  requiresAdditionalRuntimeProvider,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
  sortOnboardingProviders,
} from "@elizaos/shared";
/**
 * Register a provider logo at runtime. Plugins should call this during
 * initialization to add logos for their custom providers.
 *
 * @param providerId - The provider ID (e.g., "my-custom-provider")
 * @param logos - Logo paths for dark and/or light themes
 */
export declare function registerProviderLogo(
  providerId: string,
  logos: {
    logoDark?: string;
    logoLight?: string;
  },
): void;
/**
 * Get the logo path for a provider based on theme.
 *
 * @param providerId - The provider ID (e.g., "openai", "anthropic")
 * @param isDarkMode - Whether dark mode is active (default: true)
 * @param customLogo - Optional custom logo paths (from CustomProviderOption)
 * @returns The logo image path or a fallback SVG data URI
 */
export declare function getProviderLogo(
  providerId: string,
  isDarkMode?: boolean,
  customLogo?: {
    logoDark?: string;
    logoLight?: string;
  },
): string;
//# sourceMappingURL=index.d.ts.map
