/**
 * DocumentsSpatialView — the document store browser authored with the spatial
 * vocabulary and mounted in `<SpatialSurface>` for the GUI surface.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives (no browser/client
 * import).
 *
 * The list, stats, and search results are fetched/mapped in the data wrapper
 * ({@link ./DocumentsView.tsx}) and handed in already projected to display
 * shape; this component never fetches or computes business values — it displays
 * the snapshot and dispatches actions. The search query is local interactive
 * state held with `useSpatialState` so it works on every surface.
 */

import {
  Button,
  Card,
  Field,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Which render state the document browser is in. */
export type DocumentsViewState = "loading" | "error" | "empty" | "ready";

/** A single document row, already projected to display shape by the wrapper. */
export interface DocumentCard {
  id: string;
  /** Display title (the presented `filename`). */
  title: string;
  /** Pre-formatted meta line (e.g. "markdown · 4 KB · Jun 16"), or empty. */
  meta: string;
}

/** A single search result row, already projected by the wrapper. */
export interface DocumentSearchHit {
  id: string;
  /** Display title of the source document. */
  title: string;
  /** Pre-trimmed snippet of the matching fragment, or empty. */
  snippet: string;
}

/** Search sub-state, mirroring the wrapper's search state machine. */
export type DocumentsSearchState =
  | { kind: "idle" }
  | { kind: "searching"; query: string }
  | { kind: "results"; query: string; hits: DocumentSearchHit[] }
  | { kind: "error"; query: string; message: string };

export interface DocumentsSnapshot {
  /** The browser state machine. */
  state: DocumentsViewState;
  /** Documents to list (only meaningful when state === "ready"). */
  documents: DocumentCard[];
  /** Total stored document count (from /stats). */
  documentCount: number;
  /** Total stored fragment count (from /stats). */
  fragmentCount: number;
  /** Active search text (controlled by the wrapper). */
  query: string;
  /** Search sub-state (only surfaced when state === "ready"). */
  search: DocumentsSearchState;
  /** Error message when state === "error". */
  error?: string;
}

export const EMPTY_DOCUMENTS_SNAPSHOT: DocumentsSnapshot = {
  state: "loading",
  documents: [],
  documentCount: 0,
  fragmentCount: 0,
  query: "",
  search: { kind: "idle" },
};

export interface DocumentsSpatialViewProps {
  snapshot: DocumentsSnapshot;
  /**
   * Dispatch by action id:
   *   `retry`         — reload after an error,
   *   `search:<text>` — set the search text and run a document search,
   *   `clear-search`  — drop the active search and show the full list,
   *   `open:<id>`     — open/inspect the document `<id>`.
   */
  onAction?: (action: string) => void;
}

export function DocumentsSpatialView({
  snapshot,
  onAction,
}: DocumentsSpatialViewProps) {
  return (
    <Card gap={1} padding={1}>
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <DocumentsErrorBody snapshot={snapshot} onAction={onAction} />
      ) : snapshot.state === "empty" ? (
        <DocumentsEmptyBody />
      ) : (
        <DocumentsReadyBody snapshot={snapshot} onAction={onAction} />
      )}
    </Card>
  );
}

function DocumentsErrorBody({
  snapshot,
  onAction,
}: {
  snapshot: DocumentsSnapshot;
  onAction?: (action: string) => void;
}) {
  return (
    <>
      <Text bold>Could not load documents</Text>
      <Text tone="danger" style="caption">
        {snapshot.error ?? "Could not load documents."}
      </Text>
      <HStack gap={1}>
        <Button agent="retry" onPress={() => onAction?.("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function DocumentsEmptyBody() {
  return <Text bold>None</Text>;
}

function DocumentsReadyBody({
  snapshot,
  onAction,
}: {
  snapshot: DocumentsSnapshot;
  onAction?: (action: string) => void;
}) {
  return (
    <>
      <Text tone="muted" style="caption">
        {countLabel(snapshot.documentCount, "document")} ·{" "}
        {countLabel(snapshot.fragmentCount, "fragment")}
      </Text>

      <Field
        kind="text"
        label="Search"
        value={snapshot.query}
        placeholder="keyword or meaning"
        agent="documents-search"
        onChange={(value) => onAction?.(`search:${value}`)}
      />

      <DocumentsSearchBody search={snapshot.search} onAction={onAction} />

      <Text style="caption" tone="muted">
        Documents ({snapshot.documents.length})
      </Text>
      {snapshot.documents.length === 0 ? (
        <Text tone="muted" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} onAction={onAction} />
          ))}
        </List>
      )}
    </>
  );
}

