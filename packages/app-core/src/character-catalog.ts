/**
 * Character catalog — reads from the boot config instead of a cross-package import.
 *
 * The host app (apps/app) passes its character catalog via AppBootConfig.characterCatalog.
 * This module provides backward-compatible exports that resolve from the boot config.
 */
import {
  getBootConfig,
  type ResolvedCharacterAsset,
  type ResolvedInjectedCharacter,
  resolveCharacterCatalog,
} from "./config/boot-config";

function getResolved() {
  const catalog = getBootConfig().characterCatalog;
  if (!catalog) {
    return {
      assets: [] as ResolvedCharacterAsset[],
      assetCount: 0,
      defaultAsset: null,
      injectedCharacters: [] as ResolvedInjectedCharacter[],
      injectedCharacterCount: 0,
      getAsset: () => null,
      getInjectedCharacter: () => null,
    };
  }
  return resolveCharacterCatalog(catalog);
}

/** All resolved character assets. */
export function getCharacterAssets(): ResolvedCharacterAsset[] {
  return getResolved().assets;
}

export const ELIZA_CHARACTER_ASSET_COUNT = 0;

export const DEFAULT_ELIZA_CHARACTER_ASSET: ResolvedCharacterAsset | null =
  null;

export function getCharacterAsset(id: number): ResolvedCharacterAsset | null {
  return getResolved().getAsset(id);
}

/** All resolved injected characters. */
export function getInjectedCharacters(): ResolvedInjectedCharacter[] {
  return getResolved().injectedCharacters;
}

export const ELIZA_INJECTED_CHARACTER_COUNT = 0;

export function getInjectedCharacter(
  catchphrase: string,
): ResolvedInjectedCharacter | null {
  return getResolved().getInjectedCharacter(catchphrase);
}
