declare module "@elizaos/app-core" {
  import type { ComponentType, ReactNode } from "react";

  export const ErrorBoundary: ComponentType<{ children?: ReactNode }>;
}

declare module "@elizaos/app-core/App" {
  import type { ComponentType } from "react";

  export const App: ComponentType;
}

declare module "@elizaos/app-core/api" {
  export const client: Record<string, unknown>;
}

declare module "@elizaos/app-core/bridge" {
  export function initializeCapacitorBridge(): void;
  export function initializeStorageBridge(): Promise<void>;
  export function isElectrobunRuntime(): boolean;
  export function subscribeDesktopBridgeEvent(options: {
    ipcChannel: string;
    listener: (payload: unknown) => void;
    rpcMessage: string;
  }): (() => void) | void;
}

declare module "@elizaos/app-core/components/character/CharacterEditor" {
  import type { ComponentType } from "react";

  export const CharacterEditor: ComponentType<Record<string, unknown>>;
}

declare module "@elizaos/app-core/config" {
  export interface BrandingConfig {
    appName?: string;
    orgName?: string;
    repoName?: string;
    docsUrl?: string;
    appUrl?: string;
    bugReportUrl?: string;
    hashtag?: string;
    fileExtension?: string;
    packageScope?: string;
    cloudOnly?: boolean;
  }

  export interface CharacterCatalogData {
    assets: unknown[];
    injectedCharacters: unknown[];
  }

  export interface AppBootConfig {
    assetBaseUrl?: string;
    branding: Partial<BrandingConfig>;
    characterCatalog?: CharacterCatalogData;
    characterEditor?: unknown;
    clientMiddleware?: Record<string, unknown>;
    cloudApiBase?: string;
    companionShell?: unknown;
    envAliases?: readonly (readonly [string, string])[];
    lifeOpsBrowserSetupPanel?: unknown;
    lifeOpsPageView?: unknown;
    onboardingStyles?: unknown[];
    vrmAssets?: Array<{ slug: string; title: string }>;
    websiteBlockerSettingsCard?: unknown;
  }

  export function getBootConfig(): AppBootConfig;
  export function setBootConfig(config: AppBootConfig): void;
  export function shouldUseCloudOnlyBranding(options: {
    injectedApiBase?: string;
    isDev: boolean;
    isNativePlatform: boolean;
  }): boolean;
}

declare module "@elizaos/app-core/events" {
  export const AGENT_READY_EVENT: string;
  export const APP_PAUSE_EVENT: string;
  export const APP_RESUME_EVENT: string;
  export const COMMAND_PALETTE_EVENT: string;
  export const CONNECT_EVENT: string;
  export const SHARE_TARGET_EVENT: string;
  export const TRAY_ACTION_EVENT: string;

  export function dispatchAppEvent(name: string, detail?: unknown): void;
}

declare module "@elizaos/app-core/platform" {
  export function applyForceFreshOnboardingReset(): void;
  export function applyLaunchConnectionFromUrl(): Promise<boolean>;
  export function dispatchQueuedLifeOpsGithubCallbackFromUrl(
    url?: string,
  ): Promise<void>;
  export function installDesktopPermissionsClientPatch(
    client: unknown,
  ): void;
  export function installForceFreshOnboardingClientPatch(
    client: unknown,
  ): void;
  export function installLocalProviderCloudPreferencePatch(
    client: unknown,
  ): void;
  export function isDetachedWindowShell(route?: string | null): boolean;
  export function resolveWindowShellRoute(): string | null;
  export function shouldInstallMainWindowOnboardingPatches(
    route?: string | null,
  ): boolean;
  export function syncDetachedShellLocation(route?: string | null): void;
}

declare module "@elizaos/app-core/shell" {
  import type { ComponentType } from "react";

  export const DESKTOP_TRAY_MENU_ITEMS: readonly Array<Record<string, unknown>>;
  export const DesktopOnboardingRuntime: ComponentType;
  export const DesktopSurfaceNavigationRuntime: ComponentType;
  export const DesktopTrayRuntime: ComponentType;
  export const DetachedShellRoot: ComponentType<{ route?: string | null }>;
}

declare module "@elizaos/app-core/state" {
  import type { ComponentType, ReactNode } from "react";

  export const AppProvider: ComponentType<{
    branding?: Record<string, unknown>;
    children?: ReactNode;
  }>;

  export function applyUiTheme(theme: unknown): void;
  export function loadUiTheme(): unknown;
}

declare module "@elizaos/app-core/platform/native-plugin-entrypoints" {}

declare module "@elizaos/shared/onboarding-presets" {
  export function buildElizaCharacterCatalog(): {
    assets: unknown[];
    injectedCharacters: unknown[];
  };

  export function getStylePresets(): Array<{
    avatarIndex: number;
    name: string;
  }>;
}
