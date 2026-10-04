/**
 * Builds the static (no-network) FirstRunOptions payload from the shared
 * provider catalog and style presets, used as the onboarding fallback before
 * the server-driven options arrive.
 */

import {
  getStylePresets,
  FIRST_RUN_PROVIDER_CATALOG,
} from "@elizaos/host/protocol";
import type { FirstRunOptions } from "@elizaos/host/protocol";
import type { UiLanguage } from "@elizaos/core/protocol";

export function buildStaticFirstRunOptions(
  uiLanguage: UiLanguage,
): FirstRunOptions {
  return {
    names: [],
    styles: getStylePresets(uiLanguage),
    providers: [...FIRST_RUN_PROVIDER_CATALOG] as FirstRunOptions["providers"],
    cloudProviders: [],
    models: {
      nano: [],
      small: [],
      medium: [],
      large: [],
      mega: [],
    } as FirstRunOptions["models"],
    inventoryProviders: [],
    sharedStyleRules: "",
  };
}
