/**
 * Lazy loaders for the Android app plugins (wifi, contacts, phone). Registering
 * them only fills a map, so every Android boot can do it. The plugins are
 * evaluated when the collector first asks for one, which can happen after
 * config sets ELIZA_LOCAL_LLAMA.
 */
import { isAndroidMobile } from "@elizaos/host/protocol";
import {
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types.ts";

export const ANDROID_PHONE_PLUGIN_NAME = "@elizaos/plugin-native-phone";

export const ANDROID_APP_PLUGIN_NAMES = [
  "@elizaos/plugin-native-wifi",
  "@elizaos/plugin-native-contacts",
  ANDROID_PHONE_PLUGIN_NAME,
] as const;

/** Trusted Android hosts can opt into only the SMS drafting route, independent of local inference. */
export function androidSmsReplyDraftEnabled(): boolean {
  return isAndroidMobile() && process.env.ELIZA_MOBILE_SMS_REPLY_DRAFT === "1";
}

export function registerAndroidAppPluginLoaders(): void {
  for (const name of ANDROID_APP_PLUGIN_NAMES)
    STATIC_ELIZA_PLUGIN_LOADERS[name] ??= async () => {
      await import("./android-app-plugins.ts");
      return STATIC_ELIZA_PLUGINS[name];
    };
}
