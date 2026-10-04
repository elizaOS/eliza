/**
 * Builds the static (no-network) FirstRunOptions payload from the shared
 * provider catalog and style presets, used as the onboarding fallback before
 * the server-driven options arrive.
 */

import { getStylePresets } from "@elizaos/core/character-presets";
import {
  FIRST_RUN_PROVIDER_CATALOG,
  type FirstRunOptions,
} from "@elizaos/core/contracts/first-run-options";

import type { UiLanguage } from "@elizaos/core/i18n/language";
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
