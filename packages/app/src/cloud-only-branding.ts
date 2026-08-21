/**
 * Resolves the app shell's cloud-only brand from pre-render boot inputs.
 * Packaged desktop builds seed the typed boot config before renderer modules
 * evaluate; legacy branded globals remain a compatibility fallback.
 */
import { shouldUseCloudOnlyBranding } from "@elizaos/shared";

export interface AppCloudOnlyBrandingInputs {
  isDev: boolean;
  bootApiBase?: string | null;
  legacyInjectedApiBase?: string | null;
  isNativePlatform?: boolean;
  nativeRuntimeMode?: string | null;
  desktopRuntimeMode?: string | null;
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
