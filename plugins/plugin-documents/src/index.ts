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
export {
  registerDocumentsTerminalView,
  setDocumentsTerminalSnapshot,
} from "./register-terminal-view.js";
export * from "./routes.js";
export * from "./service-loader.js";

// Side-effect: in a terminal host (Node agent, no DOM) this registers the
// documents terminal view. DOM-guarded so the terminal engine stays out of
// browser bundles.
import "./register.js";
