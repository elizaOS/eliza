import { buildElizaCharacterCatalog } from "@elizaos/shared";
import type { CharacterCatalogData } from "@elizaos/ui";

export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
