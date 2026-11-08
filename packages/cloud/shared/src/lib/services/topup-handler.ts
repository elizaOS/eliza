/**
 * Shared X402 topup flow: validation, payment settlement, recipient resolution,
 * referral apply, ledger-backed credit update, and revenue splits.
 * Used by /api/v1/topup/10, /api/v1/topup/50, and /api/v1/topup/100 so all tiers behave consistently.
 */
import { isAddress } from "viem";
import { cryptoPaymentsRepository } from "../../db/repositories/crypto-payments";
import {
  type X402SettlementIntent,
  x402SettlementIntentsRepository,
} from "../../db/repositories/x402-settlement-intents";
import { verifyWalletSignature } from "../auth/wallet-auth";
import { getStripeProductMessages } from "../stripe-products/messages";
import { logger } from "../utils/logger";
import { CRYPTO_REFUND_POLICY } from "./crypto-payment-refunds";
import { referralsService } from "./referrals";
import { x402FacilitatorService } from "./x402-facilitator";
import { buildX402PaymentRequired } from "./x402-payment-required";
import {
  creditX402SettlementIntent,
  payX402RevenueSplits,
  resolveX402TopupRecipient,
  type X402TopupRecipient,
} from "./x402-settlement-reconciler";
import { x402TopupPaymentId } from "./x402-topup-identity";

