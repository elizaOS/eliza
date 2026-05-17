import type {
  AppSessionConfig,
  AppSessionFeature,
  AppSessionMode,
  AppUiExtensionConfig,
  AppViewerConfig,
  RegistryAppInfo,
} from "@elizaos/shared";

export type RegistryAppViewerMeta = Omit<AppViewerConfig, "authMessage">;
export type RegistryAppSessionMode = AppSessionMode;
export type RegistryAppSessionFeature = AppSessionFeature;
export type RegistryAppSessionMeta = AppSessionConfig;
export type { AppUiExtensionConfig, RegistryAppInfo };

export interface RegistryAppMeta {
  displayName: string;
  category: string;
  launchType: string;
  launchUrl: string | null;
  icon: string | null;
  /**
   * URL or package-relative path to a full-card hero image. Apps declare
   * this in `package.json` → `elizaos.app.heroImage` as a relative path
   * (e.g. `"assets/hero.png"`); the runtime resolves it to a served
   * URL before surfacing the field on `RegistryAppInfo`, and falls back
   * to generated `/api/apps/hero/<slug>` artwork when an app ships none.
   */
  heroImage: string | null;
  capabilities: string[];
  minPlayers: number | null;
  maxPlayers: number | null;
  runtimePlugin?: string;
  bridgeExport?: string;
  uiExtension?: AppUiExtensionConfig;
  viewer?: RegistryAppViewerMeta;
  session?: RegistryAppSessionMeta;
  /**
   * If true, the app is a developer-tooling surface (logs, trajectory
   * viewer, etc.) and is hidden from the main UI unless Developer Mode is
   * enabled in Settings. The server exposes the flag here; the client
   * gates the render.
   */
  developerOnly?: boolean;
  /**
   * Controls whether the app appears in the user-facing app store/catalog.
   * Defaults to true. Set to false for apps that auto-install or are
   * surfaced only via direct deep-links. The server exposes the flag;
   * the client gates the render.
   */
  visibleInAppStore?: boolean;
  /**
   * If true, the app declares itself as the default landing tab for the
   * shell. Set via `package.json` → `elizaos.app.mainTab`. Exactly one
   * installed app should declare this; if multiple do, the shell picks
   * the first one deterministically and logs a warning. Consumed by
   * `getMainTabApp()` in `@elizaos/app-core` at boot.
   */
  mainTab?: boolean;
}

export interface RegistryPluginInfo {
  name: string;
  gitRepo: string;
  gitUrl: string;
  directory?: string | null;
  description: string;
  homepage: string | null;
  topics: string[];
  stars: number;
  language: string;
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
  git: {
    v0Branch: string | null;
    v1Branch: string | null;
    v2Branch: string | null;
  };
  supports: { v0: boolean; v1: boolean; v2: boolean };
  localPath?: string;
  kind?: string;
  registryKind?: string;
  origin?: "builtin" | "third-party" | string;
  source?: string;
  support?: "first-party" | "community" | string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
  appMeta?: RegistryAppMeta;
}

export interface RegistrySearchResult {
  name: string;
  description: string;
  score: number;
  tags: string[];
  latestVersion: string | null;
  stars: number;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  repository: string;
  origin?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
}

export interface RegistryPluginListItem {
  name: string;
  description: string;
  stars: number;
  repository: string;
  topics: string[];
  latestVersion: string | null;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
  origin?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
}
