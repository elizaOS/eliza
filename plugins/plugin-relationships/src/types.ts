/**
 * Public TS types for `@elizaos/plugin-relationships`.
 *
 * These mirror the canonical LifeOps shapes in
 * `plugins/plugin-lifeops/src/lifeops/entities/types.ts` and
 * `plugins/plugin-lifeops/src/lifeops/relationships/types.ts`. The richer
 * lifeops shapes (identities array, attributes map, retired status, sentiment
 * trend, type registries) will be ported here in a follow-up pass; for now we
 * expose the minimal Entity / Relationship surface that matches the DB schema
 * in `db/schema.ts`.
 */

export const RELATIONSHIPS_LOG_PREFIX = "[Relationships]";
export const RELATIONSHIPS_SERVICE_TYPE = "relationships";

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
 * `plugins/plugin-lifeops/src/actions/entity.ts`.
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