const USDC_ASSETS_BY_NETWORK: Record<string, { caip2: string; asset: string; decimals: number }> = {
  base: {
    caip2: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
  },
  ethereum: {
    caip2: "eip155:1",
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
  sepolia: {
    caip2: "eip155:11155111",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
  },
  bsc: {
    caip2: "eip155:56",
    asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
  },
  "bsc-testnet": {
    caip2: "eip155:97",
    asset: "0x64544969ed7EBf5f083679233325356EBe738930",
    decimals: 18,
  },
};

type TopupEnv = Record<string, unknown> | undefined;

interface PaymentAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface PaymentPayload {
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
  payload: {
    signature: string;
    authorization?: PaymentAuthorization;
    paymentPermit?: { buyer?: string; meta?: { nonce?: string } };
  };
}

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

interface PaymentRequiredExtensions {
  paymentPermitContext?: {
    meta: {
      kind: "PAYMENT_ONLY";
      paymentId: string;
      nonce: string;
      validAfter: number;
      validBefore: number;
    };
  };
}

interface PaymentRequirementBundle {
  requirements: PaymentRequirements;
  extensions?: PaymentRequiredExtensions;
}

type TopupRecipient = X402TopupRecipient;

type SettledPayment = { transaction: string; network: string; payer?: string };

/**
 * Resolve topup recipient from wallet signature headers (if present).
 */
async function getSignedTopupRecipient(
  request: Request,
  rawBody?: string,
): Promise<TopupRecipient | null> {
  const hasWalletSig =
    !!request.headers.get("X-Wallet-Address") ||
    !!request.headers.get("X-Timestamp") ||
    !!request.headers.get("X-Wallet-Signature");

  if (!hasWalletSig) return null;

  const walletUser = await verifyWalletSignature(request, {
    bodyText: rawBody,
  });
  if (!walletUser) throw new Error("Wallet signature verification failed");
  return {
    user: walletUser,
    organizationId: walletUser.organization_id!,
    walletAddress: walletUser.wallet_address ?? request.headers.get("X-Wallet-Address")!,
  };
}

/** The payer and authorization nonce that identify one x402 payment. */
function paymentIdentity(payload: PaymentPayload): { payer: string; nonce: string } | null {
  const authorization = payload.payload?.authorization;
  if (typeof authorization?.from === "string" && typeof authorization.nonce === "string") {
    return { payer: authorization.from, nonce: authorization.nonce };
  }
  const permit = payload.payload?.paymentPermit;
  if (typeof permit?.buyer === "string" && typeof permit.meta?.nonce === "string") {
    return { payer: permit.buyer, nonce: permit.meta.nonce };
  }
  return null;
}

export interface CreateTopupHandlerOptions {
  amount: number;
  getSourceId: (walletAddress: string, paymentId: string) => string;
}

type TopupBody = {
  walletAddress?: string;
  ref?: string;
  referral_code?: string;
};

function readEnvString(env: TopupEnv, key: string): string | undefined {
  const value = env?.[key] ?? process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeNetwork(rawNetwork?: string): {
  caip2: string;
  asset: string;
  decimals: number;
} {
  const network = rawNetwork?.trim() || "base";
  const direct = Object.values(USDC_ASSETS_BY_NETWORK).find((entry) => entry.caip2 === network);
  return direct ?? USDC_ASSETS_BY_NETWORK[network] ?? USDC_ASSETS_BY_NETWORK.base;
}

function amountToUsdcBaseUnits(amount: number, decimals: number): string {
  const cents = BigInt(Math.round(amount * 100));
  const scale = 10n ** BigInt(decimals);
  return ((cents * scale) / 100n).toString();
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getScheme(network: { caip2: string }): "exact" | "exact_permit" {
  return network.caip2 === "eip155:56" || network.caip2 === "eip155:97" ? "exact_permit" : "exact";
}

async function resolvePaymentRecipient(env: TopupEnv): Promise<string | null> {
  const configured = readEnvString(env, "X402_RECIPIENT_ADDRESS");
  if (configured) return configured;

  try {
    await x402FacilitatorService.initialize();
  } catch (error) {
    // error-policy:J1 boundary translation; topup quotes report unavailable
    // x402 configuration instead of letting setup failures become Worker 500s.
    logger.error("[x402] Failed to initialize facilitator for topup recipient", error);
    return null;
  }
  return x402FacilitatorService.getSignerAddress();
}

async function createPaymentRequirements(
  req: Request,
  amount: number,
  env: TopupEnv,
): Promise<PaymentRequirementBundle | { error: string; status: number }> {
  const payTo = await resolvePaymentRecipient(env);
  if (!payTo || !isAddress(payTo)) {
    return {
      error: "x402 recipient address is not configured",
      status: 503,
    };
  }

  const network = normalizeNetwork(readEnvString(env, "X402_NETWORK"));
  const amountBaseUnits = amountToUsdcBaseUnits(amount, network.decimals);
  const scheme = getScheme(network);
  const now = Math.floor(Date.now() / 1000);
  let facilitatorCaller: string | null = null;
  if (scheme === "exact_permit") {
    // Reached with a configured X402_RECIPIENT_ADDRESS (recipient resolution
    // then skips facilitator init), so this initialize() needs its own guard.
    try {
      await x402FacilitatorService.initialize();
    } catch (error) {
      // error-policy:J1 boundary translation; topup quotes report unavailable
      // x402 configuration instead of letting setup failures become Worker 500s.
      logger.error("[x402] Failed to initialize facilitator for exact_permit signer", error);
      return {
        error: "x402 facilitator signer is not configured",
        status: 503,
      };
    }
    facilitatorCaller = x402FacilitatorService.getSignerAddress();
    if (!facilitatorCaller) {
      return {
        error: "x402 facilitator signer is not configured",
        status: 503,
      };
    }
  }

  const productMessages = getStripeProductMessages(readEnvString(env, "ELIZA_LOCALE"));

  const requirements: PaymentRequirements = {
    scheme,
    network: network.caip2,
    asset: network.asset,
    amount: amountBaseUnits,
    maxAmountRequired: amountBaseUnits,
    resource: req.url,
    // Crypto and x402 payments are refundable only as Cloud credits (#22968).
    description: `${productMessages.topupDescription(amount)}. ${productMessages.cryptoRefundPolicy}`,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: productMessages.creditsName,
      version: "1",
      amountUsd: amount,
      endpoint: new URL(req.url).pathname,
      refundPolicy: {
        destination: CRYPTO_REFUND_POLICY.x402,
        statement: productMessages.cryptoRefundPolicy,
      },
      ...(facilitatorCaller && {
        fee: {
          caller: facilitatorCaller,
          feeTo: "0x0000000000000000000000000000000000000000",
          feeAmount: "0",
        },
      }),
    },
  };

  return {
    requirements,
    ...(scheme === "exact_permit" && {
      extensions: {
        paymentPermitContext: {
          meta: {
            kind: "PAYMENT_ONLY",
            paymentId: `0x${randomHex(16)}`,
            nonce: BigInt(`0x${randomHex(16)}`).toString(),
            validAfter: now,
            validBefore: now + 300,
          },
        },
      },
    }),
  };
}

function decodePaymentHeader(headerValue: string): PaymentPayload {
  const trimmed = headerValue.trim();
  try {
    return JSON.parse(trimmed) as PaymentPayload;
  } catch {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    return JSON.parse(decoded) as PaymentPayload;
  }
}

function paymentRequiredResponse(
  requirements: PaymentRequirements,
  extensions?: PaymentRequiredExtensions,
): Response {
  const paymentRequired = buildX402PaymentRequired(requirements, extensions);
  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
  return Response.json(paymentRequired, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encoded,
      "Payment-Required": encoded,
      "X-PAYMENT-STATUS": "required",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, Payment-Required, X-PAYMENT-STATUS",
    },
  });
}

