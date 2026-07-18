/**
 * Resolves Cloud-only product policy from the host platform and build-stamped
 * runtime mode without changing web, desktop, or explicit compatibility builds.
 */

import { shouldUseCloudOnlyBranding } from "@elizaos/ui/config";
import { resolveAndroidRuntimeMode } from "@elizaos/ui/platform/android-runtime";
import { resolveIosRuntimeConfig } from "./ios-runtime";

type RuntimeEnv = Record<string, string | boolean | undefined>;

export function resolveAppCloudOnlyBranding(options: {
  desktopRuntimeMode?: string | null;
  env: RuntimeEnv;
  injectedApiBase?: string | null;
  isDev: boolean;
  isNativePlatform: boolean;
  platform: string;
}): boolean {
  const nativeRuntimeMode = options.isNativePlatform
    ? options.platform === "ios"
      ? resolveIosRuntimeConfig(options.env).mode
      : options.platform === "android"
        ? resolveAndroidRuntimeMode(options.env)
        : undefined
    : undefined;

  return shouldUseCloudOnlyBranding({
    desktopRuntimeMode: options.desktopRuntimeMode,
    injectedApiBase: options.injectedApiBase,
    isDev: options.isDev,
    isNativePlatform: options.isNativePlatform,
    nativeRuntimeMode,
  });
}
