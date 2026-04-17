export interface RegistryAppViewerMeta {
  url: string;
  embedParams?: Record<string, string>;
  postMessageAuth?: boolean;
  sandbox?: string;
}

export type RegistryAppSessionMode =
  | "viewer"
  | "spectate-and-steer"
  | "external";

export type RegistryAppSessionFeature =
  | "commands"
  | "telemetry"
  | "pause"
  | "resume"
  | "suggestions";

export interface RegistryAppSessionMeta {
  mode: RegistryAppSessionMode;
  features?: RegistryAppSessionFeature[];
}

export interface AppUiExtensionConfig {
  detailPanelId: string;
}

export interface RegistryAppMeta {
  displayName: string;
  category: string;
  launchType: string;
  launchUrl: string | null;
  icon: string | null;
  /**
   * URL or package-relative path to a full-card hero image. Apps declare
   * this in `package.json` → `elizaos.app.heroImage` as a relative path
   * (e.g. `"assets/hero.webp"`); the runtime resolves it to a served
   * URL before surfacing the field on `RegistryAppInfo`.
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
}

export interface RegistryPluginInfo {
  name: string;
  gitRepo: string;
  gitUrl: string;
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
  appMeta?: RegistryAppMeta;
}

export type { RegistryAppInfo } from "@elizaos/shared/contracts/apps";

export interface RegistrySearchResult {
  name: string;
  description: string;
  score: number;
  tags: string[];
  latestVersion: string | null;
  stars: number;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  repository: string;
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
}