/**
 * The transfer was broadcast but not confirmed. Nothing is credited yet; the
 * client retries with the same X-PAYMENT plus X-PAYMENT-TRANSACTION.
 */
function settlementPendingResponse(settlement: {
  transaction: string;
  network: string;
  payer?: string;
}): Response {
  return Response.json(
    {
      success: false,
      pending: true,
      error: "Payment was sent and is waiting for network confirmation. Do not pay again.",
      code: "settlement_pending",
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
    },
    {
      status: 202,
      headers: {
        "X-PAYMENT-STATUS": "pending",
        "Access-Control-Expose-Headers": "X-PAYMENT-STATUS",
      },
    },
  );
}

/**
 * Confirms a top-up transfer that an earlier call broadcast. The receipt must
 * show USDC consuming this exact authorization, and only the payer's own
 * wallet is credited: the signed authorization is public once broadcast, so
 * anyone could otherwise replay it toward another wallet. The credit is keyed
 * on the transaction hash, so a confirmed transfer is credited once, and a
 * hash that settled a payment request is never reused for a top-up.
 */
async function confirmPendingTopup(params: {
  transaction: string;
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  walletAddress?: string;
}): Promise<Awaited<ReturnType<typeof x402FacilitatorService.settle>> | Response> {
  const { transaction, paymentPayload, requirements, walletAddress } = params;
  const authorization = paymentPayload.payload?.authorization;
  const reject = (error: string, code: string, status: number) =>
    Response.json({ success: false, error, code }, { status });
  if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
    return reject("X-PAYMENT-TRANSACTION must be a transaction hash", "invalid_transaction", 400);
  }
  if (requirements.scheme !== "exact" || !authorization?.from || !authorization.nonce) {
    return reject(
      "This payment cannot be confirmed by transaction hash",
      "confirmation_not_supported",
      400,
    );
  }
  if (!walletAddress || walletAddress.toLowerCase() !== authorization.from.toLowerCase()) {
    return reject(
      "A pending payment can only be credited to the wallet that paid it",
      "payer_wallet_mismatch",
      403,
    );
  }
  if (await cryptoPaymentsRepository.findByTransactionHash(transaction)) {
    return reject("This transaction already paid for something else", "transaction_used", 409);
  }
  return x402FacilitatorService.confirmSettlement({
    transaction,
    requirements: requirements as Parameters<
      typeof x402FacilitatorService.confirmSettlement
    >[0]["requirements"],
    payer: authorization.from,
    authorizationNonce: authorization.nonce,
  });
}

