/**
 * Bidirectional mapping between the flat `LifeOpsRelationship` contact DTO and
 * the runtime knowledge graph (`EntityStore` person nodes + a single SELF→
 * contact `RelationshipStore` edge).
 *
 * The runtime graph is the **single source of truth** for contacts — there is
 * no separate `life_relationships` table. These helpers preserve the legacy
 * `LifeOpsRelationship` shape that the ENTITY action, scheduling, and check-in
 * consume, projected from / into the graph.
 */

import type {
  Entity,
  EntityAttribute,
  EntityIdentity,
  LifeOpsRelationship,
  Relationship,
} from "@elizaos/shared";

/** Tag marking a person entity that the owner explicitly added as a contact. */
export const LIFEOPS_CONTACT_TAG = "lifeops:contact";

/** System tag/attribute prefix; stripped from the user-facing `tags` array. */
const SYSTEM_PREFIX = "lifeops:";

const ATTR_PRIMARY_CHANNEL = "lifeops:primaryChannel";
const ATTR_PRIMARY_HANDLE = "lifeops:primaryHandle";
const ATTR_EMAIL = "lifeops:email";
const ATTR_PHONE = "lifeops:phone";
const ATTR_NOTES = "lifeops:notes";

/** Deterministic id for the single SELF→contact edge of a contact entity. */
export function contactEdgeId(entityId: string): string {
  return `lifeops-contact-${entityId}`;
}

/** Drop system-owned tags so the DTO only exposes user tags. */
export function userTags(tags: string[]): string[] {
  return tags.filter((tag) => !tag.startsWith(SYSTEM_PREFIX));
}

function attrString(entity: Entity, key: string): string | null {
  const value = entity.attributes?.[key]?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Most recent contact timestamp across entity + edge interaction state. */
export function lastContactedAtFromEntity(
  entity: Entity,
  edge: Relationship | null,
): string | null {
  return (
    entity.state.lastObservedAt ??
    entity.state.lastInboundAt ??
    entity.state.lastOutboundAt ??
    edge?.state.lastInteractionAt ??
    null
  );
}

/** Project a graph person entity (+ its contact edge) into the flat DTO. */
export function lifeOpsRelationshipFromEntity(
  agentId: string,
  entity: Entity,
  edge: Relationship | null,
): LifeOpsRelationship {
  const primaryIdentity = entity.identities[0];
  return {
    id: entity.entityId,
    agentId,
    name: entity.preferredName,
    primaryChannel:
      attrString(entity, ATTR_PRIMARY_CHANNEL) ??
      primaryIdentity?.platform ??
      "",
    primaryHandle:
      attrString(entity, ATTR_PRIMARY_HANDLE) ?? primaryIdentity?.handle ?? "",
    email: attrString(entity, ATTR_EMAIL),
    phone: attrString(entity, ATTR_PHONE),
    notes: attrString(entity, ATTR_NOTES) ?? "",
    tags: userTags(entity.tags),
    relationshipType: edge?.type ?? "contact",
    lastContactedAt: lastContactedAtFromEntity(entity, edge),
    metadata: { ...(edge?.metadata ?? {}) },
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

interface ContactFields {
  primaryChannel: string;
  primaryHandle: string;
  email: string | null;
  phone: string | null;
  notes: string;
}

/** Entity attributes that round-trip the flat contact projection. */
export function contactAttributes(
  input: ContactFields,
  updatedAt: string,
): Record<string, EntityAttribute> {
  const make = (value: string): EntityAttribute => ({
    value,
    confidence: 1,
    evidence: [],
    updatedAt,
  });
  const attributes: Record<string, EntityAttribute> = {
    [ATTR_PRIMARY_CHANNEL]: make(input.primaryChannel),
    [ATTR_PRIMARY_HANDLE]: make(input.primaryHandle),
  };
  if (input.email) attributes[ATTR_EMAIL] = make(input.email);
  if (input.phone) attributes[ATTR_PHONE] = make(input.phone);
  if (input.notes) attributes[ATTR_NOTES] = make(input.notes);
  return attributes;
}

/** Verified identities for the primary channel plus email / phone. */
export function contactIdentities(
  input: ContactFields,
  addedAt: string,
): EntityIdentity[] {
  const seen = new Set<string>();
  const identities: EntityIdentity[] = [];
  const push = (platform: string, handle: string) => {
    const key = `${platform}\x00${handle}`;
    if (!platform || !handle || seen.has(key)) return;
    seen.add(key);
    identities.push({
      platform,
      handle,
      verified: true,
      confidence: 1,
      addedAt,
      addedVia: "import",
      evidence: [],
    });
  };
  push(input.primaryChannel, input.primaryHandle);
  if (input.email) push("email", input.email);
  if (input.phone) push("phone", input.phone);
  return identities;
}
