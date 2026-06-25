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
import {
  contactAttributes,
  contactEdgeId,
  contactIdentities,
  LIFEOPS_CONTACT_TAG,
  lifeOpsRelationshipFromEntity,
  userTags,
} from "./relationships/mapping.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function isoNow(): string {
  return new Date().toISOString();
}

/** @internal */
export function withRelationships<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase) {
  class LifeOpsRelationshipsServiceMixin extends Base {
    async upsertRelationship(
      input: Omit<
        LifeOpsRelationship,
        "id" | "agentId" | "createdAt" | "updatedAt"
      > & { id?: string },
    ): Promise<LifeOpsRelationship> {
      const agentId = this.agentId();
      const entityStore = await this.repository.entityStore(agentId);
      const relationshipStore =
        await this.repository.relationshipStore(agentId);
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

      const edge = await relationshipStore.upsert({
        relationshipId: contactEdgeId(entity.entityId),
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: entity.entityId,
        type: input.relationshipType || "contact",
        metadata: { ...input.metadata },
        state: input.lastContactedAt
          ? { lastInteractionAt: input.lastContactedAt }
          : {},
        evidence: [LIFEOPS_CONTACT_TAG],
        confidence: 1,
        source: "import",
      });

      return lifeOpsRelationshipFromEntity(agentId, entity, edge);
    }

    async getRelationship(id: string): Promise<LifeOpsRelationship | null> {
      const agentId = this.agentId();
      const entityStore = await this.repository.entityStore(agentId);
      const entity = await entityStore.get(id);
      if (!entity) {
        return null;
      }
      const relationshipStore =
        await this.repository.relationshipStore(agentId);
      const edge = await relationshipStore.get(contactEdgeId(id));
      return lifeOpsRelationshipFromEntity(agentId, entity, edge);
    }

    async listRelationships(opts?: {
      limit?: number;
      primaryChannel?: LifeOpsMessageChannel;
    }): Promise<LifeOpsRelationship[]> {
      const agentId = this.agentId();
      const entityStore = await this.repository.entityStore(agentId);
      const relationshipStore =
        await this.repository.relationshipStore(agentId);
      const entities = await entityStore.list({
        type: "person",
        tag: LIFEOPS_CONTACT_TAG,
        ...(opts?.limit ? { limit: opts.limit } : {}),
      });
      const result: LifeOpsRelationship[] = [];
      for (const entity of entities) {
        const edge = await relationshipStore.get(
          contactEdgeId(entity.entityId),
        );
        const dto = lifeOpsRelationshipFromEntity(agentId, entity, edge);
        if (
          opts?.primaryChannel &&
          dto.primaryChannel !== opts.primaryChannel
        ) {
          continue;
        }
        result.push(dto);
      }
      return result;
    }

    async logInteraction(
      input: Omit<
        LifeOpsRelationshipInteraction,
        "id" | "agentId" | "createdAt"
      >,
    ): Promise<LifeOpsRelationshipInteraction> {
      const agentId = this.agentId();
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
      await this.repository.logRelationshipInteraction(record);
      // ... plus aggregate recency state on the graph entity.
      const entityStore = await this.repository.entityStore(agentId);
      await entityStore.recordInteraction(input.relationshipId, {
        platform: input.channel,
        direction: input.direction,
        summary: input.summary,
        occurredAt: input.occurredAt,
      });
      return record;
    }

    async getDaysSinceContact(relationshipId: string): Promise<number | null> {
      const entityStore = await this.repository.entityStore(this.agentId());
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

  return LifeOpsRelationshipsServiceMixin;
}

/** Public surface added by {@link withRelationships}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsRelationshipService {
  upsertRelationship(
    input: Omit<
      LifeOpsRelationship,
      "id" | "agentId" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): Promise<LifeOpsRelationship>;
  getRelationship(id: string): Promise<LifeOpsRelationship | null>;
  listRelationships(opts?: {
    limit?: number;
    primaryChannel?: LifeOpsMessageChannel;
  }): Promise<LifeOpsRelationship[]>;
  logInteraction(
    input: Omit<LifeOpsRelationshipInteraction, "id" | "agentId" | "createdAt">,
  ): Promise<LifeOpsRelationshipInteraction>;
}
