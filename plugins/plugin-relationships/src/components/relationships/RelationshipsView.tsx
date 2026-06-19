/**
 * RelationshipsView — the entity / relationship knowledge-graph VIEWER.
 *
 * Data-fetching view over the two read-only graph endpoints served by the
 * personal-assistant routes (the runtime owns the EntityStore /
 * RelationshipStore persistence; this plugin only renders):
 *   GET {base}/api/lifeops/entities       -> { entities: EntityWire[] }
 *   GET {base}/api/lifeops/relationships   -> { relationships: RelationshipWire[] }
 *
 * It joins the two payloads into a per-entity projection (each entity with its
 * outbound edges) at the fetch boundary, then renders display-only. The view
 * has four distinct states (loading, error, empty, populated) and instruments
 * its refresh + entity-kind filter controls through the agent surface so the
 * floating chat can drive them. The default fetcher builds its URL from
 * `client.getBaseUrl()`; tests inject the fetcher seam so they stay offline.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits
 * (Entity / Relationship in plugin-personal-assistant/src/lifeops/{entities,relationships}/types.ts).
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ENTITY_KIND_FILTERS,
  ENTITY_KIND_LABELS,
  type EntityKindFilter,
  type EntityNodeItem,
  type RelationshipEdgeItem,
} from "../../types.ts";

// ---------------------------------------------------------------------------
// Wire DTOs — local mirror of the JSON shapes served by the PA graph routes.
// Never import PA types here; keep this view's contract self-contained and
// aligned by shape.
// ---------------------------------------------------------------------------

interface EntityIdentityWire {
  platform: string;
  handle: string;
  displayName?: string;
  verified: boolean;
  confidence: number;
}

interface EntityWire {
  entityId: string;
  type: string;
  preferredName: string;
  fullName?: string;
  identities: EntityIdentityWire[];
}

interface EntitiesWire {
  entities: EntityWire[];
}

interface RelationshipStateWire {
  lastObservedAt?: string;
  lastInteractionAt?: string;
}

interface RelationshipWire {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  metadata?: Record<string, unknown>;
  state: RelationshipStateWire;
}

interface RelationshipsWire {
  relationships: RelationshipWire[];
}

// ---------------------------------------------------------------------------
// Fetcher seam — default to two real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface RelationshipsFetchers {
  fetchEntities: () => Promise<EntitiesWire>;
  fetchRelationships: () => Promise<RelationshipsWire>;
}

async function getEntities(): Promise<EntitiesWire> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/entities`);
  if (!response.ok) {
    throw new Error(`Entities request failed (${response.status})`);
  }
  return (await response.json()) as EntitiesWire;
}

async function getRelationships(): Promise<RelationshipsWire> {
  const response = await fetch(
    `${client.getBaseUrl()}/api/lifeops/relationships`,
  );
  if (!response.ok) {
    throw new Error(`Relationships request failed (${response.status})`);
  }
  return (await response.json()) as RelationshipsWire;
}

const defaultFetchers: RelationshipsFetchers = {
  fetchEntities: getEntities,
  fetchRelationships: getRelationships,
};

export interface RelationshipsViewProps {
  /** Owner display name. Accepted for host compatibility; not rendered. */
  ownerName?: string;
  /** Test/host injection seam. Defaults to the real graph GETs. */
  fetchers?: RelationshipsFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping.
// ---------------------------------------------------------------------------

