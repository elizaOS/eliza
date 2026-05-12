/**
 * AppBootConfig — typed runtime configuration that replaces window.__* globals.
 *
 * The hosting app (e.g. apps/app) creates an AppBootConfig and passes it via
 * <AppBootProvider>. All app-core code reads from this config instead of
 * reaching for window globals.
 *
 * React context lives in `boot-config-react.tsx` so Bun/Node can import this
 * module without loading `react` runtime (avoids Bun parsing @types/react).
 */

import type {
  AppBlockerSettingsCardProps,
  StewardPolicyResult,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type { ComponentType, ReactNode } from "react";
import type { CodingAgentSession } from "../api/client-types-cloud";
import type { Tab } from "../navigation";
import type { ActionNotice } from "../state/action-notice";
import type { BrandingConfig } from "./branding";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A bundled VRM avatar asset descriptor. */
export interface BundledVrmAsset {
  title: string;
  slug: string;
}

/** Lightweight character catalog data passed from the host app. */
export interface CharacterCatalogData {
  assets: CharacterAssetEntry[];
  injectedCharacters: InjectedCharacterEntry[];
}

export interface CharacterAssetEntry {
  id: number;
  slug: string;
  title: string;
  sourceName: string;
}

export interface InjectedCharacterEntry {
  catchphrase: string;
  name: string;
  avatarAssetId: number;
  voicePresetId?: string;
}

/** Resolved character asset with computed paths. */
export interface ResolvedCharacterAsset extends CharacterAssetEntry {
  compressedVrmPath: string;
  rawVrmPath: string;
  previewPath: string;
  backgroundPath: string;
  sourceVrmFilename: string;
}

/** Resolved injected character with its avatar asset. */
export interface ResolvedInjectedCharacter extends InjectedCharacterEntry {
  avatarAsset: ResolvedCharacterAsset;
}

/** Client middleware flags — replaces the 4 monkey-patches. */
export interface ClientMiddleware {
  /** Force fresh onboarding (e.g. on ?reset). */
  forceFreshOnboarding?: boolean;
  /** Mask cloud status when a local provider is active. */
  preferLocalProvider?: boolean;
  /** Bridge permissions to native desktop layer. */
  desktopPermissions?: boolean;
}

export interface CompanionShellComponentProps {
  tab: Tab;
  actionNotice: ActionNotice | null;
}

export type CompanionInferenceNotice =
  | { kind: "cloud"; variant: "danger" | "warn"; tooltip: string }
  | { kind: "settings"; variant: "warn"; tooltip: string };

export interface ResolveCompanionInferenceNoticeArgs {
  elizaCloudConnected: boolean;
  elizaCloudAuthRejected: boolean;
  elizaCloudCreditsError: string | null | undefined;
  elizaCloudEnabled: boolean;
  chatLastUsageModel?: string;
  hasInterruptedAssistant: boolean;
  t: (key: string) => string;
}

export interface CompanionSceneStatus {
  avatarReady: boolean;
  teleportKey: string;
}

export interface CompanionVectorBrowserRuntime {
  THREE: unknown;
  createVectorBrowserRenderer: () => Promise<unknown>;
}

export interface CodingAgentTasksPanelProps {
  fullPage?: boolean;
}

export interface PtyConsoleDrawerProps {
  activeSessionId: string | null;
  sessions: CodingAgentSession[];
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}

export interface FineTuningViewProps {
  contentHeader?: ReactNode;
}

export interface VincentStateHookArgs {
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface VincentStateHookResult {
  vincentConnected: boolean;
  vincentLoginBusy: boolean;
  vincentLoginError: string | null;
  vincentConnectedAt: number | null;
  handleVincentLogin: () => Promise<void>;
  handleVincentDisconnect: () => Promise<void>;
  pollVincentStatus: () => Promise<boolean>;
}

export interface StewardLogoProps {
  size?: number;
  className?: string;
}

export type AppBootStewardTxStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "signed"
  | "broadcast"
  | "confirmed"
  | "failed";

export interface AppBootStewardTxRecord {
  id: string;
  agentId: string;
  status: AppBootStewardTxStatus;
  request: {
    agentId: string;
    tenantId: string;
    to: string;
    value: string;
    data?: string;
    chainId: number;
  };
  txHash?: string;
  policyResults: StewardPolicyResult[];
  createdAt: string;
  signedAt?: string;
  confirmedAt?: string;
}

export interface AppBootStewardPendingApproval {
  queueId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  transaction: AppBootStewardTxRecord;
}

export interface AppBootStewardApprovalActionResponse {
  ok: boolean;
  txHash?: string;
  error?: string;
}

export interface StewardApprovalQueueProps {
  embedded?: boolean;
  refreshKey?: number | string;
  getStewardPending: () => Promise<AppBootStewardPendingApproval[]>;
  approveStewardTx: (
    txId: string,
  ) => Promise<AppBootStewardApprovalActionResponse>;
  rejectStewardTx: (
    txId: string,
    reason?: string,
  ) => Promise<AppBootStewardApprovalActionResponse>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  onPendingCountChange?: (count: number) => void;
}

export interface StewardTransactionHistoryProps {
  embedded?: boolean;
  getStewardHistory: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    records: AppBootStewardTxRecord[];
    total: number;
    offset: number;
    limit: number;
  }>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

export interface AppBootConfig {
  /** Branding overrides (product name, URLs, etc.). */
  branding: Partial<BrandingConfig>;
  /** Static asset base URL for CDN-backed runtime assets. */
  assetBaseUrl?: string;
  /** Apps starred and pinned by default when no user preference is saved. */
  defaultApps?: readonly string[];
  /** API base URL — replaces window.__ELIZAOS_API_BASE__. */
  apiBase?: string;
  /** API auth token — replaces window.__ELIZAOS_API_TOKEN__. */
  apiToken?: string;
  /** Cloud API base URL — replaces window.__ELIZA_CLOUD_API_BASE__. */
  cloudApiBase?: string;
  /** VRM avatar assets — replaces window.__APP_VRM_ASSETS__. */
  vrmAssets?: BundledVrmAsset[];
  /** Onboarding style presets — replaces window.__APP_ONBOARDING_STYLES__. */
  onboardingStyles?: unknown[];
  /** Character editor component — replaces window.__ELIZAOS_CHARACTER_EDITOR__. */
  characterEditor?: ComponentType<Record<string, unknown>>;
  /** Companion shell implementation provided by the host app. */
  companionShell?: ComponentType<CompanionShellComponentProps>;
  /** Companion cloud/settings warning resolver provided by the host app. */
  resolveCompanionInferenceNotice?: (
    args: ResolveCompanionInferenceNoticeArgs,
  ) => CompanionInferenceNotice | null;
  /** Companion warning button implementation provided by the host app. */
  companionInferenceAlertButton?: ComponentType<{
    notice: CompanionInferenceNotice;
    onClick: () => void;
    onPointerDown?: (...args: unknown[]) => unknown;
  }>;
  /** Companion global overlay implementation provided by the host app. */
  companionGlobalOverlay?: ComponentType<Record<string, never>>;
  /** Companion scene state hook provided by the host app. */
  useCompanionSceneStatus?: () => CompanionSceneStatus;
  /** Optional vector browser runtime owned by the host app. */
  companionVectorBrowser?: CompanionVectorBrowserRuntime;
  /** Coding-agent tasks panel provided by the host app. */
  codingAgentTasksPanel?: ComponentType<CodingAgentTasksPanelProps>;
  /** Coding-agent settings panel provided by the host app. */
  codingAgentSettingsSection?: ComponentType<Record<string, never>>;
  /** Coding-agent chat control chip provided by the host app. */
  codingAgentControlChip?: ComponentType<Record<string, never>>;
  /** Coding-agent PTY drawer provided by the host app. */
  ptyConsoleDrawer?: ComponentType<PtyConsoleDrawerProps>;
  /** Fine-tuning view provided by the host app. */
  fineTuningView?: ComponentType<FineTuningViewProps>;
  /** Vincent UI state hook provided by the host app. */
  useVincentState?: (args: VincentStateHookArgs) => VincentStateHookResult;
  /** LifeOps page implementation provided by the host app. */
  lifeOpsPageView?: ComponentType<Record<string, never>>;
  /** LifeOps browser setup panel provided by the host app. */
  lifeOpsBrowserSetupPanel?: ComponentType<Record<string, never>>;
  /** App blocker settings card provided by the host app. */
  appBlockerSettingsCard?: ComponentType<AppBlockerSettingsCardProps>;
  /** Website blocker settings card provided by the host app. */
  websiteBlockerSettingsCard?: ComponentType<WebsiteBlockerSettingsCardProps>;
  /** Steward brand mark provided by the host app. */
  stewardLogo?: ComponentType<StewardLogoProps>;
  /** Steward approval queue provided by the host app. */
  stewardApprovalQueue?: ComponentType<StewardApprovalQueueProps>;
  /** Steward transaction history provided by the host app. */
  stewardTransactionHistory?: ComponentType<StewardTransactionHistoryProps>;
  /** Character catalog data — replaces cross-package import of catalog.json. */
  characterCatalog?: CharacterCatalogData;
  /**
   * Env var alias pairs for brand compatibility (e.g. ELIZA_* ↔ ELIZA_*).
   * Each pair is [brandKey, elizaKey]. Called at server startup.
   */
  envAliases?: readonly (readonly [string, string])[];
  /** Client middleware flags — replaces the post-construction patches. */
  clientMiddleware?: ClientMiddleware;
}

// ---------------------------------------------------------------------------
// Defaults (brand-agnostic — no product-specific references)
// ---------------------------------------------------------------------------

export const DEFAULT_BOOT_CONFIG: AppBootConfig = {
  branding: {},
  cloudApiBase: "https://www.elizacloud.ai",
};

// ---------------------------------------------------------------------------
// Process-global config ref (for non-React code like client.ts, asset-url.ts)
// Use a Symbol-backed slot on globalThis so duplicated module instances
// still read/write the same live boot config.
// ---------------------------------------------------------------------------

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

interface BootConfigStore {
  current: AppBootConfig;
}

type GlobalConfigSlot = Record<PropertyKey, unknown> & {
  [K in typeof BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
};

/** Resolve the global object (browser or Node) with symbol-key access. */
function getGlobalSlot(): GlobalConfigSlot {
  return globalThis as GlobalConfigSlot;
}

function getBootConfigStore(): BootConfigStore {
  const globalObject = getGlobalSlot();
  const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
  if (mirroredWindowConfig) {
    const mirroredStore: BootConfigStore = { current: mirroredWindowConfig };
    globalObject[BOOT_CONFIG_STORE_KEY] = mirroredStore;
    return mirroredStore;
  }
  const existing = globalObject[BOOT_CONFIG_STORE_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "current" in (existing as Record<string, unknown>)
  ) {
    return existing as BootConfigStore;
  }

  const store: BootConfigStore = { current: DEFAULT_BOOT_CONFIG };
  globalObject[BOOT_CONFIG_STORE_KEY] = store;
  globalObject[BOOT_CONFIG_WINDOW_KEY] = store.current;
  return store;
}

/** Set the boot config. Called by AppBootProvider on mount. */
export function setBootConfig(config: AppBootConfig): void {
  const store = getBootConfigStore();
  store.current = config;
  getGlobalSlot()[BOOT_CONFIG_WINDOW_KEY] = config;
}

/** Read the boot config from non-React code. */
export function getBootConfig(): AppBootConfig {
  return getBootConfigStore().current;
}

// ---------------------------------------------------------------------------
// Character catalog helpers
// ---------------------------------------------------------------------------

function resolveAssets(
  catalog: CharacterCatalogData,
): ResolvedCharacterAsset[] {
  return catalog.assets.map((asset) => ({
    ...asset,
    compressedVrmPath: `vrms/${asset.slug}.vrm.gz`,
    rawVrmPath: `vrms/${asset.slug}.vrm`,
    previewPath: `vrms/previews/${asset.slug}.png`,
    backgroundPath: `vrms/backgrounds/${asset.slug}.png`,
    sourceVrmFilename: `${asset.sourceName}.vrm`,
  }));
}

/** Resolve a character catalog into ready-to-use assets and characters. */
export function resolveCharacterCatalog(catalog: CharacterCatalogData): {
  assets: ResolvedCharacterAsset[];
  assetCount: number;
  defaultAsset: ResolvedCharacterAsset | null;
  injectedCharacters: ResolvedInjectedCharacter[];
  injectedCharacterCount: number;
  getAsset: (id: number) => ResolvedCharacterAsset | null;
  getInjectedCharacter: (
    catchphrase: string,
  ) => ResolvedInjectedCharacter | null;
} {
  const assets = resolveAssets(catalog);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const defaultAsset = assets[0] ?? null;

  const injectedCharacters = catalog.injectedCharacters.map((character) => {
    const avatarAsset = assetById.get(character.avatarAssetId) ?? defaultAsset;
    if (!avatarAsset) {
      throw new Error(
        `Missing avatar asset ${character.avatarAssetId} for ${character.name}.`,
      );
    }
    return { ...character, avatarAsset };
  });

  const byCatchphrase = new Map(
    injectedCharacters.map((c) => [c.catchphrase, c]),
  );

  return {
    assets,
    assetCount: assets.length,
    defaultAsset,
    injectedCharacters,
    injectedCharacterCount: injectedCharacters.length,
    getAsset: (id: number) => assetById.get(id) ?? defaultAsset,
    getInjectedCharacter: (catchphrase: string) =>
      byCatchphrase.get(catchphrase) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Env var aliasing helpers (brand-agnostic version of brand-env.ts)
// Server-side only — these are no-ops in browser environments.
// ---------------------------------------------------------------------------

const mirroredBrandKeys = new Set<string>();
const mirroredElizaKeys = new Set<string>();

const getProcessEnv = (): Record<string, string | undefined> | null => {
  try {
    // In Node/Bun, process.env is available. In browsers it isn't.
    const p = (globalThis as Record<string, unknown>).process as
      | { env?: Record<string, string | undefined> }
      | undefined;
    return p?.env ?? null;
  } catch {
    return null;
  }
};

/** Sync brand env vars → Eliza equivalents. Server-side only. */
export function syncBrandEnvToEliza(
  aliases: readonly (readonly [string, string])[],
): void {
  const env = getProcessEnv();
  if (!env) return;
  for (const [brandKey, elizaKey] of aliases) {
    const value = env[brandKey];
    if (typeof value === "string") {
      env[elizaKey] = value;
      mirroredElizaKeys.add(elizaKey);
    } else if (mirroredElizaKeys.has(elizaKey)) {
      delete env[elizaKey];
      mirroredElizaKeys.delete(elizaKey);
    }
  }
}

/** Sync Eliza env vars → brand equivalents. Server-side only. */
export function syncElizaEnvToBrand(
  aliases: readonly (readonly [string, string])[],
): void {
  const env = getProcessEnv();
  if (!env) return;
  for (const [brandKey, elizaKey] of aliases) {
    const value = env[elizaKey];
    if (typeof value === "string") {
      env[brandKey] = value;
      mirroredBrandKeys.add(brandKey);
    } else if (mirroredBrandKeys.has(brandKey)) {
      delete env[brandKey];
      mirroredBrandKeys.delete(brandKey);
    }
  }
}
