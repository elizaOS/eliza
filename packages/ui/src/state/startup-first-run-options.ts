/**
 * Builds the static (no-network) FirstRunOptions payload from the shared
 * provider catalog and style presets, used as the onboarding fallback before
 * the server-driven options arrive.
 */

import { getStylePresets } from "@elizaos/shared/character-presets";
import { FIRST_RUN_PROVIDER_CATALOG } from "@elizaos/shared/contracts/first-run-options";
import type { FirstRunOptions } from "../api";
import type { UiLanguage } from "../i18n";

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
