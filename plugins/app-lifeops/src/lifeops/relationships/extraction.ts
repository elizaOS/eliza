/**
 * Extraction helpers — the canonical entry point for "ingest this
 * observation into the graph". Tests verify these produce both nodes
 * and edges.
 *
 * Take an observation tuple ("Pat is my manager at Acme") and produce a
 * pair of (entities, edges) writes that the planner can apply
 * atomically. All writes carry full provenance (the source utterance is
 * the evidence id).
 */

import type { Entity } from "../entities/types.js";
import { SELF_ENTITY_ID } from "../entities/types.js";
import type { EntityStore } from "../entities/store.js";
import type { RelationshipStore } from "./store.js";
import type { Relationship, RelationshipSource } from "./types.js";

/**
 * High-level extracted edge. The planner / chat ingest produces these
 * from natural-language observations; the runtime applies them via
 * `applyExtractedEdges`.
 */
export interface ExtractedEdge {
  fromRef: ExtractedEntityRef;
  toRef: ExtractedEntityRef;
  type: string;
  metadata?: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedEntityRef {
  /** `"self"`, an existing entityId, or a name to resolve. */
  id?: string;
  name?: string;
  type?: string;
  /** Identity hints to disambiguate same-named entities. */
  identity?: { platform: string; handle: string };
}

export interface ExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
  /** Evidence-id → list of (entityId, relationshipId) it touched. */
  provenance: Record<string, { entityIds: string[]; relationshipIds: string[] }>;
}

/**
 * Apply a batch of extracted edges. Resolves each entity ref to a
 * concrete Entity (creating it if needed), then strengthens or creates
 * each edge via `RelationshipStore.observe`.
 *
 * Always idempotent across re-runs of the same evidence id.
 */
export async function applyExtractedEdges(args: {
  entityStore: EntityStore;
  relationshipStore: RelationshipStore;
  evidenceId: string;
  edges: ExtractedEdge[];
  source?: RelationshipSource;
}): Promise<ExtractionResult> {
  const resolved = new Map<string, Entity>();
  const provenance: Record<string, { entityIds: string[]; relationshipIds: string[] }> =
    {
      [args.evidenceId]: { entityIds: [], relationshipIds: [] },
    };

  // First, resolve every entity reference. Cache by canonical key so
  // multiple edges on the same entity reuse the same row.
  const refKey = (ref: ExtractedEntityRef): string => {
    if (ref.id) return `id:${ref.id}`;
    if (ref.identity) {
      return `id_${ref.identity.platform}:${ref.identity.handle}`;
    }
    if (ref.name) return `name:${ref.name.toLowerCase()}|type:${ref.type ?? "person"}`;
    return "unknown";
  };

  const resolveRef = async (ref: ExtractedEntityRef): Promise<Entity> => {
    const key = refKey(ref);
    const cached = resolved.get(key);
    if (cached) return cached;

    if (ref.id === SELF_ENTITY_ID) {
      const self = await args.entityStore.ensureSelf();
      resolved.set(key, self);
      return self;
    }

    if (ref.id) {
      const existing = await args.entityStore.get(ref.id);
      if (!existing) {
        throw new Error(
          `[applyExtractedEdges] entity id "${ref.id}" not found`,
        );
      }
      resolved.set(key, existing);
      return existing;
    }

    if (ref.identity) {
      const candidates = await args.entityStore.resolve({
        identity: ref.identity,
        type: ref.type ?? "person",
      });
      const first = candidates[0];
      if (first) {
        resolved.set(key, first.entity);
        return first.entity;
      }
      // Create via observeIdentity so identity-merge logic runs.
      const result = await args.entityStore.observeIdentity({
        platform: ref.identity.platform,
        handle: ref.identity.handle,
        ...(ref.name ? { displayName: ref.name } : {}),
        evidence: [args.evidenceId],
        confidence: 0.7,
        suggestedType: ref.type ?? "person",
      });
      resolved.set(key, result.entity);
      return result.entity;
    }

    if (ref.name) {
      const candidates = await args.entityStore.resolve({
        name: ref.name,
        type: ref.type ?? "person",
      });
      const exact = candidates.find(
        (c) => c.entity.preferredName.toLowerCase() === ref.name?.toLowerCase(),
      );
      if (exact) {
        resolved.set(key, exact.entity);
        return exact.entity;
      }
      const created = await args.entityStore.upsert({
        type: ref.type ?? "person",
        preferredName: ref.name,
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      });
      resolved.set(key, created);
      return created;
    }

    throw new Error("[applyExtractedEdges] entity ref has no identity, id, or name");
  };

  // Resolve all refs first so we know the entities involved.
  const edgePairs: Array<{ from: Entity; to: Entity; edge: ExtractedEdge }> = [];
  for (const edge of args.edges) {
    const from = await resolveRef(edge.fromRef);
    const to = await resolveRef(edge.toRef);
    edgePairs.push({ from, to, edge });
    provenance[args.evidenceId]?.entityIds.push(from.entityId, to.entityId);
  }

  // Then apply each edge via observe (strengthen or create).
  const relationships: Relationship[] = [];
  for (const { from, to, edge } of edgePairs) {
    const relationship = await args.relationshipStore.observe({
      fromEntityId: from.entityId,
      toEntityId: to.entityId,
      type: edge.type,
      ...(edge.metadata ? { metadataPatch: edge.metadata } : {}),
      evidence: [args.evidenceId],
      confidence: edge.confidence,
      source: args.source ?? "extraction",
    });
    relationships.push(relationship);
    provenance[args.evidenceId]?.relationshipIds.push(relationship.relationshipId);
  }

  // Dedupe entities returned (resolveRef may map to the same entity).
  const entityMap = new Map<string, Entity>();
  for (const entity of resolved.values()) {
    entityMap.set(entity.entityId, entity);
  }

  return {
    entities: Array.from(entityMap.values()),
    relationships,
    provenance,
  };
}

/**
 * Convenience: parse a "X is my <role> at Y" statement into 2 entities +
 * 3 edges. This is one canonical pattern; richer NL parsing lives in the
 * planner. Returns the structured `ExtractedEdge[]` ready for
 * `applyExtractedEdges`.
 *
 * Example: managerOfAtCompany("Pat", "Acme") →
 *   - self → Pat: managed_by
 *   - self → Acme: works_at
 *   - Pat → Acme: works_at
 */
export function managerOfAtCompany(
  managerName: string,
  companyName: string,
  options: { confidence?: number; managerRole?: string; selfRole?: string } = {},
): ExtractedEdge[] {
  const confidence = options.confidence ?? 0.85;
  return [
    {
      fromRef: { id: SELF_ENTITY_ID },
      toRef: { name: managerName, type: "person" },
      type: "managed_by",
      ...(options.managerRole ? { metadata: { role: options.managerRole } } : {}),
      confidence,
    },
    {
      fromRef: { id: SELF_ENTITY_ID },
      toRef: { name: companyName, type: "organization" },
      type: "works_at",
      ...(options.selfRole ? { metadata: { role: options.selfRole } } : {}),
      confidence,
    },
    {
      fromRef: { name: managerName, type: "person" },
      toRef: { name: companyName, type: "organization" },
      type: "works_at",
      ...(options.managerRole ? { metadata: { role: options.managerRole } } : {}),
      confidence,
    },
  ];
}
