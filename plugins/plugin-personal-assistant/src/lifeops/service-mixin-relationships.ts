// In addition to the legacy-table writes, this mixin projects each write
// into the (Entity, Relationship) graph so both surfaces stay in sync.
import crypto from "node:crypto";
import type {
  LifeOpsMessageChannel,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
} from "@elizaos/shared";
import { SELF_ENTITY_ID } from "./entities/types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function isoNow(): string {
  return new Date().toISOString();
}

async function projectRelationshipIntoGraph(
  self: LifeOpsServiceBase,
  record: LifeOpsRelationship,
): Promise<void> {
  try {
    const entityStore = await self.repository.entityStore(self.agentId());
    await entityStore.ensureSelf();
    const entity = await entityStore.upsert({
      entityId: `legacy-${record.id}`,
      type: "person",
      preferredName: record.name,
      identities: [
        {
          platform: record.primaryChannel,
          handle: record.primaryHandle,
          verified: true,
          confidence: 1,
          addedAt: record.updatedAt,
          addedVia: "import",
          evidence: [`legacy:${record.id}`],
        },
      ],
      tags: record.tags,
      visibility: "owner_agent_admin",
      state: record.lastContactedAt
        ? { lastInboundAt: record.lastContactedAt }
        : {},
    });

    const relStore = await self.repository.relationshipStore(self.agentId());
    await relStore.upsert({
      relationshipId: `legacy-rel-${record.id}`,
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: entity.entityId,
      type: record.relationshipType || "knows",
      metadata: {
        ...record.metadata,
        ...(record.notes ? { notes: record.notes } : {}),
      },
      state: record.lastContactedAt
        ? { lastInteractionAt: record.lastContactedAt }
        : {},
      evidence: [`legacy:${record.id}`],
      confidence: 1,
      source: "import",
    });
  } catch {
    // Secondary projection; legacy table is the source of truth.
  }
}

async function projectInteractionIntoGraph(
  self: LifeOpsServiceBase,
  interaction: LifeOpsRelationshipInteraction,
): Promise<void> {
  try {
    const entityStore = await self.repository.entityStore(self.agentId());
    const entityId = `legacy-${interaction.relationshipId}`;
    await entityStore.recordInteraction(entityId, {
      platform: interaction.channel,
      direction: interaction.direction,
      summary: interaction.summary,
      occurredAt: interaction.occurredAt,
    });
    const relStore = await self.repository.relationshipStore(self.agentId());
    await relStore.observe({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: entityId,
      type: "knows",
      evidence: [`legacy:${interaction.id}`],
      confidence: 1,
      source: "user_chat",
      occurredAt: interaction.occurredAt,
    });
  } catch {
    // Best-effort projection.
  }
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
      const now = isoNow();
      const existing = input.id
        ? await this.repository.getRelationship(this.agentId(), input.id)
        : null;
      const record: LifeOpsRelationship = {
        id: input.id ?? existing?.id ?? crypto.randomUUID(),
        agentId: this.agentId(),
        name: input.name,
        primaryChannel: input.primaryChannel,
        primaryHandle: input.primaryHandle,
        email: input.email ?? null,
        phone: input.phone ?? null,
        notes: input.notes,
        tags: input.tags,
        relationshipType: input.relationshipType,
        lastContactedAt:
          input.lastContactedAt ?? existing?.lastContactedAt ?? null,
        metadata: input.metadata,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.repository.upsertRelationship(record);
      await projectRelationshipIntoGraph(this, record);
      return record;
    }

    async getRelationship(id: string): Promise<LifeOpsRelationship | null> {
      return this.repository.getRelationship(this.agentId(), id);
    }

    async listRelationships(opts?: {
      limit?: number;
      primaryChannel?: LifeOpsMessageChannel;
    }): Promise<LifeOpsRelationship[]> {
      return this.repository.listRelationships(this.agentId(), opts);
    }

    async logInteraction(
      input: Omit<
        LifeOpsRelationshipInteraction,
        "id" | "agentId" | "createdAt"
      >,
    ): Promise<LifeOpsRelationshipInteraction> {
      const record: LifeOpsRelationshipInteraction = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        relationshipId: input.relationshipId,
        channel: input.channel,
        direction: input.direction,
        summary: input.summary,
        occurredAt: input.occurredAt,
        metadata: input.metadata,
        createdAt: isoNow(),
      };
      await this.repository.logRelationshipInteraction(record);
      await this.repository.updateRelationshipLastContactedAt(
        this.agentId(),
        input.relationshipId,
        input.occurredAt,
      );
      await projectInteractionIntoGraph(this, record);
      return record;
    }

    async getInteractions(
      relationshipId: string,
      opts?: { limit?: number },
    ): Promise<LifeOpsRelationshipInteraction[]> {
      return this.repository.listInteractions(
        this.agentId(),
        relationshipId,
        opts,
      );
    }

    async getDaysSinceContact(relationshipId: string): Promise<number | null> {
      const rel = await this.repository.getRelationship(
        this.agentId(),
        relationshipId,
      );
      if (!rel?.lastContactedAt) {
        return null;
      }
      const lastMs = Date.parse(rel.lastContactedAt);
      if (!Number.isFinite(lastMs)) {
        return null;
      }
      const diffMs = Date.now() - lastMs;
      return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
    }
  }

  return LifeOpsRelationshipsServiceMixin;
}
