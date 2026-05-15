export function shouldUseCloudOnlyBranding(options: {
  isDev: boolean;
  injectedApiBase?: string | null;
  isNativePlatform?: boolean;
  nativeRuntimeMode?: string | null;
}): boolean {
  if (options.isDev) return false;

  // Desktop shells and hybrid/native builds inject or select a backend before
  // React boots. When that happens, the renderer should follow the host
  // backend's capabilities rather than hard-coding the production web
  // cloud-only preset.
  const injectedApiBase = options.injectedApiBase?.trim();
  if (injectedApiBase) return false;

  if (options.isNativePlatform) {
    const nativeRuntimeMode = options.nativeRuntimeMode?.trim().toLowerCase();
    return nativeRuntimeMode === "cloud" || nativeRuntimeMode === "elizacloud";
  }

  return true;
}
