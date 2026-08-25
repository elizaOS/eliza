/**
 * Meeting-scheduling domain for LifeOps: persists negotiations and proposals,
 * resolves counterparties through the relationship graph, and produces exact
 * outbound drafts. The owner action boundary places those drafts in the shared
 * approval queue; this domain never dispatches connector side effects.
 */
import crypto from "node:crypto";
import {
  LIFEOPS_NEGOTIATION_STATES,
  type LifeOpsSchedulingNegotiation,
  type LifeOpsSchedulingProposal,
} from "@elizaos/shared";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  contactEdgeId,
  lifeOpsRelationshipFromEntity,
} from "../relationships/mapping.js";
import {
  inspectLifeOpsSchedule,
  type LifeOpsScheduleInspection,
  type LifeOpsScheduleSummary,
  readScheduleSummary,
} from "../schedule-insight.js";
import { fail } from "../service-normalize.js";
import type { TransactionalDb } from "../sql.js";

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Channels that a negotiation dispatch can be delivered on, resolved from
 * the linked relationship's contact info. Ordered so that richer / more
 * reliable channels are preferred when `primaryChannel` is ambiguous.
 */
const SCHEDULING_DISPATCH_CHANNELS = [
  "email",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
  "sms",
] as const;
export type SchedulingDispatchChannel =
  (typeof SCHEDULING_DISPATCH_CHANNELS)[number];

export type CounterpartyTarget = {
  entityId: string;
  entityUpdatedAt: string;
  channel: SchedulingDispatchChannel;
  target: string;
  name: string;
};

export type SchedulingMessageDraft = {
  messageKind: "opening" | "proposal" | "confirmation" | "cancellation";
  negotiationId: string;
  proposalId: string | null;
  transportChannel: SchedulingDispatchChannel;
  recipient: string;
  recipientName: string;
  subject: string;
  body: string;
  sourceUpdatedAt: string;
  counterpartyEntityId: string;
  counterpartyEntityUpdatedAt: string;
};

