/**
 * Public entry for `@elizaos/plugin-relationships`: the entity graph-CRUD action,
 * the relationships views (browser + spatial/TUI), the drizzle schema, and the
 * entity-graph provider.
 */
export type { EntityActionParameters } from "./actions/entity.js";
export { entityAction } from "./actions/entity.js";
export {
  EMPTY_RELATIONSHIPS,
  type EntityNode,
  type KindFilter,
  type RelationshipEdge,
  type RelationshipsSnapshot,
  RelationshipsSpatialView,
  type RelationshipsViewState,
} from "./components/relationships/RelationshipsSpatialView.js";
export { RelationshipsView } from "./components/relationships/RelationshipsView.js";
export {
  type EntityInsert,
  type EntityRow,
  entitiesTable,
  type RelationshipInsert,
  type RelationshipRow,
  relationshipsSchema,
  relationshipsTable,
} from "./db/schema.js";
export { relationshipsPlugin } from "./plugin.js";
export { entityGraphProvider } from "./providers/entity-graph.js";
export * from "./types.js";

import { relationshipsPlugin } from "./plugin.js";

export default relationshipsPlugin;
