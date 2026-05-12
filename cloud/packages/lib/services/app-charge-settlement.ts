import { eq } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import { cryptoPayments } from "@/db/schemas/crypto-payments";
import { logger } from "@/lib/utils/logger";
import { appChargeCallbacksService } from "./app-charge-callbacks";

export type AppChargeSettlementProvider = "stripe" | "oxapay";

export interface MarkAppChargePaidParams {
  appId: string;
  chargeRequestId: string;
  provider: AppChargeSettlementProvider;
  providerPaymentId: string;
  amountUsd: number | string;
  payerUserId?: string | null;
  payerOrganizationId?: string | null;
  metadata?: Record<string, unknown>;
}

function paidMetadata(params: MarkAppChargePaidParams, paidAt: Date): Record<string, unknown> {
  return {
    paid_at: paidAt.toISOString(),
    paid_provider: params.provider,
    paid_provider_payment_id: params.providerPaymentId,
    payer_user_id: params.payerUserId ?? undefined,
    payer_organization_id: params.payerOrganizationId ?? undefined,
    ...(params.metadata ?? {}),
  };
}

export class AppChargeSettlementService {
  async markPaid(params: MarkAppChargePaidParams): Promise<void> {
    const paidAt = new Date();
    const amount =
      typeof params.amountUsd === "number" ? params.amountUsd.toFixed(2) : params.amountUsd;
    let didMarkPaid = false;

    await dbWrite.transaction(async (tx) => {
      const [chargeRequest] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, params.chargeRequestId))
        .for("update")
        .limit(1);

      if (!chargeRequest) {
        throw new Error("Charge request not found");
      }

      const metadata = chargeRequest.metadata ?? {};
      if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
        throw new Error("Charge request metadata mismatch");
      }

      if (chargeRequest.status === "confirmed") {
        return;
      }

      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          received_amount: amount,
          credits_to_add: amount,
          confirmed_at: paidAt,
          updated_at: paidAt,
          metadata: {
            ...metadata,
            ...paidMetadata(params, paidAt),
          },
        })
        .where(eq(cryptoPayments.id, params.chargeRequestId));

      didMarkPaid = true;
    });

    if (didMarkPaid) {
      await appChargeCallbacksService.dispatch({
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
        status: "paid",
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
        amountUsd: amount,
        payerUserId: params.payerUserId,
        payerOrganizationId: params.payerOrganizationId,
        metadata: params.metadata,
      });
    }

    logger.info(
      didMarkPaid
        ? "[AppCharges] Marked charge request paid"
        : "[AppCharges] Charge request already paid",
      {
        appId: params.appId,
        chargeRequestId: params.chargeRequestId,
        provider: params.provider,
        providerPaymentId: params.providerPaymentId,
      },
    );
  }
}

export const appChargeSettlementService = new AppChargeSettlementService();
