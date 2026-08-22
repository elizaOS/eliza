/** Public entry for the document HTTP routes, reusable document components, presenter, and types. */
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
export * from "./plugin.js";
export * from "./routes.js";
export * from "./service-loader.js";
