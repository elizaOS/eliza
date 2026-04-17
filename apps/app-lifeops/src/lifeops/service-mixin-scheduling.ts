// @ts-nocheck — mixin: type safety is enforced on the composed class
import crypto from "node:crypto";
import type {
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
} from "@elizaos/shared/contracts/lifeops";
import { LIFEOPS_NEGOTIATION_STATES } from "@elizaos/shared/contracts/lifeops";
import { fail } from "./service-normalize.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function isoNow(): string {
  return new Date().toISOString();
}

/** @internal */
export function withScheduling<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSchedulingServiceMixin extends Base {
    async startNegotiation(input: {
      subject: string;
      relationshipId?: string | null;
      durationMinutes?: number;
      timezone?: string;
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsSchedulingNegotiation> {
      const subject = (input.subject ?? "").trim();
      if (!subject) {
        fail(400, "subject is required");
      }
      const now = isoNow();
      const negotiation: LifeOpsSchedulingNegotiation = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        subject,
        relationshipId: input.relationshipId ?? null,
        durationMinutes:
          typeof input.durationMinutes === "number" &&
          input.durationMinutes > 0
            ? Math.floor(input.durationMinutes)
            : 30,
        timezone: input.timezone ?? "UTC",
        state: "initiated",
        acceptedProposalId: null,
        startedAt: now,
        finalizedAt: null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertSchedulingNegotiation(negotiation);
      return negotiation;
    }

    async getNegotiation(
      id: string,
    ): Promise<LifeOpsSchedulingNegotiation | null> {
      return this.repository.getSchedulingNegotiation(this.agentId(), id);
    }

    async listActiveNegotiations(opts?: {
      limit?: number;
    }): Promise<LifeOpsSchedulingNegotiation[]> {
      const all = await this.repository.listSchedulingNegotiations(
        this.agentId(),
        { limit: opts?.limit },
      );
      return all.filter(
        (n) => n.state !== "confirmed" && n.state !== "cancelled",
      );
    }

    async proposeTime(input: {
      negotiationId: string;
      startAt: string;
      endAt: string;
      proposedBy: "agent" | "owner" | "counterparty";
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsSchedulingProposal> {
      const negotiation = await this.repository.getSchedulingNegotiation(
        this.agentId(),
        input.negotiationId,
      );
      if (!negotiation) {
        fail(404, `negotiation ${input.negotiationId} not found`);
      }
      if (
        negotiation.state === "confirmed" ||
        negotiation.state === "cancelled"
      ) {
        fail(
          409,
          `cannot propose on negotiation in state ${negotiation.state}`,
        );
      }
      if (!LIFEOPS_NEGOTIATION_STATES.includes(negotiation.state)) {
        fail(500, `unexpected negotiation state ${negotiation.state}`);
      }

      const startMs = Date.parse(input.startAt);
      const endMs = Date.parse(input.endAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        fail(400, "startAt/endAt must be valid ISO-8601 timestamps");
      }
      if (endMs <= startMs) {
        fail(400, "endAt must be after startAt");
      }

      const now = isoNow();
      const proposal: LifeOpsSchedulingProposal = {
        id: crypto.randomUUID(),
        agentId: this.agentId(),
        negotiationId: negotiation.id,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        proposedBy: input.proposedBy,
        status: "pending",
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.upsertSchedulingProposal(proposal);

      if (
        negotiation.state === "initiated" ||
        negotiation.state === "awaiting_response"
      ) {
        await this.repository.updateSchedulingNegotiationState(
          this.agentId(),
          negotiation.id,
          "proposals_sent",
        );
      }
      return proposal;
    }

    async respondToProposal(
      proposalId: string,
      status: "accepted" | "declined" | "expired",
    ): Promise<LifeOpsSchedulingProposal> {
      const proposal = await this.repository.getSchedulingProposal(
        this.agentId(),
        proposalId,
      );
      if (!proposal) {
        fail(404, `proposal ${proposalId} not found`);
      }
      if (proposal.status !== "pending") {
        fail(
          409,
          `proposal already in terminal status ${proposal.status}`,
        );
      }
      await this.repository.updateSchedulingProposalStatus(
        this.agentId(),
        proposalId,
        status,
      );
      const updated = await this.repository.getSchedulingProposal(
        this.agentId(),
        proposalId,
      );
      if (!updated) {
        fail(500, "proposal disappeared after update");
      }
      return updated;
    }

    async finalizeNegotiation(
      id: string,
      acceptedProposalId: string,
    ): Promise<LifeOpsSchedulingNegotiation> {
      const negotiation = await this.repository.getSchedulingNegotiation(
        this.agentId(),
        id,
      );
      if (!negotiation) {
        fail(404, `negotiation ${id} not found`);
      }
      if (negotiation.state === "cancelled") {
        fail(409, "cannot finalize cancelled negotiation");
      }
      const proposal = await this.repository.getSchedulingProposal(
        this.agentId(),
        acceptedProposalId,
      );
      if (!proposal || proposal.negotiationId !== id) {
        fail(
          404,
          `proposal ${acceptedProposalId} not found for negotiation ${id}`,
        );
      }
      if (proposal.status !== "accepted") {
        fail(
          409,
          `proposal ${acceptedProposalId} is not accepted (status=${proposal.status})`,
        );
      }
      const now = isoNow();
      const updated: LifeOpsSchedulingNegotiation = {
        ...negotiation,
        state: "confirmed",
        acceptedProposalId,
        finalizedAt: now,
        updatedAt: now,
      };
      await this.repository.upsertSchedulingNegotiation(updated);
      return updated;
    }

    async cancelNegotiation(id: string, reason?: string): Promise<void> {
      const negotiation = await this.repository.getSchedulingNegotiation(
        this.agentId(),
        id,
      );
      if (!negotiation) {
        fail(404, `negotiation ${id} not found`);
      }
      const nextMetadata = {
        ...negotiation.metadata,
        ...(reason ? { cancellationReason: reason } : {}),
      };
      const now = isoNow();
      const updated: LifeOpsSchedulingNegotiation = {
        ...negotiation,
        state: "cancelled",
        metadata: nextMetadata,
        updatedAt: now,
      };
      await this.repository.upsertSchedulingNegotiation(updated);
    }

    async listProposals(
      negotiationId: string,
    ): Promise<LifeOpsSchedulingProposal[]> {
      return this.repository.listSchedulingProposals(
        this.agentId(),
        negotiationId,
      );
    }
  }

  return LifeOpsSchedulingServiceMixin;
}
