/**
 * Relationship types for the LifeOps knowledge graph.
 *
 * Canonical home is `@elizaos/shared` (`knowledge-graph/relationship-types.ts`).
 * This module re-exports the runtime-level primitives so the DB-backed
 * `RelationshipStore` and the rest of LifeOps keep importing from `./types.js`.
 */

export {
  BUILT_IN_RELATIONSHIP_TYPES,
  type BuiltInRelationshipType,
  defaultRelationshipTypeRegistry,
  type Relationship,
  type RelationshipFilter,
  type RelationshipSentiment,
  type RelationshipSource,
  type RelationshipState,
  type RelationshipStatus,
  RelationshipTypeRegistry,
} from "@elizaos/shared";
