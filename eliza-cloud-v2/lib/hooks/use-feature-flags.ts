"use client";

import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  getEnabledFeatures,
  getDisabledFeatures,
  isRouteEnabled,
  getFeatureForRoute,
  type FeatureFlag,
  type FeatureFlagConfig,
} from "@/lib/config/feature-flags";

export interface UseFeatureFlagsReturn {
  flags: Record<FeatureFlag, FeatureFlagConfig>;
  isEnabled: (flag: FeatureFlag) => boolean;
  isRouteEnabled: (pathname: string) => boolean;
  getFeatureForRoute: (pathname: string) => FeatureFlag | null;
  enabledFeatures: FeatureFlag[];
  disabledFeatures: FeatureFlag[];
}

export function useFeatureFlags(): UseFeatureFlagsReturn {
  return {
    flags: FEATURE_FLAGS,
    isEnabled: isFeatureEnabled,
    isRouteEnabled,
    getFeatureForRoute,
    enabledFeatures: getEnabledFeatures(),
    disabledFeatures: getDisabledFeatures(),
  };
}

export function useFeatureFlag(flag: FeatureFlag): boolean {
  return isFeatureEnabled(flag);
}