export interface LifeOpsSchedulingService {
  inspectSchedule(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleInspection>;
  readScheduleSummary(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleSummary>;
  resolveCounterpartyTarget(
    negotiation: LifeOpsSchedulingNegotiation,
  ): Promise<CounterpartyTarget | null>;
  resolveCounterpartyTargetForRelationship(
    relationshipId: string | null,
    negotiationId?: string,
  ): Promise<CounterpartyTarget | null>;
  draftOpeningMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null>;
  draftProposalMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null>;
  draftConfirmationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null>;
  draftCancellationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    reason?: string,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null>;
  startNegotiation(input: {
    subject: string;
    relationshipId?: string | null;
    durationMinutes?: number;
    timezone?: string;
    metadata?: Record<string, unknown>;
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingNegotiation>;
  getNegotiation(
    id: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation | null>;
  listActiveNegotiations(opts?: {
    limit?: number;
  }): Promise<LifeOpsSchedulingNegotiation[]>;
  proposeTime(input: {
    negotiationId: string;
    startAt: string;
    endAt: string;
    proposedBy: "agent" | "owner" | "counterparty";
    metadata?: Record<string, unknown>;
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingProposal>;
  respondToProposal(
    proposalId: string,
    status: "accepted" | "declined" | "expired",
  ): Promise<LifeOpsSchedulingProposal>;
  finalizeNegotiation(
    id: string,
    acceptedProposalId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation>;
  cancelNegotiation(
    id: string,
    reason?: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation>;
  listProposals(
    negotiationId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingProposal[]>;
}

function normalizeChannel(
  value: string | null | undefined,
): SchedulingDispatchChannel | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return (SCHEDULING_DISPATCH_CHANNELS as readonly string[]).includes(trimmed)
    ? (trimmed as SchedulingDispatchChannel)
    : null;
}

/**
 * Scheduling negotiation domain: schedule inspection plus the durable
 * negotiation/proposal lifecycle and pure outbound draft construction.
 */
export class SchedulingDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async inspectSchedule(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleInspection> {
    return await inspectLifeOpsSchedule({
      runtime: this.ctx.runtime,
      repository: this.ctx.repository,
      agentId: this.ctx.agentId(),
      timezone: args.timezone,
      now: args.now,
    });
  }

  /**
   * Read-only schedule summary for UI surfaces. Pulls the last persisted
   * merged state + last 7 days of sleep episodes without triggering any
   * probes. Use this instead of {@link inspectSchedule} from the UI.
   */
  async readScheduleSummary(args: {
    timezone: string;
    now?: Date;
  }): Promise<LifeOpsScheduleSummary> {
    return await readScheduleSummary({
      repository: this.ctx.repository,
      agentId: this.ctx.agentId(),
      timezone: args.timezone,
      now: args.now,
    });
  }

  /**
   * Resolve the counterparty's channel + target from the relationship
   * linked to the negotiation. Returns null if no linked relationship, and
   * fails with `SCHEDULING_NO_COUNTERPARTY_CONTACT` if the relationship has
   * no usable contact info.
   */
  async resolveCounterpartyTarget(
    negotiation: LifeOpsSchedulingNegotiation,
  ): Promise<CounterpartyTarget | null> {
    return this.resolveCounterpartyTargetForRelationship(
      negotiation.relationshipId,
      negotiation.id,
    );
  }

  async resolveCounterpartyTargetForRelationship(
    relationshipId: string | null,
    negotiationId = "new scheduling negotiation",
  ): Promise<CounterpartyTarget | null> {
    if (!relationshipId) {
      return null;
    }
    const agentId = this.ctx.agentId();
    const entityStore = await this.ctx.repository.entityStore(agentId);
    const entity = await entityStore.get(relationshipId);
    if (!entity) {
      fail(
        404,
        `SCHEDULING_NO_COUNTERPARTY_CONTACT: relationship ${relationshipId} not found for negotiation ${negotiationId}`,
      );
    }
    const relationshipStore =
      await this.ctx.repository.relationshipStore(agentId);
    const edge = await relationshipStore.get(contactEdgeId(relationshipId));
    const relationship = lifeOpsRelationshipFromEntity(agentId, entity, edge);

    const primaryChannel = normalizeChannel(relationship.primaryChannel);
    const primaryHandle =
      typeof relationship.primaryHandle === "string"
        ? relationship.primaryHandle.trim()
        : "";
    if (primaryChannel && primaryHandle) {
      return {
        entityId: entity.entityId,
        entityUpdatedAt: entity.updatedAt,
        channel: primaryChannel,
        target: primaryHandle,
        name: relationship.name,
      };
    }
    const email =
      typeof relationship.email === "string" ? relationship.email.trim() : "";
    if (email) {
      return {
        entityId: entity.entityId,
        entityUpdatedAt: entity.updatedAt,
        channel: "email",
        target: email,
        name: relationship.name,
      };
    }
    const phone =
      typeof relationship.phone === "string" ? relationship.phone.trim() : "";
    if (phone) {
      return {
        entityId: entity.entityId,
        entityUpdatedAt: entity.updatedAt,
        channel: "sms",
        target: phone,
        name: relationship.name,
      };
    }
    fail(
      409,
      `SCHEDULING_NO_COUNTERPARTY_CONTACT: relationship ${relationship.id} has no usable contact (primaryChannel/primaryHandle, email, or phone)`,
    );
  }

  private async draftMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    input: {
      messageKind: SchedulingMessageDraft["messageKind"];
      proposalId: string | null;
      subject: string;
      body: string;
      sourceUpdatedAt: string;
    },
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null> {
    const contact =
      counterparty === undefined
        ? await this.resolveCounterpartyTarget(negotiation)
        : counterparty;
    if (!contact) {
      return null;
    }
    return {
      messageKind: input.messageKind,
      negotiationId: negotiation.id,
      proposalId: input.proposalId,
      transportChannel: contact.channel,
      recipient: contact.target,
      recipientName: contact.name,
      subject: input.subject,
      body: input.body,
      sourceUpdatedAt: input.sourceUpdatedAt,
      counterpartyEntityId: contact.entityId,
      counterpartyEntityUpdatedAt: contact.entityUpdatedAt,
    };
  }

  async draftOpeningMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null> {
    return this.draftMessage(
      negotiation,
      {
        messageKind: "opening",
        proposalId: null,
        subject: `Scheduling: ${negotiation.subject}`,
        body:
          `Hi,\n\nI'd like to set up "${negotiation.subject}" ` +
          `(roughly ${negotiation.durationMinutes} minutes, ${negotiation.timezone}). ` +
          `I'll follow up with specific proposed times shortly.\n\n` +
          `Reference: ${negotiation.id}`,
        sourceUpdatedAt: negotiation.updatedAt,
      },
      counterparty,
    );
  }

  async draftProposalMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null> {
    return this.draftMessage(
      negotiation,
      {
        messageKind: "proposal",
        proposalId: proposal.id,
        subject: `Scheduling: ${negotiation.subject}`,
        body:
          `Proposed time for "${negotiation.subject}":\n` +
          `  Start: ${proposal.startAt}\n` +
          `  End:   ${proposal.endAt}\n` +
          `  (${negotiation.durationMinutes} min, ${negotiation.timezone})\n\n` +
          `Let me know if this works or suggest a different slot.\n\n` +
          `Reference: ${negotiation.id} / ${proposal.id}`,
        sourceUpdatedAt: proposal.updatedAt,
      },
      counterparty,
    );
  }

  async draftConfirmationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    proposal: LifeOpsSchedulingProposal,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null> {
    return this.draftMessage(
      negotiation,
      {
        messageKind: "confirmation",
        proposalId: proposal.id,
        subject: `Scheduling update: ${negotiation.subject}`,
        body:
          `Accepted time for "${negotiation.subject}":\n` +
          `  Start: ${proposal.startAt}\n` +
          `  End:   ${proposal.endAt}\n` +
          `  (${negotiation.durationMinutes} min, ${negotiation.timezone})\n\n` +
          `This message does not create or update a calendar event.\n\n` +
          `Reference: ${negotiation.id} / ${proposal.id}`,
        sourceUpdatedAt: negotiation.updatedAt,
      },
      counterparty,
    );
  }

  async draftCancellationMessage(
    negotiation: LifeOpsSchedulingNegotiation,
    reason?: string,
    counterparty?: CounterpartyTarget | null,
  ): Promise<SchedulingMessageDraft | null> {
    return this.draftMessage(
      negotiation,
      {
        messageKind: "cancellation",
        proposalId: negotiation.acceptedProposalId,
        subject: `Scheduling update: ${negotiation.subject}`,
        body:
          `Cancelling the scheduling discussion for "${negotiation.subject}"` +
          (reason ? ` — ${reason}.` : ".") +
          `\n\nThis message does not change a calendar event.\n\n` +
          `Reference: ${negotiation.id}`,
        sourceUpdatedAt: negotiation.updatedAt,
      },
      counterparty,
    );
  }

  async startNegotiation(input: {
    subject: string;
    relationshipId?: string | null;
    durationMinutes?: number;
    timezone?: string;
    metadata?: Record<string, unknown>;
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingNegotiation> {
    const subject = input.subject.trim();
    if (!subject) {
      fail(400, "subject is required");
    }
    const now = isoNow();
    const negotiation: LifeOpsSchedulingNegotiation = {
      id: crypto.randomUUID(),
      agentId: this.ctx.agentId(),
      subject,
      relationshipId: input.relationshipId ?? null,
      durationMinutes:
        typeof input.durationMinutes === "number" && input.durationMinutes > 0
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
    await this.ctx.repository.upsertSchedulingNegotiation(
      negotiation,
      input.tx,
    );
    return negotiation;
  }

  async getNegotiation(
    id: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation | null> {
    return this.ctx.repository.getSchedulingNegotiation(
      this.ctx.agentId(),
      id,
      tx,
    );
  }

  async listActiveNegotiations(opts?: {
    limit?: number;
  }): Promise<LifeOpsSchedulingNegotiation[]> {
    const all = await this.ctx.repository.listSchedulingNegotiations(
      this.ctx.agentId(),
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
    tx?: TransactionalDb;
  }): Promise<LifeOpsSchedulingProposal> {
    const negotiation = await this.ctx.repository.getSchedulingNegotiation(
      this.ctx.agentId(),
      input.negotiationId,
      input.tx,
    );
    if (!negotiation) {
      fail(404, `negotiation ${input.negotiationId} not found`);
    }
    if (
      negotiation.state === "confirmed" ||
      negotiation.state === "cancelled"
    ) {
      fail(409, `cannot propose on negotiation in state ${negotiation.state}`);
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
      agentId: this.ctx.agentId(),
      negotiationId: negotiation.id,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      proposedBy: input.proposedBy,
      status: "pending",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await this.ctx.repository.upsertSchedulingProposal(proposal, input.tx);

    if (
      negotiation.state === "initiated" ||
      negotiation.state === "awaiting_response"
    ) {
      await this.ctx.repository.updateSchedulingNegotiationState(
        this.ctx.agentId(),
        negotiation.id,
        "proposals_sent",
        undefined,
        input.tx,
      );
    }

    return proposal;
  }

  async respondToProposal(
    proposalId: string,
    status: "accepted" | "declined" | "expired",
  ): Promise<LifeOpsSchedulingProposal> {
    const proposal = await this.ctx.repository.getSchedulingProposal(
      this.ctx.agentId(),
      proposalId,
    );
    if (!proposal) {
      fail(404, `proposal ${proposalId} not found`);
    }
    if (proposal.status !== "pending") {
      fail(409, `proposal already in terminal status ${proposal.status}`);
    }
    await this.ctx.repository.updateSchedulingProposalStatus(
      this.ctx.agentId(),
      proposalId,
      status,
    );
    const updated = await this.ctx.repository.getSchedulingProposal(
      this.ctx.agentId(),
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
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation> {
    const negotiation = await this.ctx.repository.getSchedulingNegotiation(
      this.ctx.agentId(),
      id,
      tx,
    );
    if (!negotiation) {
      fail(404, `negotiation ${id} not found`);
    }
    if (negotiation.state === "cancelled") {
      fail(409, "cannot finalize cancelled negotiation");
    }
    const proposal = await this.ctx.repository.getSchedulingProposal(
      this.ctx.agentId(),
      acceptedProposalId,
      tx,
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
    await this.ctx.repository.upsertSchedulingNegotiation(updated, tx);
    return updated;
  }

  async cancelNegotiation(
    id: string,
    reason?: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingNegotiation> {
    const negotiation = await this.ctx.repository.getSchedulingNegotiation(
      this.ctx.agentId(),
      id,
      tx,
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
    await this.ctx.repository.upsertSchedulingNegotiation(updated, tx);
    return updated;
  }

  async listProposals(
    negotiationId: string,
    tx?: TransactionalDb,
  ): Promise<LifeOpsSchedulingProposal[]> {
    return this.ctx.repository.listSchedulingProposals(
      this.ctx.agentId(),
      negotiationId,
      tx,
    );
  }
}
