/**
 * DocumentSink — the minimal storage port the pipeline writes through.
 *
 * Core deliberately does NOT depend on eliza's real `DocumentService`. Instead
 * the pipeline stores through this narrow port so:
 *   - core is unit-testable with a fake sink (no runtime/DB), and
 *   - the eliza-app side provides a thin adapter mapping `addDocument` onto the
 *     real `DocumentService.addDocument` (which brings content-based dedup,
 *     fragmenting, batched embeddings, scoping, and hybrid search).
 *
 * The `status` on the add result lets the pipeline account for the real
 * service's built-in dedup (`skipped` when an identical content+filename doc
 * already exists) without knowing anything about how dedup is implemented.
 *
 * See conversation-importer-scope.md §4 (§4.1 render → §4.2 scope/provenance).
 */

/** Visibility scope for a stored document. Mirrors DocumentService scopes. */
export type DocumentScope =
  | "global"
  | "owner-private"
  | "user-private"
  | "agent-private";

/** Provenance of where a document came from. `import` is this package's value. */
export type DocumentAddedFrom =
  | "import"
  | "chat"
  | "upload"
  | "url"
  | "file"
  | (string & {});

/** A document to store. Field names align with DocumentService.addDocument. */
export interface SinkDocument {
  /** Full markdown transcript (a rendered part). */
  content: string;
  contentType: string;
  /** e.g. `chatgpt/<conversation-id>.md` (or `...__partN.md`). */
  originalFilename: string;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedFrom?: DocumentAddedFrom;
  /** Provenance/import metadata block (see scope §4.2/§4.4). */
  metadata?: Record<string, unknown>;
}

/** Result of storing a document. */
export interface SinkAddResult {
  /** The stored document id (adapter maps from the service's memory id). */
  id: string;
  /**
   * `stored` when a new document was persisted; `skipped` when the sink's own
   * dedup recognized identical content and did nothing.
   */
  status: "stored" | "skipped";
}

/**
 * The storage port. The real adapter wraps `DocumentService`; tests use a fake.
 * `deleteDocument` powers batch uninstall.
 */
export interface DocumentSink {
  addDocument(doc: SinkDocument): Promise<SinkAddResult>;
  deleteDocument(id: string): Promise<void>;
}
