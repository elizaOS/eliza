import type { CharacterCatalogData } from "@elizaos/app-core";
import { buildElizaCharacterCatalog } from "@elizaos/shared";

export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
