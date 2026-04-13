/**
 * AppBootConfig — typed runtime configuration that replaces window.__* globals.
 *
 * The hosting app (e.g. apps/app) creates an AppBootConfig and passes it via
 * <AppBootProvider>. All app-core code reads from this config instead of
 * reaching for window globals.
 */
import { createContext, useContext } from "react";
import type { Tab } from "../navigation";
import type { ActionNotice } from "../state";
import type { WebsiteBlockerSettingsCardProps } from "../types";
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

export interface AppBootConfig {
  /** Branding overrides (product name, URLs, etc.). */
  branding: Partial<BrandingConfig>;
  /** Static asset base URL for CDN-backed runtime assets. */
  assetBaseUrl?: string;
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
  characterEditor?: React.ComponentType<Record<string, unknown>>;
  /** Companion shell implementation provided by the host app. */
  companionShell?: React.ComponentType<CompanionShellComponentProps>;
  /** LifeOps page implementation provided by the host app. */
  lifeOpsPageView?: React.ComponentType<Record<string, never>>;
  /** LifeOps browser setup panel provided by the host app. */
  lifeOpsBrowserSetupPanel?: React.ComponentType<Record<string, never>>;
  /** Website blocker settings card provided by the host app. */
  websiteBlockerSettingsCard?: React.ComponentType<WebsiteBlockerSettingsCardProps>;
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

function getBootConfigStore(): BootConfigStore {
  const globalObject = (
    typeof window !== "undefined"
      ? (window as unknown as Record<PropertyKey, unknown>)
      : (globalThis as Record<PropertyKey, unknown>)
  ) as Record<PropertyKey, unknown> & {
    [BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
  };
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
  const globalObject = (
    typeof window !== "undefined"
      ? (window as unknown as Record<PropertyKey, unknown>)
      : (globalThis as Record<PropertyKey, unknown>)
  ) as Record<PropertyKey, unknown> & {
    [BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
  };
  globalObject[BOOT_CONFIG_WINDOW_KEY] = config;
}

/** Read the boot config from non-React code. */
export function getBootConfig(): AppBootConfig {
  return getBootConfigStore().current;
}

// ---------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------

export const AppBootContext = createContext<AppBootConfig>(DEFAULT_BOOT_CONFIG);

/** Read the boot config from a React component. */
export function useBootConfig(): AppBootConfig {
  return useContext(AppBootContext);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
