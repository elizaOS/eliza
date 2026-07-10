/**
 * RelationshipsSpatialView — the entity / relationship knowledge-graph viewer
 * authored once with the spatial vocabulary, so it renders correctly wherever it
 * is displayed:
 *
 *   - GUI today through `<SpatialSurface>` (DOM).
 *   - Future adapters can reuse the same snapshot contract behind the retained modality types.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * without pulling browser-only runtime imports into the presentational layer.
 *
 * The two graph payloads (entities + their outbound edges) are joined and
 * projected to {@link EntityNode}s in the data wrapper ({@link ./RelationshipsView.tsx});
 * this component never fetches or computes the graph — it displays the snapshot
 * and dispatches actions. The entity-kind filter is the one piece of interactive
 * state it owns locally (via {@link useSpatialState}); filtering the already-built
 * node list is presentation-only and works on every surface.
 */

import {
  Button,
  Card,
  HStack,
  List,
  Text,
  useSpatialState,
  VStack,
} from "@elizaos/ui/spatial";

/** A typed edge shown under its source entity, already projected for display. */
export interface RelationshipEdge {
  id: string;
  /** Resolved target display name (or the raw id when unresolved). */
  toName: string;
  /** Pre-formatted meta line: `type · every Nd · last <date>`. */
  meta: string;
}

/** An entity node: identity + kind + its outbound edges. */
export interface EntityNode {
  id: string;
  /** Raw entity kind (e.g. "person", "organization"). */
  kind: string;
  /** Human label for the kind (e.g. "People", "Organizations"). */
  kindLabel: string;
  name: string;
  /** Pre-joined identity claims line (`discord:pat#1 · x:@pat`), or empty. */
  identityLine: string;
  edges: RelationshipEdge[];
}

/** A selectable kind filter offered above the graph. */
export interface KindFilter {
  /** Raw kind value used to match nodes. */
  kind: string;
  /** Human label shown on the chip. */
  label: string;
}

/** Which render state the graph is in. */
export type RelationshipsViewState = "loading" | "error" | "empty" | "ready";

export interface RelationshipsSnapshot {
  /** The graph state machine. */
  state: RelationshipsViewState;
  /** The entity nodes (only meaningful when state === "ready"). */
  nodes: EntityNode[];
  /** The kind filters offered above the graph. */
  filters: KindFilter[];
  /** Error message when state === "error". */
  error?: string;
}

export const EMPTY_RELATIONSHIPS: RelationshipsSnapshot = {
  state: "loading",
  nodes: [],
  filters: [],
};

export interface RelationshipsSpatialViewProps {
  snapshot: RelationshipsSnapshot;
  /**
   * Dispatch by action id:
   *   - `retry`            — reload after an error,
   *   - `add`              — route an add-a-person request through chat,
   *   - `open:<entityId>`  — focus an entity node.
   */
  onAction?: (action: string) => void;
}

export function RelationshipsSpatialView({
  snapshot,
  onAction,
}: RelationshipsSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1} shrink={0} width="100%">
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading relationships
        </Text>
      ) : snapshot.state === "error" ? (
        <RelationshipsErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <RelationshipsEmptyBody dispatch={dispatch} />
      ) : (
        <RelationshipsReadyBody snapshot={snapshot} onAction={onAction} />
      )}
    </Card>
  );
}

function RelationshipsErrorBody({
  snapshot,
  dispatch,
}: {
  snapshot: RelationshipsSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Could not load relationships</Text>
      <Text tone="danger" style="caption">
        {snapshot.error ?? "Could not load relationships."}
      </Text>
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function RelationshipsEmptyBody({
  dispatch,
}: {
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>None</Text>
      <HStack gap={1}>
        <Button agent="add" onPress={dispatch("add")}>
          Add someone
        </Button>
      </HStack>
    </>
  );
}

function RelationshipsReadyBody({
  snapshot,
  onAction,
}: {
  snapshot: RelationshipsSnapshot;
  onAction?: (action: string) => void;
}) {
  // The active kind filter is the one piece of interactive local state. Empty
  // string = "all kinds". A single selection keeps the chips and the rendered
  // cards in agreement on every surface.
  const [activeKind, setActiveKind] = useSpatialState<string>("");

  const visible =
    activeKind === ""
      ? snapshot.nodes
      : snapshot.nodes.filter((node) => node.kind === activeKind);

  return (
    <>
      {snapshot.filters.length > 0 ? (
        <KindFilters
          filters={snapshot.filters}
          active={activeKind}
          onSelect={setActiveKind}
        />
      ) : null}
      <Text style="caption" tone="muted">
        Graph ({visible.length})
      </Text>
      {visible.length === 0 ? (
        <Text tone="muted" style="caption">
          None
        </Text>
      ) : (
        <List gap={1}>
          {visible.map((node) => (
            <EntityNodeBlock key={node.id} node={node} onAction={onAction} />
          ))}
        </List>
      )}
    </>
  );
}

function KindFilters({
  filters,
  active,
  onSelect,
}: {
  filters: KindFilter[];
  active: string;
  onSelect: (kind: string) => void;
}) {
  return (
    <HStack gap={1} wrap align="center">
      <Button
        agent="relationships-kind-all"
        variant={active === "" ? "solid" : "ghost"}
        onPress={() => onSelect("")}
      >
        All
      </Button>
      {filters.map((filter) => (
        <Button
          key={filter.kind}
          agent={`relationships-kind-${filter.kind}`}
          variant={active === filter.kind ? "solid" : "ghost"}
          onPress={() => onSelect(active === filter.kind ? "" : filter.kind)}
        >
          {filter.label}
        </Button>
      ))}
    </HStack>
  );
}

function EntityNodeBlock({
  node,
  onAction,
}: {
  node: EntityNode;
  onAction?: (action: string) => void;
}) {
  return (
    <VStack gap={0} agent={`rel-${node.id}`}>
      <HStack gap={1} align="center">
        <VStack gap={0} grow={1}>
          <Text bold wrap={false}>
            {node.name}
          </Text>
        </VStack>
        <Text style="caption" tone="primary" wrap={false}>
          {node.kindLabel}
        </Text>
        <Button
          agent={`open-${node.id}`}
          onPress={() => onAction?.(`open:${node.id}`)}
        >
          ›
        </Button>
      </HStack>
      {node.identityLine ? (
        <Text style="caption" tone="muted" wrap={false}>
          {node.identityLine}
        </Text>
      ) : null}
      {node.edges.length > 0
        ? node.edges.map((edge) => (
            <HStack key={edge.id} gap={1} align="center">
              <Text tone="muted" wrap={false}>
                ›
              </Text>
              <VStack gap={0} grow={1}>
                <Text wrap={false}>{edge.toName}</Text>
              </VStack>
              <Text style="caption" tone="muted" wrap={false}>
                {edge.meta}
              </Text>
            </HStack>
          ))
        : null}
    </VStack>
  );
}
