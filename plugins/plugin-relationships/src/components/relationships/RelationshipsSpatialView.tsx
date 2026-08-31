/**
 * RelationshipsSpatialView — the entity / relationship knowledge-graph viewer
 * projected into the canonical web component vocabulary used by the Character
 * family. It is purely presentational: a snapshot and action callback enter;
 * accessible filters and entity rows leave.
 *
 * The two graph payloads (entities + their outbound edges) are joined and
 * projected to {@link EntityNode}s in the data wrapper ({@link ./RelationshipsView.tsx});
 * this component never fetches or computes the graph — it displays the snapshot
 * and dispatches actions. The entity-kind filter is the one piece of interactive
 * state it owns locally; filtering the already-built node list is
 * presentation-only.
 */

import {
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { type ComponentProps, useState } from "react";

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

function RelationshipActionButton({
  agentId,
  agentLabel,
  onAgentActivate,
  ...props
}: ComponentProps<typeof Button> & {
  agentId: string;
  agentLabel: string;
  onAgentActivate?: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: "relationships",
    onActivate: onAgentActivate,
  });
  return <Button ref={ref} {...agentProps} {...props} />;
}

function RelationshipFilterItem({
  agentId,
  agentLabel,
  ...props
}: ComponentProps<typeof DropdownMenuRadioItem> & {
  agentId: string;
  agentLabel: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
    id: agentId,
    role: "menu-item",
    label: agentLabel,
    group: "relationship-filters",
  });
  return <DropdownMenuRadioItem ref={ref} {...agentProps} {...props} />;
}

export function RelationshipsSpatialView({
  snapshot,
  onAction,
}: RelationshipsSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card
      variant="transparentSquare"
      className="w-full min-w-0"
      data-testid="relationships-view"
    >
      {snapshot.state === "loading" ? (
        <PagePanel.ContentState
          state="loading"
          placement="panel"
          heading="Loading relationships"
          role="status"
          aria-label="Loading relationships"
        />
      ) : snapshot.state === "error" ? (
        <PagePanel.ContentState
          state="error"
          placement="panel"
          title="Could not load relationships"
          description={snapshot.error ?? "Could not load relationships."}
          action={
            <RelationshipActionButton
              size="sm"
              agentId="retry"
              agentLabel="Retry"
              onAgentActivate={dispatch("retry")}
              onClick={dispatch("retry")}
            >
              Retry
            </RelationshipActionButton>
          }
        />
      ) : snapshot.state === "empty" ? (
        <PagePanel.ContentState
          state="empty"
          placement="panel"
          title="No relationships yet"
          description="Add a person to start building the relationship graph."
          action={
            <RelationshipActionButton
              size="sm"
              agentId="add"
              agentLabel="Add someone"
              onAgentActivate={dispatch("add")}
              onClick={dispatch("add")}
            >
              Add someone
            </RelationshipActionButton>
          }
        />
      ) : (
        <RelationshipsReadyBody snapshot={snapshot} onAction={onAction} />
      )}
    </Card>
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
  const [activeKind, setActiveKind] = useState("");

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
      <div className="mt-4 text-xs font-medium text-muted">
        {visible.length} {visible.length === 1 ? "entity" : "entities"}
      </div>
      {visible.length === 0 ? (
        <PagePanel.ContentState
          state="empty"
          placement="panel"
          title="No matching relationships."
        />
      ) : (
        <div className="mt-2 divide-y divide-border/45 border-y border-border/45">
          {visible.map((node) => (
            <EntityNodeBlock key={node.id} node={node} onAction={onAction} />
          ))}
        </div>
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
  const allKindsValue = "__all__";
  const selectedLabel =
    filters.find((filter) => filter.kind === active)?.label ?? "All";

  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="text-sm text-muted">Type</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RelationshipActionButton
            type="button"
            size="dense"
            variant="ghostMuted"
            className="min-w-32 justify-between"
            agentId="relationships-kind-filter"
            agentLabel={`Filter relationship type, ${selectedLabel} selected`}
            aria-label={`Filter relationship type, ${selectedLabel} selected`}
          >
            <span>{selectedLabel}</span>
            <span aria-hidden="true">▾</span>
          </RelationshipActionButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={active || allKindsValue}
            onValueChange={(value) =>
              onSelect(value === allKindsValue ? "" : value)
            }
          >
            <RelationshipFilterItem
              value={allKindsValue}
              agentId="relationships-kind-all"
              agentLabel="All"
            >
              All
            </RelationshipFilterItem>
            {filters.map((filter) => (
              <RelationshipFilterItem
                key={filter.kind}
                value={filter.kind}
                agentId={`relationships-kind-${filter.kind}`}
                agentLabel={filter.label}
              >
                {filter.label}
              </RelationshipFilterItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EntityNodeBlock({
  node,
  onAction,
}: {
  node: EntityNode;
  onAction?: (action: string) => void;
}) {
  const action = `open:${node.id}`;
  return (
    <div className="min-w-0 py-3" data-agent-id={`rel-${node.id}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-txt">
            {node.name}
          </div>
          {node.identityLine ? (
            <div className="mt-0.5 truncate text-xs text-muted">
              {node.identityLine}
            </div>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-muted">{node.kindLabel}</span>
        <RelationshipActionButton
          variant="ghost"
          size="icon-sm"
          aria-label={`Open ${node.name}`}
          agentId={`open-${node.id}`}
          agentLabel={`Open ${node.name}`}
          onAgentActivate={() => onAction?.(action)}
          onClick={() => onAction?.(action)}
        >
          ›
        </RelationshipActionButton>
      </div>
      {node.edges.length > 0
        ? node.edges.map((edge) => (
            <div
              key={edge.id}
              className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 pl-1 text-xs"
            >
              <span aria-hidden="true" className="text-muted">
                ↳
              </span>
              <div className="min-w-0">
                <div className="truncate text-muted-strong">{edge.toName}</div>
                <div className="truncate text-muted">{edge.meta}</div>
              </div>
            </div>
          ))
        : null}
    </div>
  );
}
