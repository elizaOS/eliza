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
export * from "./index.node.js";
export { default } from "./index.node.js";
export { registerRelationshipsApp } from "./register.js";
