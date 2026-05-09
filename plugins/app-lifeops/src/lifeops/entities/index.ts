export {
  type Entity,
  type EntityIdentity,
  type EntityAttribute,
  type EntityState,
  type EntityFilter,
  type EntityResolveCandidate,
  type EntityVisibility,
  type EntityIdentityAddedVia,
  type BuiltInEntityType,
  EntityTypeRegistry,
  defaultEntityTypeRegistry,
  BUILT_IN_ENTITY_TYPES,
  SELF_ENTITY_ID,
} from "./types.js";
export {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  EntityStore,
} from "./store.js";
export {
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
  mergeEntities,
  type IdentityObserveOutcome,
} from "./merge.js";
export {
  type ContactResolverShim,
  type ResolvedContactShim,
  createContactResolverShim,
} from "./resolver-shim.js";
