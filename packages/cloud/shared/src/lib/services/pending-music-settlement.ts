/** Persists live upstream music jobs and promotes deferred admission off the response path. */

import type { CreditReservation } from "./credits";
import { creditsService } from "./credits";
import { generationsService } from "./generations";

export interface PendingMusicSettlementInput {
  generationId: string;
  requestId: string;
  organizationId: string;
  userId: string;
  model: string;
  prompt: string;
  provider: string;
  billingSource: string;
  totalCost: number;
  durationSeconds?: number;
  parameters: Record<string, unknown>;
  settlementMarker: string;
  existingReservation?: CreditReservation;
  releaseDeferredAdmission(): Promise<unknown>;
}

export async function persistPendingMusicSettlement(
  input: PendingMusicSettlementInput,
): Promise<void> {
  const reservation =
    input.existingReservation ??
    (await creditsService.reserve({
      organizationId: input.organizationId,
      userId: input.userId,
      amount: input.totalCost,
      description: `Pending music generation: ${input.model}`,
    }));
  if (!input.existingReservation) await input.releaseDeferredAdmission();

  await generationsService.create({
    id: input.generationId,
    organization_id: input.organizationId,
    user_id: input.userId,
    type: "music",
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
    },
    dimensions: input.durationSeconds ? { duration: input.durationSeconds } : undefined,
    cost: String(input.totalCost),
    credits: String(input.totalCost),
    job_id: input.requestId,
  });
}
