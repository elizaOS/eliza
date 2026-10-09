/** Runtime graph services, schemas and plugin composition without renderer imports. */
export type { EntityActionParameters } from "./actions/entity.js";
export { entityAction } from "./actions/entity.js";
export {
  type EntityInsert,
  type EntityRow,
  entitiesTable,
  type RelationshipInsert,
  type RelationshipRow,
  relationshipsSchema,
  relationshipsTable,
} from "./db/schema.js";
export {
  archiveCoreRelationshipsInventory,
  type CoreRelationshipsInventoryDatabase,
  type CoreRelationshipsInventoryReport,
  type CoreRelationshipsInventorySession,
  type CoreRelationshipsSourceKind,
} from "./knowledge-graph/core-relationships-inventory.js";
export { EntityStore } from "./knowledge-graph/entity-store.js";
export { RelationshipStore } from "./knowledge-graph/relationship-store.js";
export { knowledgeGraphSchema } from "./knowledge-graph/schema.js";
export {
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  resolveKnowledgeGraphService,
} from "./knowledge-graph/service.js";
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
