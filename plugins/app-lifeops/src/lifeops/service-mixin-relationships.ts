// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import crypto from "node:crypto";
import type {
  LifeOpsFollowUp,
  LifeOpsFollowUpStatus,
  LifeOpsMessageChannel,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
} from "@elizaos/shared";
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
