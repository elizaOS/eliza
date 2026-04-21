export function shouldUseCloudOnlyBranding(options: {
  isDev: boolean;
  injectedApiBase?: string | null;
  isNativePlatform?: boolean;
}): boolean {
  if (options.isDev) return false;

  // Mobile (iOS/Android) is always cloud-only — no local runtime available.
  // Users must connect to ElizaCloud or a remote instance.
  if (options.isNativePlatform) return true;

  // Desktop shells inject an explicit backend before React boots. When that
  // happens, the renderer should follow the host backend's capabilities rather
  // than hard-coding the production web cloud-only preset.
  const injectedApiBase = options.injectedApiBase?.trim();
  if (injectedApiBase) return false;

  return true;
}
