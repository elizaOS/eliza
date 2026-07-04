/**
 * Public TS types for `@elizaos/plugin-relationships`.
 *
 * These mirror the canonical LifeOps shapes in
 * `plugins/plugin-personal-assistant/src/lifeops/entities/types.ts` and
 * `plugins/plugin-personal-assistant/src/lifeops/relationships/types.ts`. This
 * module exposes the minimal Entity / Relationship surface that matches the DB
 * schema in `db/schema.ts`; the richer lifeops shapes (identities array,
 * attributes map, retired status, sentiment trend, type registries) live only
 * in plugin-personal-assistant and are not mirrored here.
 */

export const RELATIONSHIPS_LOG_PREFIX = "[Relationships]";
export const RELATIONSHIPS_SERVICE_TYPE = "relationships";

/**
 * Action name for the relationships graph-CRUD umbrella.
 *
 * NOT `ENTITY`. `@elizaos/plugin-personal-assistant` already registers an
 * `ENTITY` action: a rich orchestration over the legacy Rolodex contact model
 * (`LifeOpsService.listRelationships/upsertRelationship/logInteraction`) with
 * an LLM planner and voice-grounded replies. That action stays in PA. This
 * action is the thin "extras" surface — direct CRUD over the runtime
 * {@link KNOWLEDGE_GRAPH_SERVICE} graph that powers the relationships viewer —
 * so it is registered under a distinct name to avoid a duplicate `ENTITY`
 * registration when both plugins load together.
 */
export const RELATIONSHIPS_ACTION_NAME = "KNOWLEDGE_GRAPH";

export const RELATIONSHIPS_CONTEXTS = [
  "people",
  "contacts",
  "relationships",
] as const;
export type RelationshipsContext = (typeof RELATIONSHIPS_CONTEXTS)[number];

/**
 * Built-in entity kinds. The store accepts any string, but these are what the
 * runtime understands without registration. Mirrors
 * `BUILT_IN_ENTITY_TYPES` in lifeops.
 */
export const BUILT_IN_ENTITY_KINDS = [
  "person",
  "organization",
  "place",
  "project",
  "concept",
] as const;
export type BuiltInEntityKind = (typeof BUILT_IN_ENTITY_KINDS)[number];

/**
 * Identifier of the `self` Entity — the agent's owner. All ego-network edges
 * originate from `self`. Bootstrapped on first store init.
 */
export const SELF_ENTITY_ID = "self";

/**
 * Canonical entity-kind / op tuple accepted by the `ENTITY` action.
 *
 * Mirrors the `Subaction` union in
 * `plugins/plugin-personal-assistant/src/actions/entity.ts`.
 */
export const ENTITY_OPS = [
  "create",
  "read",
  "list",
  "log_interaction",
  "set_identity",
  "set_relationship",
  "merge",
] as const;
export type EntityOp = (typeof ENTITY_OPS)[number];

/**
 * Minimal Entity shape. The full LifeOps `Entity` (see
 * `lifeops/entities/types.ts`) carries `identities[]`, `attributes`, `state`,
 * `tags`, and `visibility`. Those land in a follow-up port.
 */
export interface Entity {
  id: string;
  kind: string;
  displayName: string;
  attrs: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Relationship shape. The full LifeOps `Relationship` (see
 * `lifeops/relationships/types.ts`) carries `type`, `metadata`, `state`,
 * `evidence[]`, `confidence`, `source`, and `status` (active / retired).
 */
export interface Relationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
  attrs: Record<string, unknown>;
  lastObservedAt: Date | null;
}

/**
 * Filter shape for listing entities. AND-combined.
 */
export interface EntityFilter {
  kind?: string;
  nameContains?: string;
  limit?: number;
}

/**
 * Filter shape for listing relationships. AND-combined.
 */
export interface RelationshipFilter {
  fromEntityId?: string;
  toEntityId?: string;
  kind?: string | string[];
  limit?: number;
}

// ---------------------------------------------------------------------------
// Display DTOs for the RelationshipsView.
//
// These are the flattened, display-only shapes the view renders after mapping
// the wire payloads served by the PA REST routes (GET /api/lifeops/entities and
// GET /api/lifeops/relationships). They live here — NOT imported from
// @elizaos/plugin-personal-assistant — so the view's contract stays
// self-contained and aligned by shape.
// ---------------------------------------------------------------------------

/**
 * The entity-kind filter set the view offers. Mirrors
 * {@link BUILT_IN_ENTITY_KINDS} with an `all` sentinel for "no filter".
 */
export const ENTITY_KIND_FILTERS = [
  "person",
  "organization",
  "place",
  "project",
  "concept",
] as const;
export type EntityKindFilter = (typeof ENTITY_KIND_FILTERS)[number];

/** Human labels for the built-in entity kinds shown in the view. */
export const ENTITY_KIND_LABELS: Record<string, string> = {
  person: "People",
  organization: "Organizations",
  place: "Places",
  project: "Projects",
  concept: "Concepts",
};

/**
 * A single identity claim shown under an entity (platform + handle). Flattened
 * from the wire `EntityIdentity`.
 */
export interface EntityIdentityItem {
  platform: string;
  handle: string;
  verified: boolean;
}

/**
 * A typed edge shown under its source entity. Flattened from the wire
 * `Relationship`: the edge's type label, the resolved target display name, and
 * the optional cadence / last-contact metadata the view surfaces.
 */
export interface RelationshipEdgeItem {
  id: string;
  type: string;
  /** Display name of the target entity, or the raw id when unresolved. */
  toName: string;
  /** Cadence in days from `metadata.cadenceDays`, when present. */
  cadenceDays: number | null;
  /** ISO timestamp of the last interaction/observation on this edge. */
  lastContact: string | null;
}

/**
 * An entity node as the view renders it: identity + kind + its outbound edges.
 */
export interface EntityNodeItem {
  id: string;
  kind: string;
  name: string;
  identities: EntityIdentityItem[];
  edges: RelationshipEdgeItem[];
}
