/** Renderer entry: page registration and views without graph storage or runtime services. */
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
export { registerRelationshipsApp } from "./register.js";
export * from "./types.js";
