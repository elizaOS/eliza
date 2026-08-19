/** Validates and atomically commits app-charge settlement with its callback delivery intent. */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import { logger } from "../utils/logger";
import { appChargeCallbacksService } from "./app-charge-callbacks";

export type AppChargeSettlementProvider = "stripe" | "oxapay";

export interface MarkAppChargePaidParams {
  appId: string;
  chargeRequestId: string;
  provider: AppChargeSettlementProvider;
  providerPaymentId: string;
  amountUsd: number | string;
  currency: string;
  payerUserId?: string | null;
  payerOrganizationId?: string | null;
  metadata?: Record<string, unknown>;
}

function paidMetadata(params: MarkAppChargePaidParams, paidAt: Date): Record<string, unknown> {
  return {
    ...(params.metadata ?? {}),
    paid_at: paidAt.toISOString(),
    paid_provider: params.provider,
    paid_provider_payment_id: params.providerPaymentId,
    payer_user_id: params.payerUserId ?? undefined,
    payer_organization_id: params.payerOrganizationId ?? undefined,
  };
}

export interface AppChargeSettlementResult {
  disposition: "settled" | "replayed";
  callback: null;
}

function settlementError(
  code: string,
  message: string,
  params: MarkAppChargePaidParams,
  context: Record<string, unknown> = {},
): ElizaError {
  return new ElizaError(message, {
    code,
    context: {
      appId: params.appId,
      chargeRequestId: params.chargeRequestId,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      ...context,
    },
    severity: "fatal",
  });
}

function exactUsdAmount(
  value: number | string,
  params: MarkAppChargePaidParams,
  source: "provider" | "stored",
): Decimal {
  try {
    const amount = new Decimal(value);
    if (!amount.isFinite() || amount.lt(1) || amount.gt(10_000) || amount.decimalPlaces() > 2) {
      throw new Error("amount is outside the app-charge USD contract");
    }
    return amount;
  } catch (error) {
    throw settlementError(
      source === "provider"
        ? "APP_CHARGE_INVALID_SETTLEMENT_AMOUNT"
        : "APP_CHARGE_CORRUPT_STORED_AMOUNT",
      source === "provider"
        ? "Settlement amount is not a valid app-charge USD amount"
        : "Stored app-charge amount is corrupt",
      params,
      {
        source,
        value: String(value),
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function assertExactReplay(
  params: MarkAppChargePaidParams,
  metadata: Record<string, unknown>,
  receivedAmount: string | null,
  amount: Decimal,
): void {
  const matches =
    metadata.paid_provider === params.provider &&
    metadata.paid_provider_payment_id === params.providerPaymentId &&
    receivedAmount !== null &&
    exactUsdAmount(receivedAmount, params, "stored").eq(amount);
  if (!matches) {
    throw settlementError(
      "APP_CHARGE_SETTLEMENT_CONFLICT",
      "Confirmed app charge does not match this settlement replay",
      params,
      {
        storedProvider: metadata.paid_provider,
        storedProviderPaymentId: metadata.paid_provider_payment_id,
        storedAmountUsd: receivedAmount,
        receivedAmountUsd: amount.toFixed(2),
      },
    );
  }
}

export class AppChargeSettlementService {
  async markPaid(params: MarkAppChargePaidParams): Promise<AppChargeSettlementResult> {
    const paidAt = new Date();
    const amount = exactUsdAmount(params.amountUsd, params, "provider");
    const currency = params.currency.trim().toUpperCase();
    if (currency !== "USD") {
      throw settlementError(
        "APP_CHARGE_CURRENCY_MISMATCH",
        "App-charge settlements must be denominated in USD",
        params,
        { receivedCurrency: params.currency },
      );
    }
    if (!params.providerPaymentId.trim()) {
      throw settlementError(
        "APP_CHARGE_INVALID_PROVIDER_PAYMENT_ID",
        "App-charge settlement requires a provider payment ID",
        params,
      );
    }
    const callback = {
      appId: params.appId,
      chargeRequestId: params.chargeRequestId,
      status: "paid" as const,
      provider: params.provider,
      providerPaymentId: params.providerPaymentId,
      amountUsd: amount.toFixed(2),
      payerUserId: params.payerUserId,
      payerOrganizationId: params.payerOrganizationId,
      metadata: params.metadata,
    };
    let didMarkPaid = false;

    await dbWrite.transaction(async (tx) => {
      const [chargeRequest] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, params.chargeRequestId))
        .for("update")
        .limit(1);

      if (!chargeRequest) {
        throw settlementError("APP_CHARGE_NOT_FOUND", "Charge request not found", params);
      }

      const metadata = chargeRequest.metadata ?? {};
      if (metadata.kind !== "app_charge_request" || metadata.app_id !== params.appId) {
        throw settlementError(
          "APP_CHARGE_METADATA_MISMATCH",
          "Charge request metadata mismatch",
          params,
        );
      }

      if (chargeRequest.status === "confirmed") {
        assertExactReplay(params, metadata, chargeRequest.received_amount, amount);
        await appChargeCallbacksService.enqueue(callback, tx);
        return;
      }

      if (chargeRequest.status !== "requested" && chargeRequest.status !== "pending") {
        throw settlementError("APP_CHARGE_NOT_PAYABLE", "Charge request is not payable", params, {
          status: chargeRequest.status,
        });
      }
      if (chargeRequest.expires_at.getTime() <= paidAt.getTime()) {
        throw settlementError("APP_CHARGE_EXPIRED", "Charge request has expired", params, {
          expiresAt: chargeRequest.expires_at.toISOString(),
        });
      }
      if (chargeRequest.network !== "APP_CHARGE" || chargeRequest.token !== "USD") {
        throw settlementError(
          "APP_CHARGE_DURABLE_CURRENCY_MISMATCH",
          "Stored charge request is not denominated in APP_CHARGE/USD",
          params,
          { network: chargeRequest.network, token: chargeRequest.token },
        );
      }
      const providers = Array.isArray(metadata.providers) ? metadata.providers : [];
      if (!providers.includes(params.provider)) {
        throw settlementError(
          "APP_CHARGE_PROVIDER_NOT_ALLOWED",
          "Settlement provider is not enabled for this charge request",
          params,
          { allowedProviders: providers },
        );
      }
      const expectedAmount = exactUsdAmount(chargeRequest.expected_amount, params, "stored");
      if (!expectedAmount.eq(amount)) {
        throw settlementError(
          "APP_CHARGE_AMOUNT_MISMATCH",
          "Settlement amount does not match the charge request",
          params,
          {
            expectedAmountUsd: expectedAmount.toFixed(2),
            receivedAmountUsd: amount.toFixed(2),
          },
        );
      }

      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          received_amount: expectedAmount.toFixed(2),
          credits_to_add: expectedAmount.toFixed(2),
          confirmed_at: paidAt,
          updated_at: paidAt,
          metadata: {
            ...metadata,
            ...paidMetadata(params, paidAt),
          },
        })
        .where(eq(cryptoPayments.id, params.chargeRequestId));

      await appChargeCallbacksService.enqueue(callback, tx);
      didMarkPaid = true;
    });

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

    return { disposition: didMarkPaid ? "settled" : "replayed", callback: null };
  }
}

export const appChargeSettlementService = new AppChargeSettlementService();
