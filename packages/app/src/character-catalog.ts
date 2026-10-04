/**
 * Default character catalog for the app shell. `APP_CHARACTER_CATALOG` is the
 * built-in preset list produced by `buildElizaCharacterCatalog()` from
 * `@elizaos/core`, typed as the UI's `CharacterCatalogData`.
 */

import { buildElizaCharacterCatalog } from "@elizaos/host/protocol";
import type { CharacterCatalogData } from "@elizaos/ui";
export const APP_CHARACTER_CATALOG: CharacterCatalogData =
  buildElizaCharacterCatalog() as CharacterCatalogData;
