export function shouldUseCloudOnlyBranding(options: {
  isDev: boolean;
  injectedApiBase?: string | null;
  isNativePlatform?: boolean;
  nativeRuntimeMode?: string | null;
  desktopRuntimeMode?: string | null;
}): boolean {
  // An explicit desktop "cloud" runtime mode forces cloud-only regardless of
  // dev mode or an injected loopback backend. The desktop shell deliberately
  // runs cloud-only and keeps the loopback agent solely as the cloud-login
  // proxy, so this opt-in must win over the isDev / injectedApiBase fall-throughs
  // below (both of which are true on a desktop dev build).
  const desktopRuntimeMode = options.desktopRuntimeMode?.trim().toLowerCase();
  if (desktopRuntimeMode === "cloud" || desktopRuntimeMode === "elizacloud") {
    return true;
  }

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
