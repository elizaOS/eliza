/**
 * Public entry for `@elizaos/plugin-relationships`: the entity graph-CRUD action,
 * the relationships views, retired-schema compatibility descriptors, and the
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
export {
  inventoryLegacyRelationshipsSchema,
  type LegacyRelationshipsInventory,
  LegacyRelationshipsSchemaAuditService,
  RELATIONSHIPS_LEGACY_SCHEMA_AUDIT_SERVICE_TYPE,
} from "./services/legacy-schema-audit.js";
export * from "./types.js";

import { relationshipsPlugin } from "./plugin.js";

export default relationshipsPlugin;
