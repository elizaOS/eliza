import type { UsageRecord } from "@/db/repositories";
import {
  type AiBillingRecord,
  aiBillingRecordsRepository,
  type NewAiBillingRecord,
} from "@/db/repositories/ai-billing-records";
import type { BillingContext, BillingResult } from "./ai-billing";
import type { CreditReconciliationResult } from "./credits";

export interface RecordAiBillingInput {
  context: BillingContext;
  billing: BillingResult;
  usageRecord: UsageRecord;
  idempotencyKey: string;
  reconciliation: CreditReconciliationResult | null;
}

function totalLedgerAmount(
  billing: BillingResult,
  reconciliation: CreditReconciliationResult | null,
): number {
  if (!reconciliation) return billing.totalCost;
  return reconciliation.actualCost;
}

export class AiBillingRecordsService {
  async record(input: RecordAiBillingInput): Promise<AiBillingRecord> {
    const { context, billing, usageRecord, idempotencyKey, reconciliation } = input;
    const metadata = {
      ...(context.metadata ?? {}),
      baseInputCost: billing.baseInputCost,
      baseOutputCost: billing.baseOutputCost,
      baseTotalCost: billing.baseTotalCost,
      platformMarkup: billing.platformMarkup,
      reservation: reconciliation
        ? {
            reservedAmount: reconciliation.reservedAmount,
            actualCost: reconciliation.actualCost,
            adjustmentType: reconciliation.adjustmentType,
          }
        : null,
    };

    const record: NewAiBillingRecord = {
      organization_id: context.organizationId,
      user_id: context.userId,
      usage_record_id: usageRecord.id,
      reservation_transaction_id: reconciliation?.reservationTransactionId ?? null,
      settlement_transaction_ids: reconciliation?.settlementTransactionIds ?? [],
      idempotency_key: idempotencyKey,
      request_id: context.requestId ?? null,
      provider: context.provider ?? usageRecord.provider,
      model: context.model,
      billing_source: context.billingSource ?? null,
      pricing_snapshot_ids: context.pricingSnapshotId ? [context.pricingSnapshotId] : [],
      provider_request_id: context.providerRequestId ?? null,
      provider_instance_id: context.providerInstanceId ?? null,
      provider_endpoint: context.providerEndpoint ?? null,
      usage_total_cost: String(billing.totalCost),
      ledger_total: String(totalLedgerAmount(billing, reconciliation)),
      status: "recorded",
      metadata,
    };

    return await aiBillingRecordsRepository.createDeduped(record);
  }
}

export const aiBillingRecordsService = new AiBillingRecordsService();