/** Read the per-edge cadence override (`metadata.cadenceDays`) when present. */
function readCadenceDays(
  metadata: Record<string, unknown> | undefined,
): number | null {
  const value = metadata?.cadenceDays;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * The last interaction on an edge is the most recent of its two timestamps;
 * `lastInteractionAt` is the canonical contact, `lastObservedAt` the fallback.
 */
function readLastContact(state: RelationshipStateWire): string | null {
  return state.lastInteractionAt ?? state.lastObservedAt ?? null;
}

function mapEdge(
  relationship: RelationshipWire,
  nameById: ReadonlyMap<string, string>,
): RelationshipEdgeItem {
  return {
    id: relationship.relationshipId,
    type: relationship.type,
    toName: nameById.get(relationship.toEntityId) ?? relationship.toEntityId,
    cadenceDays: readCadenceDays(relationship.metadata),
    lastContact: readLastContact(relationship.state),
  };
}

/**
 * Join the entity list with their outbound edges into per-entity nodes. The
 * server returns the full graph; this is a presentation-only fold.
 */
function buildNodes(
  entities: EntityWire[],
  relationships: RelationshipWire[],
): EntityNodeItem[] {
  const nameById = new Map<string, string>(
    entities.map((entity) => [entity.entityId, entity.preferredName]),
  );
  const edgesByFrom = new Map<string, RelationshipEdgeItem[]>();
  for (const relationship of relationships) {
    const edge = mapEdge(relationship, nameById);
    const existing = edgesByFrom.get(relationship.fromEntityId);
    if (existing) existing.push(edge);
    else edgesByFrom.set(relationship.fromEntityId, [edge]);
  }
  return entities.map((entity) => ({
    id: entity.entityId,
    kind: entity.type,
    name: entity.preferredName,
    identities: entity.identities.map((identity) => ({
      platform: identity.platform,
      handle: identity.handle,
      verified: identity.verified,
    })),
    edges: edgesByFrom.get(entity.entityId) ?? [],
  }));
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Build the meta line for an edge: type · cadence · last-contact. */
function edgeMeta(edge: RelationshipEdgeItem): string {
  const parts: string[] = [edge.type];
  if (edge.cadenceDays !== null) parts.push(`every ${edge.cadenceDays}d`);
  if (edge.lastContact) parts.push(`last ${formatDate(edge.lastContact)}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Styling — dark theme, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "relationships-view-styles";

const RELATIONSHIPS_VIEW_CSS = `
.relationships-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.relationships-view-btn-primary {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border: 1px solid var(--primary, #ff6a00);
}
.relationships-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
.relationships-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.relationships-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.relationships-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.relationships-view-chip {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.relationships-view-chip:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.relationships-view-chip[aria-pressed="true"] {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border-color: var(--primary, #ff6a00);
}
.relationships-view-chip[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
`;

function useRelationshipsViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = RELATIONSHIPS_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "var(--background, #0a0a0a)",
  color: "var(--foreground, #f5f5f5)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };

const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "var(--surface, rgba(255,255,255,0.02))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

const edgeRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
  fontSize: 14,
};

const edgeMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const nameStyle: CSSProperties = { fontWeight: 600 };

const metaStyle: CSSProperties = {
  ...dimStyle,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const kindBadgeStyle: CSSProperties = {
  color: "var(--primary, #ff6a00)",
  fontSize: 12,
  fontWeight: 600,
};

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function RefreshButton({
  onActivate,
  disabled,
}: {
  onActivate: () => void;
  disabled: boolean;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "relationships-refresh",
    role: "button",
    label: "Refresh relationships",
    group: "relationships-toolbar",
    description: "Reload the owner's entities and relationship edges",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="relationships-view-btn relationships-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh"
      {...agentProps}
    >
      <RefreshIcon />
    </button>
  );
}

/** Inline refresh glyph (no icon-package dependency in this plugin). */
function RefreshIcon(): ReactNode {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function KindChip({
  kind,
  label,
  active,
  onToggle,
}: {
  kind: EntityKindFilter;
  label: string;
  active: boolean;
  onToggle: (kind: EntityKindFilter) => void;
}): ReactNode {
  const activate = useCallback(() => onToggle(kind), [kind, onToggle]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `relationships-kind-${kind}`,
    role: "toggle",
    label: `${label} kind filter`,
    group: "relationships-kind-filters",
    description: `Show only ${label} in the relationships graph`,
    status: active ? "active" : "inactive",
    onActivate: activate,
  });
  return (
    // The visible label IS the accessible name (no aria-label) so command->view
    // routing can address the chip by its kind name (e.g. "People").
    <button
      ref={ref}
      type="button"
      className="relationships-view-chip"
      onClick={activate}
      aria-pressed={active}
      {...agentProps}
    >
      {label}
    </button>
  );
}

function RelationshipsHeader({
  refetch,
  busy,
}: {
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Relationships</h1>
        <RefreshButton onActivate={refetch} disabled={busy} />
      </div>
    </header>
  );
}

function KindFilters({
  active,
  onToggle,
}: {
  active: ReadonlySet<EntityKindFilter>;
  onToggle: (kind: EntityKindFilter) => void;
}): ReactNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an ARIA group of filter-chip toggles, not a form fieldset
    <div
      role="group"
      aria-label="Entity kind filters"
      style={chipRowStyle}
      data-testid="relationships-kind-filters"
    >
      {ENTITY_KIND_FILTERS.map((kind) => (
        <KindChip
          key={kind}
          kind={kind}
          label={ENTITY_KIND_LABELS[kind] ?? kind}
          active={active.has(kind)}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function EdgeRow({ edge }: { edge: RelationshipEdgeItem }): ReactNode {
  return (
    <li style={edgeRowStyle}>
      <span style={edgeMainStyle}>
        <span style={nameStyle}>{edge.toName}</span>
      </span>
      <span style={metaStyle}>{edgeMeta(edge)}</span>
    </li>
  );
}

function EntityCard({ node }: { node: EntityNodeItem }): ReactNode {
  const identityLine =
    node.identities.length > 0
      ? node.identities
          .map((identity) => `${identity.platform}:${identity.handle}`)
          .join(" · ")
      : null;
  return (
    <div style={cardStyle} data-testid={`relationships-entity-${node.id}`}>
      <div style={headerRowStyle}>
        <h2 style={h2Style}>{node.name}</h2>
        <span style={kindBadgeStyle}>
          {ENTITY_KIND_LABELS[node.kind] ?? node.kind}
        </span>
      </div>
      {identityLine ? <div style={dimStyle}>{identityLine}</div> : null}
      {node.edges.length > 0 ? (
        <ul style={listStyle} aria-label={`${node.name} relationships`}>
          {node.edges.map((edge) => (
            <EdgeRow key={edge.id} edge={edge} />
          ))}
        </ul>
      ) : (
        <div style={dimStyle}>No relationships recorded yet.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; nodes: EntityNodeItem[] };

function requestAddPerson(): void {
  client.sendChatMessage?.(
    "Add someone to my relationships graph — tell me who you'd like to remember.",
  );
}

export function RelationshipsView(
  props: RelationshipsViewProps = {},
): ReactNode {
  useRelationshipsViewStyles();

  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeKinds, setActiveKinds] = useState<Set<EntityKindFilter>>(
    () => new Set<EntityKindFilter>(),
  );

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      fetchersRef.current.fetchEntities(),
      fetchersRef.current.fetchRelationships(),
    ])
      .then(([entitiesWire, relationshipsWire]) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          nodes: buildNodes(
            entitiesWire.entities,
            relationshipsWire.relationships,
          ),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load relationships.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const toggleKind = useCallback((kind: EntityKindFilter) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  // Filtering is presentation-only (the routes return the full graph), so it
  // derives from the ready nodes + active selection. The active set is the
  // single source of truth, so the chips and the rendered cards never disagree.
  const visibleNodes = useMemo(() => {
    if (state.kind !== "ready") return [];
    if (activeKinds.size === 0) return state.nodes;
    return state.nodes.filter((node) =>
      activeKinds.has(node.kind as EntityKindFilter),
    );
  }, [state, activeKinds]);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="relationships-loading">
        <RelationshipsHeader refetch={load} busy={true} />
        <KindFilters active={activeKinds} onToggle={toggleKind} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading relationships…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="relationships-error">
        <RelationshipsHeader refetch={load} busy={false} />
        <KindFilters active={activeKinds} onToggle={toggleKind} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load relationships</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="relationships-view-btn relationships-view-btn-primary"
              onClick={load}
              aria-label="Retry loading relationships"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Fetched OK but the graph is empty → honest add-a-person affordance routed
  // through the assistant chat. No fabricated people or edges.
  if (state.nodes.length === 0) {
    return (
      <div style={containerStyle} data-testid="relationships-empty">
        <RelationshipsHeader refetch={load} busy={false} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No people or relationships yet</div>
          <div style={dimStyle}>
            Eliza hasn’t learned about anyone in your network yet. Tell her
            about the people and organizations you work with and she’ll start
            mapping the relationships.
          </div>
          <div>
            <button
              type="button"
              className="relationships-view-btn relationships-view-btn-primary"
              onClick={requestAddPerson}
              aria-label="Ask Eliza to add someone"
            >
              Add someone
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="relationships-populated">
      <RelationshipsHeader refetch={load} busy={false} />
      <KindFilters active={activeKinds} onToggle={toggleKind} />
      {visibleNodes.length > 0 ? (
        <section style={sectionStyle} aria-label="Relationships graph">
          {visibleNodes.map((node) => (
            <EntityCard key={node.id} node={node} />
          ))}
        </section>
      ) : (
        <div style={{ ...cardStyle, ...dimStyle }}>
          No entities match the selected kind filters.
        </div>
      )}
    </div>
  );
}

export default RelationshipsView;
