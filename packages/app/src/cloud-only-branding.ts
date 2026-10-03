/**
 * Resolves the app shell's cloud-only brand from pre-render boot inputs.
 * Packaged desktop builds seed the typed boot config before renderer modules
 * evaluate; legacy branded globals remain a compatibility fallback.
 */
import { shouldUseCloudOnlyBranding } from "@elizaos/core/config/cloud-only";
export interface AppCloudOnlyBrandingInputs {
  isDev: boolean;
  bootApiBase?: string | null;
  legacyInjectedApiBase?: string | null;
  isNativePlatform?: boolean;
  nativeRuntimeMode?: string | null;
  desktopRuntimeMode?: string | null;
}
/**
 * The native runtime mode that forces cloud-only branding before React boots.
 * Cloud-locked Android builds and App Store iOS builds baked for the Cloud
 * runtime (#16420) never offer local runtime options; an explicit remote
 * fallback backend on Android keeps following the host backend instead.
 */
export function resolveNativeCloudRuntimeMode(inputs: {
  platform: string;
  buildVariant: string | undefined;
  iosRuntimeMode: string | undefined;
  androidCloudBuild: boolean;
  androidRemoteFallbackApiBase?: string | null;
}): "cloud" | undefined {
  if (inputs.platform === "android") {
    return inputs.androidCloudBuild && !inputs.androidRemoteFallbackApiBase
      ? "cloud"
      : undefined;
  }
  if (inputs.platform === "ios") {
    return inputs.buildVariant === "store" &&
      inputs.iosRuntimeMode?.trim() === "cloud"
      ? "cloud"
      : undefined;
  }
  return undefined;
}

export function resolveAppCloudOnlyBranding(
  inputs: AppCloudOnlyBrandingInputs,
): boolean {
  const bootApiBase = inputs.bootApiBase?.trim();
  const legacyInjectedApiBase = inputs.legacyInjectedApiBase?.trim();
  return shouldUseCloudOnlyBranding({
    isDev: inputs.isDev,
    injectedApiBase: bootApiBase || legacyInjectedApiBase,
    isNativePlatform: inputs.isNativePlatform,
    nativeRuntimeMode: inputs.nativeRuntimeMode,
    desktopRuntimeMode: inputs.desktopRuntimeMode,
  });
}
