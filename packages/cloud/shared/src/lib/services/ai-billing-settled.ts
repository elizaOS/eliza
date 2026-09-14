/**
 * Post-settlement bookkeeping for one billed inference: the usage-analytics
 * row and the durable AI billing ledger row, in that order, for every caller
 * that has already settled credits. The ledger row is written even when the
 * analytics insert fails; otherwise the charge is invisible on the usage page
 * and unreconcilable in a dispute (#31112). A ledger write failure propagates
 * so each boundary keeps its own handling (log-and-continue after a delivered
 * reply, or the billing-failure path before one).
 */
import type { UsageRecord } from "../../db/repositories";
import type { AiBillingRecord } from "../../db/repositories/ai-billing-records";
import { type BillingContext, type BillingResult, recordUsageAnalytics } from "./ai-billing";
import { aiBillingRecordsService } from "./ai-billing-records";
import type { CreditReconciliationResult } from "./credits";

export interface RecordSettledInferenceBillingInput {
  context: BillingContext;
  billing: BillingResult;
  reconciliation: CreditReconciliationResult | null;
  idempotencyKey: string;
  analytics: Parameters<typeof recordUsageAnalytics>[2];
}

export interface SettledInferenceBillingOutcome {
  usageRecord: UsageRecord | null;
  record: AiBillingRecord;
}

export async function recordSettledInferenceBilling(
  input: RecordSettledInferenceBillingInput,
): Promise<SettledInferenceBillingOutcome> {
  let usageRecordError: string | undefined;
  const usageRecord = await recordUsageAnalytics(input.context, input.billing, {
    ...input.analytics,
    onError: (error) => {
      usageRecordError = error instanceof Error ? error.message : String(error);
    },
  });
  const record = await aiBillingRecordsService.record({
    context: input.context,
    billing: input.billing,
    usageRecord,
    usageRecordError,
    idempotencyKey: input.idempotencyKey,
    reconciliation: input.reconciliation,
  });
  return { usageRecord, record };
}
