// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
//
// Wave-1 W1-E: in addition to the legacy-table writes, this mixin
// projects each write into the new (Entity, Relationship) graph so both
// surfaces stay in sync during the migration window. Wave-2 W2-A
// deletes this file; callers move to `repository.entityStore()` /
// `repository.relationshipStore()` accessors.
import crypto from "node:crypto";
import type {
  LifeOpsFollowUp,
  LifeOpsFollowUpStatus,
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
  self: any,
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
      metadata: { ...record.metadata, ...(record.notes ? { notes: record.notes } : {}) },
      state: record.lastContactedAt
        ? { lastInteractionAt: record.lastContactedAt }
        : {},
      evidence: [`legacy:${record.id}`],
      confidence: 1,
      source: "import",
    });
  } catch {
    // Projection is best-effort during the W1-E migration window.
    // The legacy table is the source of truth until W2-A flips.
  }
}

async function projectInteractionIntoGraph(
  self: any,
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
        notes: input.notes ?? "",
        tags: input.tags ?? [],
        relationshipType: input.relationshipType,
        lastContactedAt:
          input.lastContactedAt ?? existing?.lastContactedAt ?? null,
        metadata: input.metadata ?? {},
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
        metadata: input.metadata ?? {},
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

    async createFollowUp(
      input: Omit<
        LifeOpsFollowUp,
        "id" | "agentId" | "status" | "createdAt" | "updatedAt"
      > & { status?: LifeOpsFollowUpStatus },
    ): Promise<LifeOpsFollowUp> {
      const now = isoNow();
      const record: LifeOpsFollowUp = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        relationshipId: input.relationshipId,
        dueAt: input.dueAt,
        reason: input.reason,
        status: input.status ?? "pending",
        priority: input.priority ?? 3,
        draft: input.draft ?? null,
        completedAt: input.completedAt ?? null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertFollowUp(record);
      return record;
    }

    async completeFollowUp(id: string): Promise<void> {
      await this.repository.updateFollowUpStatus(
        this.agentId(),
        id,
        "completed",
        isoNow(),
      );
    }

    async snoozeFollowUp(id: string, newDueAt: string): Promise<void> {
      await this.repository.updateFollowUpDueAt(this.agentId(), id, newDueAt);
      await this.repository.updateFollowUpStatus(this.agentId(), id, "snoozed");
    }

    async listFollowUps(opts?: {
      status?: LifeOpsFollowUpStatus;
      dueOnOrBefore?: string;
      limit?: number;
    }): Promise<LifeOpsFollowUp[]> {
      return this.repository.listFollowUps(this.agentId(), opts);
    }

    async getDailyFollowUpQueue(opts?: {
      date?: string;
      limit?: number;
    }): Promise<LifeOpsFollowUp[]> {
      const date = opts?.date ?? isoNow();
      return this.repository.listFollowUps(this.agentId(), {
        status: "pending",
        dueOnOrBefore: date,
        limit: opts?.limit,
      });
    }
  }

  return LifeOpsRelationshipsServiceMixin;
}
