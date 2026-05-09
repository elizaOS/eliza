/**
 * Entity types for the LifeOps knowledge graph.
 *
 * An Entity is a node — a person, organization, place, project, or concept —
 * with per-connector identities and open-keyed extracted attributes. The user
 * is the special `self` Entity. See docs/audit/wave1-interfaces.md §2.1 and
 * docs/audit/GAP_ASSESSMENT.md §3.4 for the full design rationale.
 *
 * Frozen-shape contract: shapes here match `wave1-interfaces.md §2.1`
 * verbatim. The cross-package contract `LifeOpsEntity` in
 * `@elizaos/shared/contracts/lifeops` mirrors them.
 */

/**
 * Built-in entity types. The registry accepts any string, but these are the
 * shapes the runtime understands without registration. Open string with
 * registered metadata via {@link EntityTypeRegistry}.
 */
export const BUILT_IN_ENTITY_TYPES = [
  "person",
  "organization",
  "place",
  "project",
  "concept",
] as const;

export type BuiltInEntityType = (typeof BUILT_IN_ENTITY_TYPES)[number];

/**
 * The identifier of the `self` Entity. Bootstrapped on first store init.
 * All ego-network edges originate from `self`.
 */
export const SELF_ENTITY_ID = "self";

export type EntityIdentityAddedVia =
  | "user_chat"
  | "merge"
  | "platform_observation"
  | "extraction"
  | "import";

export type EntityVisibility =
  | "owner_only"
  | "agent_and_admin"
  | "owner_agent_admin";

/**
 * Per-connector identity claim. An Entity carries N of these — one per
 * platform handle the runtime has observed or imported. Identity merge
 * collapses two entities when (platform, handle) match and confidence
 * thresholds align.
 */
export interface EntityIdentity {
  platform: string;
  handle: string;
  displayName?: string;
  /** Operator-confirmed (true) vs auto-merged / observed (false). */
  verified: boolean;
  /** 0..1 confidence in this identity claim. */
  confidence: number;
  addedAt: string;
  addedVia: EntityIdentityAddedVia;
  /** Observation ids contributing evidence for this identity. */
  evidence: string[];
}

/**
 * Open-keyed extracted attribute (location, employer, role, birthday, ...).
 * The runtime does not branch on attribute keys; the only structural
 * commitment is "value + provenance + freshness".
 */
export interface EntityAttribute {
  value: unknown;
  /** 0..1 confidence in the current value. */
  confidence: number;
  evidence: string[];
  updatedAt: string;
}

/**
 * Per-Entity interaction state (last-observed-at, last-inbound-at, etc.).
 * Distinct from {@link RelationshipState} — Entity state is "what platform
 * carried the most recent interaction"; Relationship state is "what was the
 * last interaction on this specific edge".
 */
export interface EntityState {
  lastObservedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastInteractionPlatform?: string;
}

/**
 * The canonical Entity shape. Stored in `app_lifeops.life_entities` and
 * paired with rows in `life_entity_identities` and `life_entity_attributes`.
 */
export interface Entity {
  entityId: string;
  type: string;
  preferredName: string;
  fullName?: string;
  identities: EntityIdentity[];
  attributes?: Record<string, EntityAttribute>;
  state: EntityState;
  tags: string[];
  visibility: EntityVisibility;
  createdAt: string;
  updatedAt: string;
}

/**
 * Filter for {@link EntityStore.list}. All fields are optional and
 * AND-combined.
 */
export interface EntityFilter {
  type?: string;
  tag?: string;
  /** Substring match against `preferredName` and `fullName`, case-insensitive. */
  nameContains?: string;
  /** Match entities that have an identity on this platform. */
  hasPlatform?: string;
  limit?: number;
}

/**
 * Result of {@link EntityStore.resolve}: a single entity candidate with the
 * confidence that the query refers to this entity. `safeToSend` is `true`
 * when the entity has at least one verified identity on a sendable platform
 * — this is what the planner reads before dispatching outbound messages.
 */
export interface EntityResolveCandidate {
  entity: Entity;
  confidence: number;
  evidence: string[];
  safeToSend: boolean;
}

/**
 * Open-string registry of entity types. Built-ins always validate; new types
 * are registered with optional metadata (display label, default visibility).
 *
 * Registration is idempotent (re-registering the same key with the same
 * metadata is a no-op). Conflicting metadata throws.
 */
export class EntityTypeRegistry {
  private readonly registered = new Map<
    string,
    { label: string; defaultVisibility: EntityVisibility }
  >();

  constructor() {
    for (const type of BUILT_IN_ENTITY_TYPES) {
      this.registered.set(type, {
        label: type,
        defaultVisibility: "owner_agent_admin",
      });
    }
  }

  register(
    type: string,
    metadata: { label?: string; defaultVisibility?: EntityVisibility } = {},
  ): void {
    const next = {
      label: metadata.label ?? type,
      defaultVisibility: metadata.defaultVisibility ?? "owner_agent_admin",
    };
    const existing = this.registered.get(type);
    if (existing) {
      if (
        existing.label !== next.label ||
        existing.defaultVisibility !== next.defaultVisibility
      ) {
        throw new Error(
          `[EntityTypeRegistry] type "${type}" already registered with different metadata`,
        );
      }
      return;
    }
    this.registered.set(type, next);
  }

  has(type: string): boolean {
    return this.registered.has(type);
  }

  list(): string[] {
    return Array.from(this.registered.keys()).sort();
  }

  metadataFor(
    type: string,
  ): { label: string; defaultVisibility: EntityVisibility } | null {
    return this.registered.get(type) ?? null;
  }
}

/**
 * Shared default registry instance. Tests construct their own.
 */
export const defaultEntityTypeRegistry = new EntityTypeRegistry();
