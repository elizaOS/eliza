import type {
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
} from "@elizaos/shared";
import {
  type LifeOpsSchedulingService,
  type SchedulingDeps,
  SchedulingDomain,
} from "./domains/scheduling-service.js";
import type {
  LifeOpsScheduleInspection,
  LifeOpsScheduleSummary,
} from "./schedule-insight.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export type { LifeOpsSchedulingService } from "./domains/scheduling-service.js";

/** @internal */
export function withScheduling<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsSchedulingService> {
  class LifeOpsSchedulingServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly schedulingDomain = new SchedulingDomain(this, {
      sendGmailMessage: (...args) =>
        (this as unknown as SchedulingDeps).sendGmailMessage(...args),
      sendTelegramMessage: (...args) =>
        (this as unknown as SchedulingDeps).sendTelegramMessage(...args),
      sendWhatsAppMessage: (...args) =>
        (this as unknown as SchedulingDeps).sendWhatsAppMessage(...args),
      sendIMessage: (...args) =>
        (this as unknown as SchedulingDeps).sendIMessage(...args),
    });

    inspectSchedule(args: {
      timezone: string;
      now?: Date;
    }): Promise<LifeOpsScheduleInspection> {
      return this.schedulingDomain.inspectSchedule(args);
    }

    readScheduleSummary(args: {
      timezone: string;
      now?: Date;
    }): Promise<LifeOpsScheduleSummary> {
      return this.schedulingDomain.readScheduleSummary(args);
    }

    resolveCounterpartyTarget(
      negotiation: LifeOpsSchedulingNegotiation,
    ): ReturnType<SchedulingDomain["resolveCounterpartyTarget"]> {
      return this.schedulingDomain.resolveCounterpartyTarget(negotiation);
    }

    dispatchSchedulingMessage(
      negotiation: LifeOpsSchedulingNegotiation,
      body: string,
      subject: string,
    ): ReturnType<SchedulingDomain["dispatchSchedulingMessage"]> {
      return this.schedulingDomain.dispatchSchedulingMessage(
        negotiation,
        body,
        subject,
      );
    }

    startNegotiation(input: {
      subject: string;
      relationshipId?: string | null;
      durationMinutes?: number;
      timezone?: string;
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsSchedulingNegotiation> {
      return this.schedulingDomain.startNegotiation(input);
    }

    getNegotiation(id: string): Promise<LifeOpsSchedulingNegotiation | null> {
      return this.schedulingDomain.getNegotiation(id);
    }

    listActiveNegotiations(opts?: {
      limit?: number;
    }): Promise<LifeOpsSchedulingNegotiation[]> {
      return this.schedulingDomain.listActiveNegotiations(opts);
    }

    proposeTime(input: {
      negotiationId: string;
      startAt: string;
      endAt: string;
      proposedBy: "agent" | "owner" | "counterparty";
      metadata?: Record<string, unknown>;
    }): Promise<LifeOpsSchedulingProposal> {
      return this.schedulingDomain.proposeTime(input);
    }

    respondToProposal(
      proposalId: string,
      status: "accepted" | "declined" | "expired",
    ): Promise<LifeOpsSchedulingProposal> {
      return this.schedulingDomain.respondToProposal(proposalId, status);
    }

    finalizeNegotiation(
      id: string,
      acceptedProposalId: string,
    ): Promise<LifeOpsSchedulingNegotiation> {
      return this.schedulingDomain.finalizeNegotiation(id, acceptedProposalId);
    }

    cancelNegotiation(id: string, reason?: string): Promise<void> {
      return this.schedulingDomain.cancelNegotiation(id, reason);
    }

    listProposals(negotiationId: string): Promise<LifeOpsSchedulingProposal[]> {
      return this.schedulingDomain.listProposals(negotiationId);
    }
  }

  return LifeOpsSchedulingServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsSchedulingService
  >;
}
