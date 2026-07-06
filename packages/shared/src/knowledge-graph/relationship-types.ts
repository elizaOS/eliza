/**
 * Relationship types for the knowledge graph (canonical, runtime-level).
 *
 * A Relationship is a typed edge between two Entities, carrying its own
 * metadata (cadence, role, sentiment) and state (last-interaction, count,
 * sentiment trend). Each edge has its own provenance trail.
 *
 * Canonical home: `@elizaos/shared`. The DB-backed `RelationshipStore` lives in
 * `@elizaos/plugin-personal-assistant`; the `LifeOpsGraphRelationship` wire
 * contract in `@elizaos/shared/contracts/personal-assistant` re-exports these
 * shapes.
 */

/**
 * Built-in relationship types. The registry accepts any string, but these
 * are the shapes the planner / followup-watcher / extraction know about
 * without registration.
 */
export const BUILT_IN_RELATIONSHIP_TYPES = [
  "follows",
  "colleague_of",
  "friend_of",
  "family_of",
  "partner_of",
  "ex_partner_of",
  "co_parent_of",
  "manages",
  "managed_by",
  "lives_at",
  "works_at",
  "knows",
  "owns",
] as const;

export type BuiltInRelationshipType =
  (typeof BUILT_IN_RELATIONSHIP_TYPES)[number];

export type RelationshipSource =
  | "user_chat"
  | "platform_observation"
  | "extraction"
  | "import"
  | "system";

export type RelationshipSentiment = "positive" | "neutral" | "negative";

export type RelationshipStatus = "active" | "retired";

/**
 * Per-edge interaction state. Distinct from `Entity.state` — this is the
 * cadence + last-interaction tied to a specific (from, to, type) triple.
 * The cadence override (`metadata.cadenceDays`) lives on the edge so that
 * "Pat as colleague" and "Pat as friend" can have separate follow-up
 * cadences against the same person.
 */
export interface RelationshipState {
  lastObservedAt?: string;
  lastInteractionAt?: string;
  interactionCount?: number;
  sentimentTrend?: RelationshipSentiment;
}

/**
 * The canonical Relationship shape. A typed edge from `fromEntityId` to
 * `toEntityId`; the user is `entityId === "self"` for ego-network edges.
 */
export interface Relationship {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  /**
   * Per-type metadata. Examples:
   *   - `{ cadenceDays: 14 }` for `follows`
   *   - `{ role: "engineer" }` for `works_at`
   *   - `{ sinceDate: "2020-01-01" }` for `partner_of`
   */
  metadata?: Record<string, unknown>;
  state: RelationshipState;
  evidence: string[];
  /** 0..1 confidence in the edge. */
  confidence: number;
  source: RelationshipSource;
  /**
   * Soft-delete state. Retired edges remain queryable for audit but are
   * filtered out of `list()` by default and never strengthened by new
   * observations — new evidence on a retired edge is logged but does NOT
   * flip it back to active.
   */
  status: RelationshipStatus;
  retiredAt?: string;
  retiredReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Filter for `RelationshipStore.list`. All fields optional, AND-combined.
 */
export interface RelationshipFilter {
  fromEntityId?: string;
  toEntityId?: string;
  type?: string | string[];
  metadataMatch?: Record<string, unknown>;
  /**
   * Returns edges where `metadata.cadenceDays` exists AND
   * `state.lastInteractionAt < (asOf - cadenceDays)`. Read by the
   * followup-starter watcher (W1-D).
   */
  cadenceOverdueAsOf?: string;
  /** Include retired edges. Default false. */
  includeRetired?: boolean;
  limit?: number;
}

/**
 * Open-string registry for relationship types. Built-ins always validate;
 * new types may register typed metadata schemas via {@link metadataKeys}.
 * The runtime does not branch on type — the registry is informational.
 */
export class RelationshipTypeRegistry {
  private readonly registered = new Map<
    string,
    { label: string; metadataKeys: string[]; symmetric: boolean }
  >();

  constructor() {
    // Built-ins with their canonical metadata shapes.
    this.registered.set("follows", {
      label: "follows",
      metadataKeys: ["cadenceDays"],
      symmetric: false,
    });
    this.registered.set("colleague_of", {
      label: "colleague of",
      metadataKeys: ["since", "team"],
      symmetric: true,
    });
    this.registered.set("friend_of", {
      label: "friend of",
      metadataKeys: ["since", "cadenceDays"],
      symmetric: true,
    });
    this.registered.set("family_of", {
      label: "family of",
      metadataKeys: ["role", "since", "cadenceDays"],
      symmetric: true,
    });
    this.registered.set("partner_of", {
      label: "partner of",
      metadataKeys: ["since"],
      symmetric: true,
    });
    this.registered.set("ex_partner_of", {
      label: "ex-partner of",
      metadataKeys: ["since", "endedAt"],
      symmetric: true,
    });
    this.registered.set("co_parent_of", {
      label: "co-parent of",
      metadataKeys: ["childId", "cadenceDays", "since"],
      symmetric: true,
    });
    this.registered.set("manages", {
      label: "manages",
      metadataKeys: ["since"],
      symmetric: false,
    });
    this.registered.set("managed_by", {
      label: "managed by",
      metadataKeys: ["since"],
      symmetric: false,
    });
    this.registered.set("lives_at", {
      label: "lives at",
      metadataKeys: ["since"],
      symmetric: false,
    });
    this.registered.set("works_at", {
      label: "works at",
      metadataKeys: ["role", "since"],
      symmetric: false,
    });
    this.registered.set("knows", {
      label: "knows",
      metadataKeys: [],
      symmetric: true,
    });
    this.registered.set("owns", {
      label: "owns",
      metadataKeys: ["since"],
      symmetric: false,
    });
  }

  register(
    type: string,
    metadata: {
      label?: string;
      metadataKeys?: string[];
      symmetric?: boolean;
    } = {},
  ): void {
    const next = {
      label: metadata.label ?? type,
      metadataKeys: metadata.metadataKeys ?? [],
      symmetric: metadata.symmetric ?? false,
    };
    const existing = this.registered.get(type);
    if (existing) {
      const sameKeys =
        existing.metadataKeys.length === next.metadataKeys.length &&
        existing.metadataKeys.every(
          (key, idx) => key === next.metadataKeys[idx],
        );
      if (
        existing.label !== next.label ||
        existing.symmetric !== next.symmetric ||
        !sameKeys
      ) {
        throw new Error(
          `[RelationshipTypeRegistry] type "${type}" already registered with different metadata`,
        );
      }
      return;
    }
    this.registered.set(type, next);
  }

  has(type: string): boolean {
    return this.registered.has(type);
  }

  isSymmetric(type: string): boolean {
    return this.registered.get(type)?.symmetric ?? false;
  }

  list(): string[] {
    return Array.from(this.registered.keys()).sort();
  }
}

export const defaultRelationshipTypeRegistry = new RelationshipTypeRegistry();
