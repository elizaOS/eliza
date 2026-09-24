/**
 * Default character catalog for the app shell. `APP_CHARACTER_CATALOG` is the
 * built-in preset list produced by `buildElizaCharacterCatalog()` from
 * `@elizaos/shared`, typed as the UI's `CharacterCatalogData`.
 */
import { buildElizaCharacterCatalog } from "@elizaos/shared";
import type { CharacterCatalogData } from "@elizaos/ui/config";

export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
