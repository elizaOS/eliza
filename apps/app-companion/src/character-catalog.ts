import {
  getBootConfig,
  type ResolvedCharacterAsset,
  type ResolvedInjectedCharacter,
  resolveCharacterCatalog,
} from "@elizaos/app-core";

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

export function getCharacterAssets(): ResolvedCharacterAsset[] {
  return getResolved().assets;
}

export const ELIZA_CHARACTER_ASSET_COUNT = 0;

export const DEFAULT_ELIZA_CHARACTER_ASSET: ResolvedCharacterAsset | null =
  null;

export const DEFAULT_MILADY_CHARACTER_ASSET = DEFAULT_ELIZA_CHARACTER_ASSET;

export function getCharacterAsset(id: number): ResolvedCharacterAsset | null {
  return getResolved().getAsset(id);
}

export function getInjectedCharacters(): ResolvedInjectedCharacter[] {
  return getResolved().injectedCharacters;
}

export const ELIZA_INJECTED_CHARACTER_COUNT = 0;

export function getInjectedCharacter(
  catchphrase: string,
): ResolvedInjectedCharacter | null {
  return getResolved().getInjectedCharacter(catchphrase);
}
