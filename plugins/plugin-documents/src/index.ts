/** Public entry for @elizaos/plugin-documents: the HTTP route plugin plus its documents view, presenter, and type re-exports. */
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
