/**
 * Type stubs for `@elizaos/app-core` — keeps `tsc --noEmit` passing on a
 * fresh template scaffold while Vite resolves the published package at
 * runtime. Local source mode aliases in-repo elizaOS files when enabled.
 *
 * Signatures are intentionally broad (`unknown` payloads, broad union
 * params) — the goal is type-check parity, not perfect mirroring. Once the
 * real `@elizaos/app-core` is available the runtime types take over.
 */
import type { ComponentType, ReactNode } from "react";

// --- Components -------------------------------------------------------------

export const App: ComponentType;
export const AppProvider: ComponentType<{
  branding?: Partial<BrandingConfig>;
  children?: ReactNode;
}>;
export const CharacterEditor: ComponentType<Record<string, unknown>>;
export const DetachedShellRoot: ComponentType<{ route?: string | null }>;
export const DesktopSurfaceNavigationRuntime: ComponentType;
export const DesktopTrayRuntime: ComponentType;
export const ErrorBoundary: ComponentType<{ children?: ReactNode }>;

// --- Constants & static data -----------------------------------------------

export const DESKTOP_TRAY_MENU_ITEMS: readonly Record<string, unknown>[];

// --- Events -----------------------------------------------------------------

export const AGENT_READY_EVENT: string;
export const APP_PAUSE_EVENT: string;
export const APP_RESUME_EVENT: string;
export const COMMAND_PALETTE_EVENT: string;
export const CONNECT_EVENT: string;
export const SHARE_TARGET_EVENT: string;
export const TRAY_ACTION_EVENT: string;

export function dispatchAppEvent(name: string, detail?: unknown): void;

// --- Client / boot config --------------------------------------------------

export const client: Record<string, unknown>;

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

export interface AppDesktopConfig {
  bundleId?: string;
  urlScheme?: string;
}

export interface AppWebConfig {
  shortName?: string;
  themeColor?: string;
  backgroundColor?: string;
  shareImagePath?: string;
}

export interface AppConfig {
  appName: string;
  appId: string;
  orgName: string;
  repoName: string;
  cliName: string;
  description: string;
  cloudAppId?: string;
  branding: Partial<BrandingConfig>;
  envPrefix?: string;
  defaultCharacter?: string;
  defaultPlugins?: string[];
  defaultApps?: string[];
  desktop?: AppDesktopConfig;
  web?: AppWebConfig;
  android?: Record<string, unknown>;
  aosp?: Record<string, unknown>;
  packaging?: Record<string, unknown>;
  namespace?: string;
}

export interface CharacterCatalogData {
  assets: unknown[];
  injectedCharacters: unknown[];
}

export interface AppBootConfig {
  apiBase?: string;
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
  vrmAssets?: { slug: string; title: string }[];
  websiteBlockerSettingsCard?: unknown;
}

export function getBootConfig(): AppBootConfig;
export function setBootConfig(config: AppBootConfig): void;
export function resolveAppBranding(appConfig: AppConfig): BrandingConfig;
export function shouldUseCloudOnlyBranding(options: {
  injectedApiBase?: string;
  isDev: boolean;
  isNativePlatform: boolean;
}): boolean;

// --- Runtime / platform helpers -------------------------------------------

export function applyForceFreshOnboardingReset(): void;
export function applyLaunchConnectionFromUrl(): Promise<boolean>;
export function applyUiTheme(theme: unknown): void;
export function getElectrobunRendererRpc(): unknown;
export function initializeCapacitorBridge(): void;
export function initializeStorageBridge(): Promise<void>;
export function installDesktopPermissionsClientPatch(client: unknown): void;
export function installForceFreshOnboardingClientPatch(client: unknown): void;
export function installLocalProviderCloudPreferencePatch(client: unknown): void;
export function isDetachedWindowShell(route?: string | null): boolean;
export function isElectrobunRuntime(): boolean;
export function loadUiTheme(): unknown;
export function resolveWindowShellRoute(): string | null;
export function shouldInstallMainWindowOnboardingPatches(
  route?: string | null,
): boolean;
export function subscribeDesktopBridgeEvent(options: {
  ipcChannel: string;
  listener: (payload: unknown) => void;
  rpcMessage: string;
}): (() => void) | undefined;
export function syncDetachedShellLocation(route?: string | null): void;