export function createTopupHandler(options: CreateTopupHandlerOptions) {
  const { amount, getSourceId } = options;

  return async function handler(req: Request, env?: TopupEnv): Promise<Response> {
    // Read the raw bytes once: JSON.parse for the DTO, and the exact text for
    // the wallet-signature payload hash inside getTopupRecipient (the body
    // stream cannot be read twice).
    const rawBody = await req.text().catch(() => "");
    let body: TopupBody = {};
    try {
      body = (rawBody ? JSON.parse(rawBody) : {}) as TopupBody;
    } catch {
      // error-policy:J3 malformed JSON reads as "no body fields"; the
      // wallet-signature or walletAddress checks below reject the request on
      // their own terms instead of fabricating a parsed body.
      body = {};
    }
    if (!body?.walletAddress?.trim() && !req.headers.get("X-Wallet-Signature")) {
      return Response.json(
        {
          error: "walletAddress is required (body or wallet signature headers)",
        },
        { status: 400 },
      );
    }
    if (body?.walletAddress && !isAddress(body.walletAddress)) {
      return Response.json({ error: "Valid EVM walletAddress is required" }, { status: 400 });
    }

    const paymentRequirementBundle = await createPaymentRequirements(req, amount, env);
    if ("error" in paymentRequirementBundle) {
      return Response.json(
        {
          success: false,
          error: paymentRequirementBundle.error,
          code: "x402_not_configured",
        },
        { status: paymentRequirementBundle.status },
      );
    }
    const { requirements, extensions } = paymentRequirementBundle;

    const paymentHeader = req.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return paymentRequiredResponse(requirements, extensions);
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = decodePaymentHeader(paymentHeader);
    } catch {
      return Response.json(
        {
          success: false,
          error: "Invalid X-PAYMENT header. Expected x402 payment JSON or base64 JSON.",
          code: "invalid_x_payment",
        },
        { status: 400 },
      );
    }

    let signedRecipient: TopupRecipient | null;
    try {
      signedRecipient = await getSignedTopupRecipient(req, rawBody);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 401 });
    }
    const identity = paymentIdentity(paymentPayload);
    if (!identity) {
      return Response.json(
        {
          success: false,
          error: "X-PAYMENT has no payer authorization",
          code: "invalid_x_payment",
        },
        { status: 400 },
      );
    }
    const recipientWallet = signedRecipient?.walletAddress ?? body.walletAddress!;
    const ref =
      new URL(req.url).searchParams.get("ref") ||
      new URL(req.url).searchParams.get("referral_code") ||
      body.ref ||
      body.referral_code;

    // Recorded before settlement, so a transfer that settles is credited even
    // when this request fails after it.
    let intent: X402SettlementIntent;
    try {
      intent = await x402SettlementIntentsRepository.open({
        network: requirements.network,
        ...identity,
        walletAddress: recipientWallet,
        amountUsd: amount,
      });
    } catch (error) {
      // error-policy:J1 nothing is settled without a durable record.
      logger.error("[x402] Recording the top-up intent failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        {
          success: false,
          error: "Payment could not be started. Nothing was charged; try again.",
          code: "x402_intent_unavailable",
        },
        { status: 503 },
      );
    }
    if (
      intent.wallet_address !== recipientWallet.toLowerCase() ||
      Number(intent.amount_usd) !== amount
    ) {
      return Response.json(
        {
          success: false,
          error: "This payment authorization is already used for another top-up",
          code: "payment_in_use",
        },
        { status: 409 },
      );
    }
    // A retry of a payment that already settled finishes its credit.
    if (intent.status !== "pending" && intent.transaction) {
      return creditTopup({
        intent,
        signedRecipient,
        walletAddress: recipientWallet,
        ref,
        settlement: {
          transaction: intent.transaction,
          network: intent.network,
          payer: intent.payer,
        },
      });
    }

    const pendingTransaction = req.headers.get("X-PAYMENT-TRANSACTION")?.trim();
    let settlement: Awaited<ReturnType<typeof x402FacilitatorService.settle>>;
    if (pendingTransaction) {
      const confirmation = await confirmPendingTopup({
        transaction: pendingTransaction,
        paymentPayload,
        requirements,
        walletAddress: recipientWallet,
      });
      if (confirmation instanceof Response) return confirmation;
      settlement = confirmation;
    } else {
      const intentId = intent.id;
      settlement = await x402FacilitatorService.settle(
        paymentPayload as Parameters<typeof x402FacilitatorService.settle>[0],
        requirements as Parameters<typeof x402FacilitatorService.settle>[1],
        {
          onBroadcast: (sent) =>
            x402SettlementIntentsRepository.recordBroadcast(intentId, sent.transaction),
        },
      );
    }
    if (settlement.pending && settlement.errorReason === "settlement_unconfirmed") {
      return settlementPendingResponse(settlement);
    }
    if (!settlement.success) {
      return Response.json(
        {
          success: false,
          error: settlement.errorReason ?? "x402 settlement failed",
          code: "x402_settlement_failed",
          payer: settlement.payer,
          network: settlement.network,
        },
        { status: 402 },
      );
    }

    const paymentId = x402TopupPaymentId(settlement, paymentPayload.payload.authorization ?? {});
    const settled = {
      transaction: settlement.transaction,
      creditKey: `x402:${settlement.network}:${paymentId}`,
      sourceId: getSourceId(recipientWallet, paymentId),
    };
    try {
      intent = await x402SettlementIntentsRepository.markSettled(intent.id, settled);
    } catch (error) {
      // error-policy:J1 the funds moved; credit now and leave the row (which
      // holds the broadcast hash) for review rather than failing the payer.
      logger.error("[x402] Marking the top-up settled failed; crediting anyway", {
        intentId: intent.id,
        transaction: settlement.transaction,
        error: error instanceof Error ? error.message : String(error),
      });
      intent = {
        ...intent,
        status: "settled",
        transaction: settled.transaction,
        credit_key: settled.creditKey,
        source_id: settled.sourceId,
      };
    }

    return creditTopup({
      intent,
      signedRecipient,
      walletAddress: recipientWallet,
      ref,
      settlement,
    });
  };
}

