/** Relationships view: fetches scoped records and opens assistant requests in chat. */

import { client, dispatchChatPrefill } from "@elizaos/ui";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ENTITY_KIND_FILTERS, ENTITY_KIND_LABELS } from "../../types.ts";
import {
  EMPTY_RELATIONSHIPS,
  type EntityNode,
  type KindFilter,
  type RelationshipEdge,
  type RelationshipsSnapshot,
  RelationshipsSpatialView,
} from "./RelationshipsSpatialView.tsx";

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
  fetchEntities: (signal?: AbortSignal) => Promise<EntitiesWire>;
  fetchRelationships: (signal?: AbortSignal) => Promise<RelationshipsWire>;
}

/** Graph JSON GETs are short UI reads — same 15s family as DocumentsView / TodosView. */
export const RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS = 15_000;

async function getEntities(signal?: AbortSignal): Promise<EntitiesWire> {
  return client.fetch<EntitiesWire>(
    "/api/lifeops/entities",
    { method: "GET", signal },
    { timeoutMs: RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS },
  );
}

async function getRelationships(
  signal?: AbortSignal,
): Promise<RelationshipsWire> {
  return client.fetch<RelationshipsWire>(
    "/api/lifeops/relationships",
    { method: "GET", signal },
    { timeoutMs: RELATIONSHIPS_VIEW_JSON_TIMEOUT_MS },
  );
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
function edgeMeta(
  relationship: RelationshipWire,
  cadenceDays: number | null,
  lastContact: string | null,
): string {
  const parts: string[] = [relationship.type];
  if (cadenceDays !== null) parts.push(`every ${cadenceDays}d`);
  if (lastContact) parts.push(`last ${formatDate(lastContact)}`);
  return parts.join(" · ");
}

function mapEdge(
  relationship: RelationshipWire,
  nameById: ReadonlyMap<string, string>,
): RelationshipEdge {
  const cadenceDays = readCadenceDays(relationship.metadata);
  const lastContact = readLastContact(relationship.state);
  return {
    id: relationship.relationshipId,
    toName: nameById.get(relationship.toEntityId) ?? relationship.toEntityId,
    meta: edgeMeta(relationship, cadenceDays, lastContact),
  };
}

function identityLine(identities: EntityIdentityWire[]): string {
  return identities
    .map((identity) => `${identity.platform}:${identity.handle}`)
    .join(" · ");
}

/**
 * Join the entity list with their outbound edges into per-entity nodes. The
 * server returns the full graph; this is a presentation-only fold.
 */
function buildNodes(
  entities: EntityWire[],
  relationships: RelationshipWire[],
): EntityNode[] {
  const nameById = new Map<string, string>(
    entities.map((entity) => [entity.entityId, entity.preferredName]),
  );
  const edgesByFrom = new Map<string, RelationshipEdge[]>();
  for (const relationship of relationships) {
    const edge = mapEdge(relationship, nameById);
    const existing = edgesByFrom.get(relationship.fromEntityId);
    if (existing) existing.push(edge);
    else edgesByFrom.set(relationship.fromEntityId, [edge]);
  }
  return entities.map((entity) => ({
    id: entity.entityId,
    kind: entity.type,
    kindLabel: ENTITY_KIND_LABELS[entity.type] ?? entity.type,
    name: entity.preferredName,
    identityLine: identityLine(entity.identities),
    edges: edgesByFrom.get(entity.entityId) ?? [],
  }));
}

const KIND_FILTERS: KindFilter[] = ENTITY_KIND_FILTERS.map((kind) => ({
  kind,
  label: ENTITY_KIND_LABELS[kind] ?? kind,
}));

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

const RELATIONSHIPS_POLL_INTERVAL_MS = 20_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; nodes: EntityNode[] };

function requestAddPerson(): void {
  dispatchChatPrefill({
    text: "Add someone to my relationships graph — tell me who you'd like to remember.",
  });
}

function requestOpenEntity(entityId: string): void {
  dispatchChatPrefill({
    text: `Tell me about ${entityId} in my relationships graph.`,
  });
}

export function RelationshipsView(
  props: RelationshipsViewProps = {},
): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;
  const activeLoadRef = useRef<AbortController | null>(null);

  const load = useCallback((background = false) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    if (!background) setState({ kind: "loading" });
    Promise.all([
      fetchersRef.current.fetchEntities(controller.signal),
      fetchersRef.current.fetchRelationships(controller.signal),
    ])
      .then(([entitiesWire, relationshipsWire]) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "ready",
          nodes: buildNodes(
            entitiesWire.entities,
            relationshipsWire.relationships,
          ),
        });
      })
      // error-policy:J4 foreground failures render an error; background failures preserve last-good state.
      .catch((error: unknown) => {
        if (controller.signal.aborted || background) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load relationships.",
        });
      })
      .finally(() => {
        if (activeLoadRef.current === controller) activeLoadRef.current = null;
      });
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), RELATIONSHIPS_POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      activeLoadRef.current?.abort();
    };
  }, [load]);

  const snapshot = useMemo<RelationshipsSnapshot>(() => {
    if (state.kind === "loading") {
      return { ...EMPTY_RELATIONSHIPS, state: "loading" };
    }
    if (state.kind === "error") {
      return {
        state: "error",
        nodes: [],
        filters: KIND_FILTERS,
        error: state.message,
      };
    }
    if (state.nodes.length === 0) {
      return { state: "empty", nodes: [], filters: KIND_FILTERS };
    }
    return { state: "ready", nodes: state.nodes, filters: KIND_FILTERS };
  }, [state]);

  const onAction = useCallback(
    (action: string) => {
      if (action === "retry") {
        load();
        return;
      }
      if (action === "add") {
        requestAddPerson();
        return;
      }
      if (action.startsWith("open:")) {
        requestOpenEntity(action.slice("open:".length));
        return;
      }
    },
    [load],
  );

  return <RelationshipsSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default RelationshipsView;
