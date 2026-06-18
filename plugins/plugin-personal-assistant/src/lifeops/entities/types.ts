/**
 * Entity types for the LifeOps knowledge graph.
 *
 * Canonical home is `@elizaos/shared` (`knowledge-graph/entity-types.ts`).
 * This module re-exports the runtime-level primitives so the DB-backed
 * `EntityStore` and the rest of LifeOps keep importing from `./types.js`.
 */

export {
  BUILT_IN_ENTITY_TYPES,
  type BuiltInEntityType,
  defaultEntityTypeRegistry,
  type Entity,
  type EntityAttribute,
  type EntityFilter,
  type EntityIdentity,
  type EntityIdentityAddedVia,
  type EntityResolveCandidate,
  type EntityState,
  EntityTypeRegistry,
  type EntityVisibility,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
