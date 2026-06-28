export * from "./plugin.js";
export * from "./routes.js";
export * from "./service-loader.js";

export {
  type DocumentsFetchers,
  DocumentsView,
  type DocumentsViewProps,
} from "./components/documents/DocumentsView.js";
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
  registerDocumentsTerminalView,
  setDocumentsTerminalSnapshot,
} from "./register-terminal-view.js";

// Side-effect: in a terminal host (Node agent, no DOM) this registers the
// documents terminal view. DOM-guarded so the terminal engine stays out of
// browser bundles.
import "./register.js";
