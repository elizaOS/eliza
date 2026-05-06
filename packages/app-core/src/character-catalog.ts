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

export function getCharacterAssets(): ResolvedCharacterAsset[] {
  return getResolved().assets;
}

export const DEFAULT_ELIZA_CHARACTER_ASSET: ResolvedCharacterAsset | null =
  null;

export function getCharacterAsset(id: number): ResolvedCharacterAsset | null {
  return getResolved().getAsset(id);
}

export function getInjectedCharacters(): ResolvedInjectedCharacter[] {
  return getResolved().injectedCharacters;
}

export function getInjectedCharacter(
  catchphrase: string,
): ResolvedInjectedCharacter | null {
  return getResolved().getInjectedCharacter(catchphrase);
}
