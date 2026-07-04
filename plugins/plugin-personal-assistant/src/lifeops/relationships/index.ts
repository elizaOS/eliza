/** Barrel for the relationship store and edge extraction (who-relates-to-whom graph over owner entities). */
export {
  applyExtractedEdges,
  type ExtractedEdge,
  type ExtractedEntityRef,
  type ExtractionResult,
  managerOfAtCompany,
} from "./extraction.js";
export { RelationshipStore } from "./store.js";
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
} from "./types.js";
