/** Runtime graph API and explicitly registered renderer surfaces. */

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
export type {
  IdentityMatchInput,
  IdentityObserveOutcome,
} from "./identity-merge.js";
export {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
  mergeEntities,
  OVERRIDE_CONFIDENCE_DELTA,
} from "./identity-merge.js";
export * from "./index.node.js";
export { default } from "./index.node.js";
export { registerRelationshipsApp } from "./register.js";
