/**
 * Entity types for the LifeOps knowledge graph.
 *
 * Canonical home is `@elizaos/core` (`knowledge-graph/entity-types.ts`).
 * This module re-exports the runtime-level primitives so the DB-backed
 * `EntityStore` and the rest of LifeOps keep importing from `./types.js`.
 */
export {
  BUILT_IN_ENTITY_TYPES,
  type BuiltInEntityType,
  defaultEntityTypeRegistry,
  type EntityFilter,
  type EntityResolveCandidate,
  EntityTypeRegistry,
  KNOWLEDGE_GRAPH_DEFAULT_CONNECTOR_ACCOUNT_ID as DEFAULT_CONNECTOR_ACCOUNT_ID,
  type KnowledgeGraphEntity as Entity,
  type LifeOpsEntityAttribute as EntityAttribute,
  type LifeOpsEntityIdentity as EntityIdentity,
  type LifeOpsEntityIdentityAddedVia as EntityIdentityAddedVia,
  type LifeOpsEntityState as EntityState,
  type LifeOpsEntityVisibility as EntityVisibility,
  normalizeEntityConnectorAccountId,
  SELF_ENTITY_ID,
} from "@elizaos/contracts";
