/** Renderer entry: document views and registration without routes or runtime services. */
export {
  type DocumentCard,
  type DocumentSearchHit,
  type DocumentsSearchState,
  type DocumentsSnapshot,
  DocumentsSpatialView,
  type DocumentsViewState,
  EMPTY_DOCUMENTS_SNAPSHOT,
} from "./components/documents/DocumentsSpatialView.js";
export {
  type DocumentsFetchers,
  DocumentsView,
  type DocumentsViewProps,
} from "./components/documents/DocumentsView.js";
export { KnowledgeDocumentsView } from "./components/documents/KnowledgeDocumentsView.js";
export { KnowledgeView } from "./components/documents/KnowledgeView.js";
export { registerKnowledgeApp } from "./register.js";
