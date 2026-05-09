import type { CharacterCatalogData } from "@elizaos/ui";
import { buildElizaCharacterCatalog } from "@elizaos/shared";

export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