/**
 * Credits a settled top-up and answers the request. A failure here leaves
 * the intent settled, and the crypto cron finishes it.
 */
async function creditTopup(params: {
  intent: X402SettlementIntent;
  signedRecipient: TopupRecipient | null;
  walletAddress: string;
  ref: string | null | undefined;
  settlement: SettledPayment;
}): Promise<Response> {
  const { intent, signedRecipient, ref, settlement } = params;
  const amount = Number(intent.amount_usd);

  let recipient: TopupRecipient;
  let creditResult: Awaited<ReturnType<typeof creditX402SettlementIntent>>;
  try {
    recipient = signedRecipient ?? (await resolveX402TopupRecipient(params.walletAddress));

    // A referral binds the recipient's future purchases to a revenue split for
    // good, so only the recipient may accept one: the unsigned branch credits a
    // wallet named in the body, which anyone can name. The app owner share is
    // never taken from the request. It never blocks the credit.
    if (ref && signedRecipient) {
      try {
        const result = await referralsService.applyReferralCode(
          recipient.user.id,
          recipient.organizationId,
          ref,
        );
        if (result.success) {
          logger.info(
            `[x402] Successfully applied referral code ${ref} to user ${recipient.user.id}`,
          );
        }
      } catch (error) {
        // error-policy:J1 a referral is optional; the paid credit is not.
        logger.warn("[x402] Applying the referral code failed", {
          userId: recipient.user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    creditResult = await creditX402SettlementIntent(intent, recipient);
  } catch (error) {
    // error-policy:J1 the payment settled; the cron credits this intent.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[x402] Crediting a settled top-up failed", {
      intentId: intent.id,
      transaction: settlement.transaction,
      error: message,
    });
    await x402SettlementIntentsRepository.recordError(intent.id, message).catch(() => undefined);
    return Response.json(
      {
        success: false,
        pending: true,
        error: "Payment received. The credit is delayed and will be added automatically.",
        code: "x402_credit_pending",
        transaction: settlement.transaction,
        network: settlement.network,
      },
      { status: 503 },
    );
  }

  const { organizationId, walletAddress } = recipient;
  logger.info(`Topped up ${walletAddress} with $${amount} via x402`, {
    organizationId,
    transactionId: creditResult.transaction.id,
    settlementTransaction: settlement.transaction,
  });

  try {
    await payX402RevenueSplits(intent, recipient);
    await x402SettlementIntentsRepository.markCredited(intent.id, organizationId);
  } catch (error) {
    // error-policy:J1 the buyer is credited; the cron retries the splits.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[x402] Revenue splits for a top-up failed", {
      intentId: intent.id,
      error: message,
    });
    await x402SettlementIntentsRepository.recordError(intent.id, message).catch(() => undefined);
  }

  return Response.json(
    {
      success: true,
      amount,
      walletAddress,
      organizationId,
      transactionId: creditResult.transaction.id,
      newBalance: creditResult.newBalance,
      payment: {
        method: "x402",
        network: settlement.network,
        transaction: settlement.transaction,
        payer: settlement.payer,
      },
      message: `Successfully topped up $${amount}`,
    },
    {
      headers: {
        "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement)).toString("base64"),
        "X-PAYMENT-STATUS": "settled",
      },
    },
  );
}
