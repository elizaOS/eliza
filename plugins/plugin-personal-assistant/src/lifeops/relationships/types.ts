/**
 * Relationship types for the LifeOps knowledge graph.
 *
 * Canonical home is `@elizaos/core` (`knowledge-graph/relationship-types.ts`).
 * This module re-exports the runtime-level primitives so the DB-backed
 * `RelationshipStore` and the rest of LifeOps keep importing from `./types.js`.
 */
export {
  BUILT_IN_RELATIONSHIP_TYPES,
  type BuiltInRelationshipType,
  defaultRelationshipTypeRegistry,
  type KnowledgeGraphRelationship as Relationship,
  type LifeOpsGraphRelationshipSource as RelationshipSource,
  type LifeOpsGraphRelationshipState as RelationshipState,
  type LifeOpsGraphRelationshipStatus as RelationshipStatus,
  type RelationshipFilter,
  type RelationshipSentiment,
  RelationshipTypeRegistry,
} from "@elizaos/contracts";
