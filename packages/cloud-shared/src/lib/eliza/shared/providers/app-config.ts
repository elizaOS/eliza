/**
 * App Config Provider
 *
 * Provides app-specific prompt configuration to the state composition system.
 * Injects {{appSystemPrefix}}, {{appSystemSuffix}}, and {{appResponseStyle}} template variables.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import {
  buildAppSystemContext,
  getPresetFromEnv,
  mergePromptConfig,
  type PromptConfig,
} from "../../prompt-presets";

/**
 * App Config Provider
 * Resolves app-specific prompt configuration from:
 * 1. Runtime settings (appPromptConfig) - highest priority
 * 2. Environment preset (APP_PROMPT_PRESET)
 * 3. Defaults
 */
export const appConfigProvider: Provider = {
  name: "APP_CONFIG",
  description: "App-specific prompt configuration for behavior customization",
  contexts: ["settings"],
  contextGate: { anyOf: ["settings"] },
  cacheStable: true,
  cacheScope: "agent",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    // Get config from runtime settings (passed from userContext)
    const runtimeConfig = runtime.character.settings?.appPromptConfig as PromptConfig | undefined;

    // Get preset from environment
    const envPreset = getPresetFromEnv();

    // Merge: env preset → runtime config (runtime overrides env)
    const mergedConfig = mergePromptConfig(runtimeConfig, envPreset);

    // Build template variables
    const { appSystemPrefix, appSystemSuffix, appResponseStyle } =
      buildAppSystemContext(mergedConfig);

    return {
      text: appSystemPrefix ? `# App Configuration\n${appSystemPrefix}` : "",
      values: {
        appSystemPrefix,
        appSystemSuffix,
        appResponseStyle,
        appFlirtiness: mergedConfig.flirtiness || "low",
        appRomanticMode: mergedConfig.romanticMode ? "true" : "false",
      },
      data: {
        promptConfig: mergedConfig,
      },
    };
  },
};
