/**
 * Lazy loaders for the Android app plugins (wifi, contacts, phone). Registering
 * them only fills a map, so every Android boot can do it. The plugins are
 * evaluated when the collector first asks for one, which can happen after
 * config sets ELIZA_LOCAL_LLAMA.
 */
import {
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types.ts";

export const ANDROID_APP_PLUGIN_NAMES = [
  "@elizaos/plugin-native-wifi",
  "@elizaos/plugin-native-contacts",
  "@elizaos/plugin-native-phone",
] as const;

export function registerAndroidAppPluginLoaders(): void {
  for (const name of ANDROID_APP_PLUGIN_NAMES)
    STATIC_ELIZA_PLUGIN_LOADERS[name] ??= async () => {
      await import("./android-app-plugins.ts");
      return STATIC_ELIZA_PLUGINS[name];
    };
}
