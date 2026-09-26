/**
 * Store-only boot config entry, safe for Bun/Node API paths.
 *
 * UI packages may augment the shape with component implementations, but the
 * shared runtime only needs a process-global config object and a few common
 * fields used by API clients and asset helpers.
 */

import { resolveEnvAlias } from "../utils/env-alias.js";
import type { BrandingConfig } from "./branding.js";

export function getBootConfigEnvAliases() {
	return getBootConfig().envAliases;
}

export function resolveAliasedEnvValue(
	key: string,
	aliases = getBootConfigEnvAliases(),
	env: Record<string, string | undefined> | null = process.env,
): string | undefined {
	return resolveEnvAlias(key, aliases, env);
}

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
	 * Legacy host override for the retired shared-first onboarding experiment.
	 * Signed-in app and Cloud sessions require Dedicated; Shared remains for
	 * public and connector ingress.
	 */
	preferSharedCloudTier?: boolean;
	/**
	 * Legacy recovery switch for a Shared profile saved by an older app build.
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
	preferSharedCloudTier: false,
	autoUpgradeSharedToDedicated: false,
};

const BOOT_CONFIG_STORE_KEY = Symbol.for("elizaos.app.boot-config");

interface BootConfigStore {
	current: AppBootConfig;
}

type GlobalConfigSlot = Record<PropertyKey, unknown>;

function getGlobalSlot(): GlobalConfigSlot {
	return globalThis as GlobalConfigSlot;
}

function getBootConfigStore(): BootConfigStore {
	const globalObject = getGlobalSlot();

	// Hosts and duplicated module instances share the same process store.
	const existing = globalObject[BOOT_CONFIG_STORE_KEY];
	if (
		existing &&
		typeof existing === "object" &&
		"current" in (existing as Record<string, unknown>)
	) {
		return existing as BootConfigStore;
	}

	// Browser bootstrap mirrors are owned by the UI host.
	const store: BootConfigStore = {
		current: DEFAULT_BOOT_CONFIG,
	};
	globalObject[BOOT_CONFIG_STORE_KEY] = store;
	return store;
}

export function setBootConfig(config: AppBootConfig): void {
	const store = getBootConfigStore();
	store.current = config;
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
