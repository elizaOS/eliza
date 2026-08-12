/**
 * Store-only boot config entry, safe for Bun/Node API paths.
 *
 * UI packages may augment the shape with component implementations, but the
 * shared runtime only needs a process-global config object and a few common
 * fields used by API clients and asset helpers.
 */

import type { BrandingConfig } from "./branding.js";

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
  forceFreshFirstRun?: boolean;
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
  firstRunStyles?: unknown[];
  /**
   * Default-on shared cloud tier; false is the dedicated-direct kill-switch.
   * When true, onboarding lands on a shared agent with zero billable dedicated
   * mutation until the user explicitly chooses an upgrade (#18204).
   */
  preferSharedCloudTier?: boolean;
  /**
   * Explicit opt-in to automatically upgrade a shared-first onboarding agent
   * to a billed dedicated container in the background. Default OFF (#18204) so
   * the shared-first path stays shared-only. Set true only when the host
   * accepts the automatic credit burn from the #15518 handoff design.
   */
  autoUpgradeSharedToDedicated?: boolean;
  characterCatalog?: CharacterCatalogData;
  envAliases?: readonly (readonly [string, string])[];
  clientMiddleware?: ClientMiddleware;
  [key: string]: unknown;
}

export const DEFAULT_BOOT_CONFIG: AppBootConfig = {
  branding: {},
  cloudApiBase: "https://api.eliza.app",
  preferSharedCloudTier: true,
  // Default OFF: shared-first onboarding stays shared-only; no billed dedicated
  // mutation without explicit opt-in (#18204).
  autoUpgradeSharedToDedicated: false,
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

  // An established store always wins. The window-key mirror is only a pre-boot
  // seed and must never replace a store that already exists — see the matching
  // note in `@elizaos/core`'s boot-env.ts. All three copies (core, shared, ui)
  // share the same global slot, so they must agree on write-once semantics.
  const existing = globalObject[BOOT_CONFIG_STORE_KEY];
  if (
    existing &&
    typeof existing === "object" &&
    "current" in (existing as Record<string, unknown>)
  ) {
    return existing as BootConfigStore;
  }

  // No store yet: seed it once from a cross-bundle window mirror if a bootstrap
  // set it, otherwise from defaults.
  const mirroredWindowConfig = globalObject[BOOT_CONFIG_WINDOW_KEY];
  const store: BootConfigStore = {
    current: mirroredWindowConfig ?? DEFAULT_BOOT_CONFIG,
  };
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
    injectedCharacters.map((character) => [character.catchphrase, character]),
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

function presentEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

function buildAliasPartnerMap(
  aliases: readonly (readonly [string, string])[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    const existing = map.get(from);
    if (existing) {
      if (!existing.includes(to)) existing.push(to);
    } else {
      map.set(from, [to]);
    }
  };
  for (const [brandKey, elizaKey] of aliases) {
    link(brandKey, elizaKey);
    link(elizaKey, brandKey);
  }
  return map;
}

function getProcessEnv(): Record<string, string | undefined> | null {
  try {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process;
    return p?.env ?? null;
  } catch {
    return null;
  }
}

/**
 * Additive, non-mutating brand↔ELIZA env-alias reader (#18056 local copy).
 * Mirrors `@elizaos/core` `resolveAliasedEnvValue` without importing bare core
 * (which Vite maps to the prebuilt browser blob).
 */
export function resolveAliasedEnvValue(
  key: string,
  aliases: readonly (readonly [string, string])[] | undefined = getBootConfig()
    .envAliases,
  env: Record<string, string | undefined> | null = getProcessEnv(),
): string | undefined {
  if (!env) return undefined;

  const direct = presentEnvValue(env[key]);
  if (direct !== undefined) return direct;

  if (!aliases || aliases.length === 0) return undefined;

  const partners = buildAliasPartnerMap(aliases).get(key);
  if (!partners) return undefined;

  for (const partner of partners) {
    const value = presentEnvValue(env[partner]);
    if (value !== undefined) return value;
  }
  return undefined;
}
