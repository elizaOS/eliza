import { buildElizaCharacterCatalog } from "@elizaos/shared";
import type { CharacterCatalogData } from "@elizaos/ui/config";

export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
