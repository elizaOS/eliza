/**
 * Relationship / contact surface of `LifeOpsService`.
 *
 * Contacts live in the runtime knowledge graph (`EntityStore` person nodes +
 * a single SELF→contact `RelationshipStore` edge) — the single source of
 * truth. There is no `life_relationships` table and no best-effort dual-write
 * projection: writes go straight to the graph and surface their errors.
 *
 * Per-interaction history is kept in `life_relationship_interactions` (keyed by
 * the graph `entityId`); the graph deliberately delegates per-edge history to
 * that audit log rather than replicating it (see `EntityStore.recordInteraction`).
 */
import crypto from "node:crypto";
import {
  type LifeOpsMessageChannel,
  type LifeOpsRelationship,
  type LifeOpsRelationshipInteraction,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  contactAttributes,
  contactEdgeId,
  contactIdentities,
  LIFEOPS_CONTACT_TAG,
  lifeOpsRelationshipFromEntity,
  userTags,
} from "../relationships/mapping.js";

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Relationship / contact reads and writes backed by the runtime knowledge
 * graph (`EntityStore` + `RelationshipStore`) plus the per-interaction audit
 * log. Base-only domain (no cross-domain dependencies).
 */
export class RelationshipsDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async upsertRelationship(
    input: Omit<
      LifeOpsRelationship,
      "id" | "agentId" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): Promise<LifeOpsRelationship> {
    const agentId = this.ctx.agentId();
    const entityStore = await this.ctx.repository.entityStore(agentId);
    const relationshipStore =
      await this.ctx.repository.relationshipStore(agentId);
    await entityStore.ensureSelf();

    const now = isoNow();
    const fields = {
      primaryChannel: input.primaryChannel,
      primaryHandle: input.primaryHandle,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes,
    };

    // Resolve the canonical entity: an explicit id updates in place;
    // otherwise dedup by the primary (platform, handle) via the merge engine.
    let entityId = input.id ?? null;
    if (!entityId) {
      const observed = await entityStore.observeIdentity({
        platform: input.primaryChannel,
        handle: input.primaryHandle,
        displayName: input.name,
        evidence: [LIFEOPS_CONTACT_TAG],
        confidence: 1,
        suggestedType: "person",
      });
      entityId = observed.entity.entityId;
    }

    const existing = await entityStore.get(entityId);
    const tags = Array.from(
      new Set([...userTags(input.tags), LIFEOPS_CONTACT_TAG]),
    );
    const entity = await entityStore.upsert({
      entityId,
      type: "person",
      preferredName: input.name,
      identities: contactIdentities(fields, now),
      attributes: contactAttributes(fields, now),
      tags,
      visibility: "owner_agent_admin",
      state: input.lastContactedAt
        ? {
            ...(existing?.state ?? {}),
            lastObservedAt: input.lastContactedAt,
            lastInboundAt: input.lastContactedAt,
          }
        : (existing?.state ?? {}),
    });

    // `RelationshipStore.upsert` is a full-replace write (`state_* =
    // EXCLUDED.state_*`), so the edge's interaction-recency state must be
    // carried forward explicitly: a contact edit that doesn't set
    // `lastContactedAt` (notes/tags update, re-add via the dedup path) would
    // otherwise wipe `lastInteractionAt` + `interactionCount` and make the
    // cadence-overdue check nag about a contact the owner just talked to.
    const existingEdge = await relationshipStore.get(
      contactEdgeId(entity.entityId),
    );
    const edge = await relationshipStore.upsert({
      relationshipId: contactEdgeId(entity.entityId),
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: entity.entityId,
      type: input.relationshipType || "contact",
      metadata: { ...input.metadata },
      state: {
        ...(existingEdge?.state ?? {}),
        ...(input.lastContactedAt
          ? { lastInteractionAt: input.lastContactedAt }
          : {}),
      },
      evidence: [LIFEOPS_CONTACT_TAG],
      confidence: 1,
      source: "import",
    });

    return lifeOpsRelationshipFromEntity(agentId, entity, edge);
  }

  async getRelationship(id: string): Promise<LifeOpsRelationship | null> {
    const agentId = this.ctx.agentId();
    const entityStore = await this.ctx.repository.entityStore(agentId);
    const entity = await entityStore.get(id);
    if (!entity) {
      return null;
    }
    const relationshipStore =
      await this.ctx.repository.relationshipStore(agentId);
    const edge = await relationshipStore.get(contactEdgeId(id));
    return lifeOpsRelationshipFromEntity(agentId, entity, edge);
  }

  async listRelationships(opts?: {
    limit?: number;
    primaryChannel?: LifeOpsMessageChannel;
  }): Promise<LifeOpsRelationship[]> {
    const agentId = this.ctx.agentId();
    const entityStore = await this.ctx.repository.entityStore(agentId);
    const relationshipStore =
      await this.ctx.repository.relationshipStore(agentId);
    const entities = await entityStore.list({
      type: "person",
      tag: LIFEOPS_CONTACT_TAG,
      ...(opts?.limit ? { limit: opts.limit } : {}),
    });
    const result: LifeOpsRelationship[] = [];
    for (const entity of entities) {
      const edge = await relationshipStore.get(contactEdgeId(entity.entityId));
      const dto = lifeOpsRelationshipFromEntity(agentId, entity, edge);
      if (opts?.primaryChannel && dto.primaryChannel !== opts.primaryChannel) {
        continue;
      }
      result.push(dto);
    }
    return result;
  }

  async logInteraction(
    input: Omit<LifeOpsRelationshipInteraction, "id" | "agentId" | "createdAt">,
  ): Promise<LifeOpsRelationshipInteraction> {
    const agentId = this.ctx.agentId();
    const record: LifeOpsRelationshipInteraction = {
      id: crypto.randomUUID(),
      agentId,
      relationshipId: input.relationshipId,
      channel: input.channel,
      direction: input.direction,
      summary: input.summary,
      occurredAt: input.occurredAt,
      metadata: input.metadata,
      createdAt: isoNow(),
    };
    // Per-interaction audit log (keyed by the graph entityId) ...
    await this.ctx.repository.logRelationshipInteraction(record);
    // ... plus aggregate recency state on the graph entity.
    const entityStore = await this.ctx.repository.entityStore(agentId);
    await entityStore.recordInteraction(input.relationshipId, {
      platform: input.channel,
      direction: input.direction,
      summary: input.summary,
      occurredAt: input.occurredAt,
    });
    return record;
  }

  async getDaysSinceContact(relationshipId: string): Promise<number | null> {
    const entityStore = await this.ctx.repository.entityStore(
      this.ctx.agentId(),
    );
    const entity = await entityStore.get(relationshipId);
    const last =
      entity?.state.lastObservedAt ??
      entity?.state.lastInboundAt ??
      entity?.state.lastOutboundAt ??
      null;
    if (!last) {
      return null;
    }
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) {
      return null;
    }
    const diffMs = Date.now() - lastMs;
    return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  }
}
