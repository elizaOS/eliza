// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import crypto from "node:crypto";
import {
  LIFEOPS_NEGOTIATION_STATES,
  type LifeOpsSchedulingNegotiation,
  type LifeOpsSchedulingProposal,
} from "@elizaos/shared";
import {
  inspectLifeOpsSchedule,
  type LifeOpsScheduleInspection,
  type LifeOpsScheduleSummary,
  readScheduleSummary,
} from "./schedule-insight.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

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
  "signal",
  "whatsapp",
  "imessage",
  "sms",
] as const;
type SchedulingDispatchChannel = (typeof SCHEDULING_DISPATCH_CHANNELS)[number];

type CounterpartyTarget = {
  channel: SchedulingDispatchChannel;
  target: string;
  name: string;
};

function normalizeChannel(
  value: string | null | undefined,
): SchedulingDispatchChannel | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return (SCHEDULING_DISPATCH_CHANNELS as readonly string[]).includes(trimmed)
    ? (trimmed as SchedulingDispatchChannel)
    : null;
}

/** @internal */
export function withScheduling<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsSchedulingServiceMixin extends Base {
    async inspectSchedule(args: {
      timezone: string;
      now?: Date;
    }): Promise<LifeOpsScheduleInspection> {
      return await inspectLifeOpsSchedule({
        runtime: this.runtime,
        repository: this.repository,
        agentId: this.agentId(),
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
        repository: this.repository,
        agentId: this.agentId(),
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
      if (!negotiation.relationshipId) {
        return null;
      }
      const relationship = await this.repository.getRelationship(
        this.agentId(),
        negotiation.relationshipId,
      );
      if (!relationship) {
        fail(
          404,
          `SCHEDULING_NO_COUNTERPARTY_CONTACT: relationship ${negotiation.relationshipId} not found for negotiation ${negotiation.id}`,
        );
      }

      const primaryChannel = normalizeChannel(relationship.primaryChannel);
      const primaryHandle =
        typeof relationship.primaryHandle === "string"
          ? relationship.primaryHandle.trim()
          : "";
      if (primaryChannel && primaryHandle) {
        return {
          channel: primaryChannel,
          target: primaryHandle,
          name: relationship.name,
        };
      }
      const email =
        typeof relationship.email === "string" ? relationship.email.trim() : "";
      if (email) {
        return { channel: "email", target: email, name: relationship.name };
      }
      const phone =
        typeof relationship.phone === "string" ? relationship.phone.trim() : "";
      if (phone) {
        return { channel: "sms", target: phone, name: relationship.name };
      }
      fail(
        409,
        `SCHEDULING_NO_COUNTERPARTY_CONTACT: relationship ${relationship.id} has no usable contact (primaryChannel/primaryHandle, email, or phone)`,
      );
    }

    /**
     * Dispatch a plain message to the counterparty via an existing send
     * path. Fails (propagates the dispatch error) so the caller does not
     * report success when delivery actually failed.
     */
    async dispatchSchedulingMessage(
      negotiation: LifeOpsSchedulingNegotiation,
      body: string,
      subject: string,
    ): Promise<CounterpartyTarget> {
      const contact = await this.resolveCounterpartyTarget(negotiation);
      if (!contact) {
        fail(
          409,
          `SCHEDULING_NO_COUNTERPARTY_CONTACT: negotiation ${negotiation.id} has no relationshipId; cannot deliver message`,
        );
      }
      try {
        switch (contact.channel) {
          case "email": {
            const requestUrl = new URL(
              "http://internal.invalid/lifeops/gmail/send",
            );
            await this.sendGmailMessage(requestUrl, {
              to: [contact.target],
              subject,
              bodyText: body,
              confirmSend: true,
            });
            break;
          }
          case "telegram": {
            await this.sendTelegramMessage({
              target: contact.target,
              message: body,
            });
            break;
          }
          case "whatsapp": {
            await this.sendWhatsAppMessage({
              to: contact.target,
              text: body,
            });
            break;
          }
          case "imessage": {
            await this.sendIMessage({
              to: contact.target,
              text: body,
            });
            break;
          }
          case "discord":
          case "signal": {
            if (typeof this.runtime.sendMessageToTarget !== "function") {
              fail(
                501,
                `SCHEDULING_DISPATCH_UNAVAILABLE: runtime has no sendMessageToTarget for channel ${contact.channel}`,
              );
            }
            await this.runtime.sendMessageToTarget(
              {
                source: contact.channel,
                channelId: contact.target,
              } as Parameters<typeof this.runtime.sendMessageToTarget>[0],
              { text: body, source: contact.channel },
            );
            break;
          }
          case "sms": {
            return fail(
              501,
              `SCHEDULING_DISPATCH_UNAVAILABLE: sms dispatch for scheduling is not wired (counterparty phone=${contact.target}). Use SEND_DRAFT for SMS.`,
            );
          }
          default: {
            return fail(
              501,
              `SCHEDULING_DISPATCH_UNAVAILABLE: unsupported channel ${contact.channel}`,
            );
          }
        }
      } catch (error) {
        // Re-throw LifeOpsServiceError as-is; wrap other errors so the caller
        // can map them to a structured failure instead of silently
        // claiming success.
        if (
          error &&
          typeof error === "object" &&
          (error as { name?: string }).name === "LifeOpsServiceError"
        ) {
          throw error;
        }
        fail(
          502,
          `SCHEDULING_DISPATCH_FAILED: ${contact.channel} send to ${contact.target} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return contact;
    }

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
      await this.repository.upsertSchedulingNegotiation(negotiation);

      const subjectLine = `Scheduling: ${negotiation.subject}`;
      const body =
        `Hi,\n\nI'd like to set up "${negotiation.subject}" ` +
        `(roughly ${negotiation.durationMinutes} minutes, ${negotiation.timezone}). ` +
        `I'll follow up with specific proposed times shortly.\n\n` +
        `Reference: ${negotiation.id}`;
      await this.dispatchSchedulingMessage(negotiation, body, subjectLine);

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

      // Only send to the counterparty when the agent or owner is the one
      // proposing. A proposal whose `proposedBy = counterparty` came FROM
      // them, so echoing it back would be nonsense.
      if (input.proposedBy !== "counterparty") {
        const subjectLine = `Scheduling: ${negotiation.subject}`;
        const body =
          `Proposed time for "${negotiation.subject}":\n` +
          `  Start: ${proposal.startAt}\n` +
          `  End:   ${proposal.endAt}\n` +
          `  (${negotiation.durationMinutes} min, ${negotiation.timezone})\n\n` +
          `Let me know if this works or suggest a different slot.\n\n` +
          `Reference: ${negotiation.id} / ${proposal.id}`;
        await this.dispatchSchedulingMessage(negotiation, body, subjectLine);
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
        fail(409, `proposal already in terminal status ${proposal.status}`);
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

      const subjectLine = `Confirmed: ${updated.subject}`;
      const body =
        `Confirming "${updated.subject}":\n` +
        `  Start: ${proposal.startAt}\n` +
        `  End:   ${proposal.endAt}\n` +
        `  (${updated.durationMinutes} min, ${updated.timezone})\n\n` +
        `See you then.\n\n` +
        `Reference: ${updated.id} / ${proposal.id}`;
      await this.dispatchSchedulingMessage(updated, body, subjectLine);

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

      const subjectLine = `Cancelled: ${updated.subject}`;
      const body =
        `Cancelling "${updated.subject}"` +
        (reason ? ` — ${reason}.` : ".") +
        `\n\nReference: ${updated.id}`;
      await this.dispatchSchedulingMessage(updated, body, subjectLine);
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
