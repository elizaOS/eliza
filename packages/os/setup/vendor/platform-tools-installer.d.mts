export interface PlatformToolsTarget {
  url: string;
  sha256: string | null;
  size?: number | null;
}
export function resolvePlatformTools(
  config: Record<string, PlatformToolsTarget>,
  platform: NodeJS.Platform,
): PlatformToolsTarget;
export function installPinnedPlatformTools(options: {
  vendorRoot: string;
  platform: NodeJS.Platform;
  config: Record<string, PlatformToolsTarget>;
  fetchImpl?: typeof fetch;
}): Promise<string>;
