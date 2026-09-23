/**
 * Commits app-charge status and its durable callback delivery intent, and can
 * atomically include the associated organization credit and earnings projections.
 *
 * Create writes status `requested`. Some fixtures still seed `pending`. Both are
 * payable; `confirmed` stays idempotent for the same provider payment.
 */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import { logger } from "../utils/logger";
import { appChargeCallbacksService } from "./app-charge-callbacks";
import { type AppCreditPurchaseResult, appCreditsService } from "./app-credits";

/** Statuses that may transition to confirmed when a provider payment lands. */
export function isAppChargePayableStatus(status: string): boolean {
  return status === "requested" || status === "pending";
}

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

export interface SettleAppChargePurchaseParams
  extends Omit<MarkAppChargePaidParams, "payerUserId" | "payerOrganizationId"> {
  userId: string;
  organizationId: string;
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
    const amount = this.normalizeAmount(params);
    const callback = {
      appId: params.appId,
      chargeRequestId: params.chargeRequestId,
      status: "paid" as const,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountUsd: amount,
      payerUserId: params.payerUserId,
      payerOrganizationId: params.payerOrganizationId,
      metadata: params.metadata,
    };
    const didMarkPaid = await dbWrite.transaction((tx) =>
      this.markPaidInTransaction(params, amount, paidAt, callback, tx),
    );

    this.logSettlement(params, didMarkPaid);
  }

  /** Commit every durable projection of a Stripe app purchase together. */
  async settlePurchase(params: SettleAppChargePurchaseParams): Promise<AppCreditPurchaseResult> {
    const paidAt = new Date();
    const amount = this.normalizeAmount(params);
    const settlementParams: MarkAppChargePaidParams = {
      ...params,
      payerUserId: params.userId,
      payerOrganizationId: params.organizationId,
    };
    const callback = {
      appId: params.appId,
      chargeRequestId: params.chargeRequestId,
      status: "paid" as const,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountUsd: amount,
      payerUserId: params.userId,
      payerOrganizationId: params.organizationId,
      metadata: params.metadata,
    };
    let didMarkPaid = false;

    const result = await dbWrite.transaction(async (tx) => {
      didMarkPaid = await this.markPaidInTransaction(
        settlementParams,
        amount,
        paidAt,
        callback,
        tx,
      );
      return appCreditsService.processPurchase({
        appId: params.appId,
        userId: params.userId,
        organizationId: params.organizationId,
        purchaseAmount: amount,
        stripePaymentIntentId: params.providerPaymentId,
        transaction: tx,
      });
    });

    this.logSettlement(settlementParams, didMarkPaid);
    return result;
  }

  private normalizeAmount(params: MarkAppChargePaidParams): string {
    const amountDecimal = new Decimal(params.amountUsd);
    if (!amountDecimal.isFinite() || !amountDecimal.gt(0)) {
      throw new ElizaError("App charge settlement amount must be a positive decimal", {
        code: "INVALID_APP_CHARGE_SETTLEMENT_AMOUNT",
        context: { chargeRequestId: params.chargeRequestId },
      });
    }
    return amountDecimal.toFixed();
  }

  private async markPaidInTransaction(
    params: MarkAppChargePaidParams,
    amount: string,
    paidAt: Date,
    callback: Parameters<typeof appChargeCallbacksService.enqueue>[0],
    tx: DbTransaction,
  ): Promise<boolean> {
    const [chargeRequest] = await tx
      .select()
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, params.chargeRequestId))
      .for("update")
      .limit(1);

    if (!chargeRequest) {
      throw new ElizaError("Charge request not found", {
        code: "APP_CHARGE_REQUEST_NOT_FOUND",
        context: { chargeRequestId: params.chargeRequestId },
      });
    }

    const metadata = chargeRequest.metadata ?? {};
    if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
      throw new ElizaError("Charge request metadata mismatch", {
        code: "APP_CHARGE_REQUEST_MISMATCH",
        context: { appId: params.appId, chargeRequestId: params.chargeRequestId },
      });
    }
    const expectedAmount = new Decimal(chargeRequest.expected_amount);
    if (!expectedAmount.isFinite() || !expectedAmount.equals(amount)) {
      throw new ElizaError("Charge request amount does not match the provider payment", {
        code: "APP_CHARGE_REQUEST_MISMATCH",
        context: {
          appId: params.appId,
          chargeRequestId: params.chargeRequestId,
          expectedAmount: chargeRequest.expected_amount,
          providerAmount: amount,
        },
      });
    }

    if (chargeRequest.status === "confirmed") {
      if (
        metadata.paid_provider !== params.provider ||
        metadata.paid_provider_payment_id !== params.providerPaymentId
      ) {
        throw new ElizaError("Charge request is already settled by another payment", {
          code: "APP_CHARGE_ALREADY_SETTLED",
          context: { appId: params.appId, chargeRequestId: params.chargeRequestId },
        });
      }
      await appChargeCallbacksService.enqueue(callback, tx);
      return false;
    }
    if (!isAppChargePayableStatus(chargeRequest.status)) {
      throw new ElizaError("Charge request cannot be settled from its current status", {
        code: "INVALID_APP_CHARGE_STATUS",
        context: { chargeRequestId: params.chargeRequestId, status: chargeRequest.status },
      });
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

    await appChargeCallbacksService.enqueue(callback, tx);
    return true;
  }

  private logSettlement(params: MarkAppChargePaidParams, didMarkPaid: boolean): void {
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
