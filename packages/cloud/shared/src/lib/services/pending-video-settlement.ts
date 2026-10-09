/** Persists live upstream video jobs and promotes deferred admission off the response path. */

import {
  isSubscriptionFundedReservation,
  reserveAllowanceEligibleCredits,
} from "./allowance-first-credits";
import type { CreditReservation } from "./credits";
import { generationsService } from "./generations";

export interface PendingVideoSettlementInput {
  generationId: string;
  requestId: string;
  organizationId: string;
  userId: string;
  model: string;
  prompt: string;
  provider: string;
  billingSource: string;
  totalCost: number;
  durationSeconds: number;
  parameters: Record<string, unknown>;
  settlementMarker: string;
  existingReservation?: CreditReservation;
  releaseDeferredAdmission(): Promise<unknown>;
}

export async function persistPendingVideoSettlement(
  input: PendingVideoSettlementInput,
): Promise<void> {
  const reservation =
    input.existingReservation ??
    (await reserveAllowanceEligibleCredits("media_generation", {
      organizationId: input.organizationId,
      userId: input.userId,
      amount: input.totalCost,
      description: `Pending video generation: ${input.model}`,
      // The video reconcile sweep owns this hold, not the stale-funding sweep.
      operationKey: { prefix: "video:", identity: input.requestId },
    }));
  const funding = isSubscriptionFundedReservation(reservation)
    ? {
        logical_operation_id: reservation.funding.logicalOperationId,
        operation: reservation.funding.operation,
        occurred_at: reservation.funding.occurredAt.toISOString(),
      }
    : undefined;
  if (!input.existingReservation) await input.releaseDeferredAdmission();

  await generationsService.create({
    id: input.generationId,
    organization_id: input.organizationId,
    user_id: input.userId,
    type: "video",
    model: input.model,
    provider: input.provider,
    prompt: input.prompt,
    status: "pending",
    parameters: input.parameters,
    metadata: {
      settlement_marker: input.settlementMarker,
      reservation_transaction_id: reservation.reservationTransactionId,
      reserved_amount: reservation.reservedAmount,
      billed_cost: input.totalCost,
      billing_source: input.billingSource,
      ...(funding ? { funding, funding_logical_operation_id: funding.logical_operation_id } : {}),
    },
    dimensions: { duration: input.durationSeconds },
    cost: String(input.totalCost),
    credits: String(input.totalCost),
    job_id: input.requestId,
  });
}