function DocumentRow({
  doc,
  onAction,
}: {
  doc: DocumentCard;
  onAction?: (action: string) => void;
}) {
  // Title on its own full-width line, the meta caption below it, and the Open
  // control alone on the last line — so a long filename never collides with the
  // button and the affordance frames cleanly at every width.
  return (
    <VStack gap={0} agent={`doc-${doc.id}`}>
      <HStack gap={1} align="center">
        <Text tone="muted" wrap={false}>
          •
        </Text>
        <Text bold grow={1}>
          {doc.title}
        </Text>
      </HStack>
      {doc.meta ? (
        <Text style="caption" tone="muted">
          {doc.meta}
        </Text>
      ) : null}
      <HStack gap={1} justify="end">
        <Button
          variant="outline"
          tone="default"
          agent={`open:${doc.id}`}
          onPress={() => onAction?.(`open:${doc.id}`)}
        >
          ›
        </Button>
      </HStack>
    </VStack>
  );
}

function DocumentsSearchBody({
  search,
  onAction,
}: {
  search: DocumentsSearchState;
  onAction?: (action: string) => void;
}) {
  if (search.kind === "idle") return null;

  if (search.kind === "searching") {
    return (
      <Text tone="muted" style="caption" wrap={false}>
        Searching for {search.query}
      </Text>
    );
  }

  if (search.kind === "error") {
    return (
      <>
        <Text bold>Search failed</Text>
        <Text tone="danger" style="caption">
          {search.message}
        </Text>
        <HStack gap={1}>
          <Button
            agent="clear-search"
            onPress={() => onAction?.("clear-search")}
          >
            Clear
          </Button>
        </HStack>
      </>
    );
  }

  return (
    <>
      <Text style="caption" tone="muted">
        Results ({search.hits.length})
      </Text>
      {search.hits.length === 0 ? (
        <Text tone="muted" style="caption" wrap={false}>
          None
        </Text>
      ) : (
        <List gap={0}>
          {search.hits.map((hit) => (
            <SearchResultRow key={hit.id} hit={hit} onAction={onAction} />
          ))}
        </List>
      )}
      <HStack gap={1}>
        <Button agent="clear-search" onPress={() => onAction?.("clear-search")}>
          Clear
        </Button>
      </HStack>
    </>
  );
}

function SearchResultRow({
  hit,
  onAction,
}: {
  hit: DocumentSearchHit;
  onAction?: (action: string) => void;
}) {
  // A hit carries a long free-text snippet, so it gets its own full-width
  // wrapping line above the Open control (which sits alone on the last line) —
  // nothing competes with the button for horizontal space at any width.
  return (
    <VStack gap={0} agent={`hit-${hit.id}`}>
      <HStack gap={1} align="center">
        <Text tone="muted" wrap={false}>
          ›
        </Text>
        <Text bold grow={1}>
          {hit.title}
        </Text>
      </HStack>
      {hit.snippet ? (
        <Text style="caption" tone="muted">
          {hit.snippet}
        </Text>
      ) : null}
      <HStack gap={1} justify="end">
        <Button
          variant="outline"
          tone="default"
          agent={`open:${hit.id}`}
          onPress={() => onAction?.(`open:${hit.id}`)}
        >
          ›
        </Button>
      </HStack>
    </VStack>
  );
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
