/** Barrel for the entity store and identity-merge engine (contact/person/org records and dedup). */

export { EntityStore } from "@elizaos/plugin-relationships";
export { AUTO_MERGE_CONFIDENCE_THRESHOLD } from "@elizaos/shared";
export {
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
  type IdentityObserveOutcome,
  mergeEntities,
} from "./merge.js";
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
} from "./types.js";
