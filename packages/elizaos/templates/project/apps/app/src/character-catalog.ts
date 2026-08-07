/**
 * Eliza character catalog derived from the shared character preset source.
 */

import { buildElizaCharacterCatalog } from "@elizaos/shared";
import type { CharacterCatalogData } from "@elizaos/ui/config";

export const ELIZA_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
