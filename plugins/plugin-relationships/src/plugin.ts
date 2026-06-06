import type { Plugin } from "@elizaos/core";

import { entityAction } from "./actions/entity.js";
import * as dbSchema from "./db/index.js";
import { entityGraphProvider } from "./providers/entity-graph.js";

/**
 * `@elizaos/plugin-relationships`
 *
 * Knowledge-graph plugin: person / organization / place / project / concept
 * entities, identity merge engine, typed edges, and the ENTITY umbrella action.
 *
 * Hard-depends on `@elizaos/plugin-sql` — the runtime registers migrations
 * from `schema` (this module's drizzle pgSchema('app_relationships')).
 *
 * NOTE: This is the decomposition scaffold. The real EntityStore, merge
 * engine, voice-observer-bridge, and RelationshipStore still live under
 * `plugins/plugin-lifeops/src/lifeops/entities/` and
 * `plugins/plugin-lifeops/src/lifeops/relationships/`. They will move here in
 * a follow-up pass.
 */
export const relationshipsPlugin: Plugin = {
  name: "relationships",
  description:
    "Entity and relationship knowledge graph for Eliza agents. Provides the ENTITY umbrella action (person/org/place/project/concept CRUD with identity claims, typed relationships, and merge), an entity-graph context provider, and a drizzle pgSchema('app_relationships') with `entities` and `relationships` tables. STUB during decomposition — real handlers will port from @elizaos/plugin-lifeops.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [entityAction],
  providers: [entityGraphProvider],
  services: [],
  schema: dbSchema,
};

export default relationshipsPlugin;
