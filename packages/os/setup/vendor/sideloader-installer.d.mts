export interface SideloaderTarget {
  archive: string;
  asset: string;
  binary: string;
  sha256: string;
  size: number;
}

export interface SideloaderConfig {
  pinned: {
    version: string | null;
    targets: Record<string, SideloaderTarget | undefined>;
  };
}

export interface InstallPinnedSideloaderOptions {
  vendorRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  config: SideloaderConfig;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  log?: (message: string) => void;
}

export function resolvePinnedSideloaderTarget(
  config: SideloaderConfig,
  platform: NodeJS.Platform,
  arch: string,
): SideloaderTarget & { key: string; version: string };

export function installPinnedSideloader(
  options: InstallPinnedSideloaderOptions,
): Promise<string>;
