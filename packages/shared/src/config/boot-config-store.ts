/**
 * Store-only boot config entry, safe for Bun/Node API paths.
 *
 * UI packages may augment the shape with component implementations, but the
 * shared runtime only needs a process-global config object and a few common
 * fields used by API clients and asset helpers.
 */

import type { BrandingConfig } from "./branding";

export interface BundledVrmAsset {
  title: string;
  slug: string;
}

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

export interface ResolvedCharacterAsset extends CharacterAssetEntry {
  compressedVrmPath: string;
  rawVrmPath: string;
  previewPath: string;
  backgroundPath: string;
  sourceVrmFilename: string;
}

export interface ResolvedInjectedCharacter extends InjectedCharacterEntry {
  avatarAsset: ResolvedCharacterAsset;
}

export interface ClientMiddleware {
  forceFreshOnboarding?: boolean;
  preferLocalProvider?: boolean;
  desktopPermissions?: boolean;
}

export interface AppBootConfig {
  branding: Partial<BrandingConfig>;
  assetBaseUrl?: string;
  defaultApps?: readonly string[];
  apiBase?: string;
  apiToken?: string;
  cloudApiBase?: string;
  vrmAssets?: BundledVrmAsset[];
  onboardingStyles?: unknown[];
  characterCatalog?: CharacterCatalogData;
  envAliases?: readonly (readonly [string, string])[];
  clientMiddleware?: ClientMiddleware;
  [key: string]: unknown;
}

export const DEFAULT_BOOT_CONFIG: AppBootConfig = {
  branding: {},
  cloudApiBase: "https://www.elizacloud.ai",
};

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");
const BOOT_CONFIG_WINDOW_KEY = "__ELIZAOS_APP_BOOT_CONFIG__";

interface BootConfigStore {
  current: AppBootConfig;
}

type GlobalConfigSlot = Record<PropertyKey, unknown> & {
  [K in typeof BOOT_CONFIG_WINDOW_KEY]?: AppBootConfig;
};

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

export function setBootConfig(config: AppBootConfig): void {
  const store = getBootConfigStore();
  store.current = config;
  getGlobalSlot()[BOOT_CONFIG_WINDOW_KEY] = config;
}

export function getBootConfig(): AppBootConfig {
  return getBootConfigStore().current;
}

const mirroredBrandKeys = new Set<string>();
const mirroredElizaKeys = new Set<string>();

const getProcessEnv = (): Record<string, string | undefined> | null => {
  try {
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
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
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
    injectedCharacters.map((character) => [
      character.catchphrase,
      character,
    ]),
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
