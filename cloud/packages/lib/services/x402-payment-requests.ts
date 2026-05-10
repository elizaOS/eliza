import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  validateSvmAddress,
} from "@x402/svm";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { isAddress } from "viem";
import { dbWrite } from "@/db/helpers";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { appEarningsRepository } from "@/db/repositories/app-earnings";
import { appsRepository } from "@/db/repositories/apps";
import { type CryptoPayment, cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { apps } from "@/db/schemas/apps";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { x402FacilitatorService } from "@/lib/services/x402-facilitator";
import { logger } from "@/lib/utils/logger";

const KIND = "x402_payment_request";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type NetworkConfig = {
  caip2: string;
  asset: string;
  decimals: number;
  scheme: "exact" | "exact_permit";
  family: "evm" | "solana";
};

const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    caip2: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    scheme: "exact",
    family: "evm",
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    scheme: "exact",
    family: "evm",
  },
  ethereum: {
    caip2: "eip155:1",
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    scheme: "exact",
    family: "evm",
  },
  sepolia: {
    caip2: "eip155:11155111",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    scheme: "exact",
    family: "evm",
  },
  bsc: {
    caip2: "eip155:56",
    asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    scheme: "exact_permit",
    family: "evm",
  },
  "bsc-testnet": {
    caip2: "eip155:97",
    asset: "0x64544969ed7EBf5f083679233325356EBe738930",
    decimals: 18,
    scheme: "exact_permit",
    family: "evm",
  },
  solana: {
    caip2: SOLANA_MAINNET_CAIP2,
    asset: USDC_MAINNET_ADDRESS,
    decimals: 6,
    scheme: "exact",
    family: "solana",
  },
  "solana-mainnet": {
    caip2: SOLANA_MAINNET_CAIP2,
    asset: USDC_MAINNET_ADDRESS,
    decimals: 6,
    scheme: "exact",
    family: "solana",
  },
  "solana-devnet": {
    caip2: SOLANA_DEVNET_CAIP2,
    asset: USDC_DEVNET_ADDRESS,
    decimals: 6,
    scheme: "exact",
    family: "solana",
  },
  "solana-testnet": {
    caip2: SOLANA_TESTNET_CAIP2,
    asset: USDC_TESTNET_ADDRESS,
    decimals: 6,
    scheme: "exact",
    family: "solana",
  },
};

type PaymentRequirements = {
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
};

type PaymentRequiredExtensions = {
  paymentPermitContext?: {
    meta: {
      kind: "PAYMENT_ONLY";
      paymentId: string;
      nonce: string;
      validAfter: number;
      validBefore: number;
    };
  };
};

export type X402PaymentRequestView = {
  id: string;
  status: string;
  paid: boolean;
  amountUsd: number;
  platformFeeUsd: number;
  serviceFeeUsd: number;
  totalChargedUsd: number;
  network: string;
  asset: string;
  payTo: string;
  description: string;
  appId?: string;
  callbackUrl?: string;
  transaction?: string | null;
  payer?: string;
  createdAt: string;
  expiresAt: string;
  paidAt?: string | null;
};

export type CreatePaymentRequestInput = {
  organizationId: string;
  userId: string;
  amountUsd: number;
  network?: string;
  description?: string;
  callbackUrl?: string;
  callbackChannel?: Record<string, unknown>;
  appId?: string;
  metadata?: Record<string, unknown>;
  expiresInSeconds?: number;
};

export class X402PaymentRequestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "x402_payment_request_error",
  ) {
    super(message);
    this.name = "X402PaymentRequestError";
  }
}

function normalizeNetwork(raw?: string): NetworkConfig {
  const env = getCloudAwareEnv();
  const value = raw?.trim() || env.X402_NETWORK || "base";
  const byCaip = Object.values(NETWORKS).find((entry) => entry.caip2 === value);
  const config = byCaip ?? NETWORKS[value];
  if (!config) {
    throw new X402PaymentRequestError(`Unsupported x402 network: ${value}`, 400, "bad_network");
  }
  return config;
}

function publicBaseUrl(): string {
  const env = getCloudAwareEnv();
  return (
    env.X402_PUBLIC_BASE_URL ??
    env.X402_BASE_URL ??
    env.NEXT_PUBLIC_API_URL ??
    "https://x402.elizaos.ai"
  ).replace(/\/$/, "");
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function usdToAtomic(amountUsd: Decimal, decimals: number): string {
  return amountUsd.mul(new Decimal(10).pow(decimals)).ceil().toFixed(0);
}

function validateCallbackUrl(callbackUrl?: string): string | undefined {
  if (!callbackUrl) return undefined;
  const url = new URL(callbackUrl);
  const env = getCloudAwareEnv();
  const isLocalDev =
    env.NODE_ENV !== "production" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !(isLocalDev && url.protocol === "http:")) {
    throw new X402PaymentRequestError("callbackUrl must be https", 400, "bad_callback_url");
  }
  return url.toString();
}

async function resolvePaymentRecipient(network: NetworkConfig): Promise<string> {
  const env = getCloudAwareEnv();
  const configured =
    network.family === "solana"
      ? (env.X402_SOLANA_RECIPIENT_ADDRESS ?? env.SOLANA_PAYOUT_WALLET_ADDRESS)?.trim()
      : env.X402_RECIPIENT_ADDRESS?.trim();
  if (configured) return configured;
  await x402FacilitatorService.initialize();
  const signer = x402FacilitatorService.getSignerAddressForNetwork(network.caip2);
  if (!signer) {
    throw new X402PaymentRequestError(
      "x402 recipient address is not configured",
      503,
      "x402_not_configured",
    );
  }
  return signer;
}

function metadataOf(payment: CryptoPayment): Record<string, unknown> {
  return (payment.metadata ?? {}) as Record<string, unknown>;
}

function isX402PaymentRequest(payment: CryptoPayment | undefined): payment is CryptoPayment {
  return !!payment && metadataOf(payment).kind === KIND;
}

function buildExtensions(network: NetworkConfig): PaymentRequiredExtensions | undefined {
  if (network.scheme !== "exact_permit") return undefined;
  const now = Math.floor(Date.now() / 1000);
  return {
    paymentPermitContext: {
      meta: {
        kind: "PAYMENT_ONLY",
        paymentId: `0x${randomHex(16)}`,
        nonce: BigInt(`0x${randomHex(16)}`).toString(),
        validAfter: now,
        validBefore: now + 300,
      },
    },
  };
}

function buildPaymentRequired(
  requirements: PaymentRequirements,
  extensions?: PaymentRequiredExtensions,
) {
  return {
    x402Version: 2,
    error: "payment_required",
    accepts: [requirements],
    ...(extensions && { extensions }),
  };
}

function decodePaymentPayload(input: unknown): Parameters<typeof x402FacilitatorService.settle>[0] {
  if (typeof input === "object" && input !== null) {
    return input as Parameters<typeof x402FacilitatorService.settle>[0];
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new X402PaymentRequestError("X-PAYMENT payload is required", 400, "missing_payment");
  }
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed) as Parameters<typeof x402FacilitatorService.settle>[0];
  } catch {
    const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
    return JSON.parse(decoded) as Parameters<typeof x402FacilitatorService.settle>[0];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDecodedPaymentPayload(
  value: unknown,
): value is Parameters<typeof x402FacilitatorService.settle>[0] {
  if (!isRecord(value) || typeof value.x402Version !== "number") return false;
  if (!isRecord(value.accepted) || !isRecord(value.payload)) return false;
  const hasEvmSignature = typeof value.payload.signature === "string";
  const hasSvmTransaction = typeof value.payload.transaction === "string";
  return (
    typeof value.accepted.scheme === "string" &&
    typeof value.accepted.network === "string" &&
    typeof value.accepted.asset === "string" &&
    typeof value.accepted.amount === "string" &&
    typeof value.accepted.payTo === "string" &&
    (hasEvmSignature || hasSvmTransaction)
  );
}

async function triggerCallback(payment: CryptoPayment, event: Record<string, unknown>) {
  const callbackUrl = metadataOf(payment).callbackUrl;
  if (typeof callbackUrl !== "string") return;
  try {
    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ElizaCloud-X402/1.0",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn("[x402-payment-requests] callback failed", {
        paymentRequestId: payment.id,
        status: res.status,
      });
    }
  } catch (error) {
    logger.warn("[x402-payment-requests] callback error", {
      paymentRequestId: payment.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function callbackChannel(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const channel = metadata.callbackChannel ?? metadata.callback_channel;
  return isRecord(channel) ? channel : undefined;
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

async function triggerChannelCallback(
  payment: CryptoPayment,
  status: "paid" | "failed",
  reason?: string,
): Promise<void> {
  const metadata = metadataOf(payment);
  const channel = callbackChannel(metadata);
  if (!channel) return;

  const roomId = stringValue(channel, "roomId") ?? stringValue(channel, "room_id");
  const agentId = stringValue(channel, "agentId") ?? stringValue(channel, "agent_id");
  if (!roomId || !agentId) return;

  const amountUsd = Number(metadata.amountUsd ?? payment.credits_to_add ?? 0);
  const source = stringValue(channel, "source") ?? "payment";
  const text =
    status === "paid"
      ? `Payment went through for ${formatUsd(amountUsd)}.`
      : `Payment did not go through for ${formatUsd(amountUsd)}.`;

  try {
    await memoriesRepository.create({
      id: crypto.randomUUID(),
      roomId,
      entityId: agentId,
      agentId,
      type: "messages",
      content: {
        text,
        source: "agent",
        channelType: source,
        x402PaymentRequestId: payment.id,
        paymentStatus: status,
        ...(reason && { reason }),
      },
      metadata: {
        type: "message",
        role: "agent",
        dialogueType: "message",
        visibility: "visible",
        x402PaymentEvent:
          status === "paid" ? "x402.payment_request.paid" : "x402.payment_request.failed",
        x402PaymentRequestId: payment.id,
        channel,
      },
    });
  } catch (error) {
    logger.warn("[x402-payment-requests] channel callback failed", {
      paymentRequestId: payment.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordAppScopedPaymentEarnings(
  payment: CryptoPayment,
  appId: string,
  amountUsd: number,
  settlement: Awaited<ReturnType<typeof x402FacilitatorService.settle>>,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (amountUsd <= 0) return;

  const app = await appsRepository.findById(appId);
  if (!app?.created_by_user_id) {
    logger.warn("[x402-payment-requests] app payment settled without a creator", {
      paymentRequestId: payment.id,
      appId,
    });
    return;
  }

  await appEarningsRepository.addPurchaseEarnings(appId, amountUsd);
  await appEarningsRepository.createTransaction({
    app_id: appId,
    user_id: app.created_by_user_id,
    type: "purchase_share",
    amount: amountUsd.toFixed(6),
    description: `x402 payment request ${payment.id}`,
    metadata: {
      paymentType: "x402_payment_request",
      paymentRequestId: payment.id,
      network: settlement.network,
      transaction: settlement.transaction,
      payer: settlement.payer,
      platformFeeUsd: metadata.platformFeeUsd,
      serviceFeeUsd: metadata.serviceFeeUsd,
      totalChargedUsd: metadata.totalChargedUsd,
    },
  });

  await dbWrite
    .update(apps)
    .set({
      total_creator_earnings: sql`${apps.total_creator_earnings} + ${amountUsd}`,
      updated_at: new Date(),
    })
    .where(eq(apps.id, appId));

  const result = await redeemableEarningsService.addEarnings({
    userId: app.created_by_user_id,
    amount: amountUsd,
    source: "miniapp",
    sourceId: payment.id,
    dedupeBySourceId: true,
    description: `App x402 payment request ${payment.id}`,
    metadata: {
      appId,
      paymentType: "x402_payment_request",
      network: settlement.network,
      transaction: settlement.transaction,
      payer: settlement.payer,
      platformFeeUsd: metadata.platformFeeUsd,
      serviceFeeUsd: metadata.serviceFeeUsd,
      totalChargedUsd: metadata.totalChargedUsd,
    },
  });

  if (result && !result.success) {
    logger.error("[x402-payment-requests] failed to credit app creator redeemable earnings", {
      paymentRequestId: payment.id,
      appId,
      creatorUserId: app.created_by_user_id,
      amountUsd,
      error: result.error,
    });
  }
}

class X402PaymentRequestsService {
  async create(input: CreatePaymentRequestInput): Promise<{
    paymentRequest: X402PaymentRequestView;
    paymentRequired: ReturnType<typeof buildPaymentRequired>;
    paymentRequiredHeader: string;
  }> {
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new X402PaymentRequestError("amountUsd must be positive", 400, "bad_amount");
    }

    const network = normalizeNetwork(input.network);
    const payTo = await resolvePaymentRecipient(network);
    if (network.family === "evm" && !isAddress(payTo)) {
      throw new X402PaymentRequestError(
        "x402 recipient address must be an EVM address",
        503,
        "bad_recipient",
      );
    }
    if (network.family === "solana" && !validateSvmAddress(payTo)) {
      throw new X402PaymentRequestError(
        "x402 recipient address must be a Solana address",
        503,
        "bad_recipient",
      );
    }

    let facilitatorCaller: string | null = null;
    if (network.scheme === "exact_permit") {
      await x402FacilitatorService.initialize();
      facilitatorCaller = x402FacilitatorService.getSignerAddress();
      if (!facilitatorCaller) {
        throw new X402PaymentRequestError(
          "x402 facilitator signer is not configured",
          503,
          "x402_not_configured",
        );
      }
    }

    let solanaFeePayer: string | null = null;
    if (network.family === "solana") {
      await x402FacilitatorService.initialize();
      solanaFeePayer = x402FacilitatorService.getSignerAddressForNetwork(network.caip2);
      if (!solanaFeePayer) {
        throw new X402PaymentRequestError(
          "x402 Solana facilitator signer is not configured",
          503,
          "x402_not_configured",
        );
      }
    }

    const callbackUrl = validateCallbackUrl(input.callbackUrl);
    const amount = new Decimal(input.amountUsd);
    const env = getCloudAwareEnv();
    const platformFeeBps = new Decimal(env.X402_PLATFORM_FEE_BPS ?? "100");
    const serviceFee = new Decimal(env.X402_SERVICE_FEE_USD ?? "0.01");
    const platformFee = amount.mul(platformFeeBps).div(10_000).toDecimalPlaces(4, Decimal.ROUND_UP);
    const totalCharged = amount.plus(platformFee).plus(serviceFee).toDecimalPlaces(4);
    const amountAtomic = usdToAtomic(totalCharged, network.decimals);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? 900) * 1000);
    const resource = `${publicBaseUrl()}/api/v1/x402/requests/${id}/settle`;
    const description = input.description?.trim() || "x402 payment request";
    const extensions = buildExtensions(network);
    const requirements: PaymentRequirements = {
      scheme: network.scheme,
      network: network.caip2,
      asset: network.asset,
      amount: amountAtomic,
      maxAmountRequired: amountAtomic,
      resource,
      description,
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 300,
      extra: {
        paymentRequestId: id,
        amountUsd: amount.toNumber(),
        platformFeeUsd: platformFee.toNumber(),
        platformFeeBps: platformFeeBps.toNumber(),
        serviceFeeUsd: serviceFee.toNumber(),
        totalChargedUsd: totalCharged.toNumber(),
        ...(facilitatorCaller && {
          fee: {
            caller: facilitatorCaller,
            feeTo: ZERO_ADDRESS,
            feeAmount: "0",
          },
        }),
        ...(solanaFeePayer && {
          feePayer: solanaFeePayer,
          memo: id,
        }),
      },
    };

    const paymentRequired = buildPaymentRequired(requirements, extensions);
    const payment = await cryptoPaymentsRepository.create({
      id,
      organization_id: input.organizationId,
      user_id: input.userId,
      payment_address: payTo,
      token_address: network.asset,
      token: "USDC",
      network: network.caip2,
      expected_amount: amountAtomic,
      credits_to_add: amount.toFixed(4),
      status: "pending",
      expires_at: expiresAt,
      metadata: {
        ...(input.metadata ?? {}),
        kind: KIND,
        appId: input.appId,
        callbackUrl,
        callbackChannel: input.callbackChannel,
        description,
        requirements,
        extensions,
        amountUsd: amount.toNumber(),
        platformFeeUsd: platformFee.toNumber(),
        serviceFeeUsd: serviceFee.toNumber(),
        totalChargedUsd: totalCharged.toNumber(),
      },
    });

    return {
      paymentRequest: this.toView(payment),
      paymentRequired,
      paymentRequiredHeader: Buffer.from(JSON.stringify(paymentRequired)).toString("base64"),
    };
  }

  async get(id: string): Promise<CryptoPayment | undefined> {
    const payment = await cryptoPaymentsRepository.findById(id);
    return isX402PaymentRequest(payment) ? payment : undefined;
  }

  async listByOrganization(organizationId: string): Promise<X402PaymentRequestView[]> {
    const payments = await cryptoPaymentsRepository.listByOrganization(organizationId);
    return payments.filter(isX402PaymentRequest).map((payment) => this.toView(payment));
  }

  async settle(
    id: string,
    paymentPayloadInput: unknown,
  ): Promise<{
    paymentRequest: X402PaymentRequestView;
    paymentResponse: string;
  }> {
    const payment = await this.get(id);
    if (!payment) {
      throw new X402PaymentRequestError("Payment request not found", 404, "not_found");
    }
    if (payment.status === "confirmed") {
      const paymentResponse = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: payment.transaction_hash,
          network: payment.network,
          alreadySettled: true,
        }),
      ).toString("base64");
      return { paymentRequest: this.toPublicView(payment), paymentResponse };
    }
    if (payment.expires_at.getTime() < Date.now()) {
      const expired = (await cryptoPaymentsRepository.markAsExpired(payment.id)) ?? payment;
      await this.triggerFailureCallback(expired, "expired", {
        expiredAt: payment.expires_at.toISOString(),
      });
      throw new X402PaymentRequestError(
        `Payment request expired at ${payment.expires_at.toISOString()}`,
        410,
        "expired",
      );
    }

    const metadata = metadataOf(payment);
    const requirements = metadata.requirements as Parameters<
      typeof x402FacilitatorService.settle
    >[1];
    if (!requirements) {
      throw new X402PaymentRequestError("Payment request is missing requirements", 500);
    }

    let paymentPayload: Parameters<typeof x402FacilitatorService.settle>[0];
    try {
      paymentPayload = decodePaymentPayload(paymentPayloadInput);
    } catch (error) {
      await this.triggerFailureCallback(payment, "invalid_payment_payload", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!isDecodedPaymentPayload(paymentPayload)) {
      await this.triggerFailureCallback(payment, "invalid_payment_payload");
      throw new X402PaymentRequestError(
        "Invalid x402 payment payload",
        400,
        "invalid_payment_payload",
      );
    }

    let settlement: Awaited<ReturnType<typeof x402FacilitatorService.settle>>;
    try {
      settlement = await x402FacilitatorService.settle(paymentPayload, requirements);
    } catch (error) {
      await this.triggerFailureCallback(payment, "settlement_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new X402PaymentRequestError("x402 settlement failed", 402, "settlement_failed");
    }
    if (!settlement.success) {
      await this.triggerFailureCallback(payment, settlement.errorReason ?? "settlement_failed", {
        settlement,
      });
      throw new X402PaymentRequestError(
        settlement.errorReason ?? "x402 settlement failed",
        402,
        "settlement_failed",
      );
    }

    const confirmed = await cryptoPaymentsRepository.markAsConfirmed(
      payment.id,
      settlement.transaction,
      "",
      payment.expected_amount,
    );
    const settledPayment =
      (await cryptoPaymentsRepository.update(payment.id, {
        metadata: {
          ...metadata,
          payer: settlement.payer,
          settlement,
        },
      })) ??
      confirmed ??
      payment;
    const amountUsd = Number(metadata.amountUsd ?? payment.credits_to_add);
    const appId = typeof metadata.appId === "string" ? metadata.appId : undefined;

    if (appId) {
      await recordAppScopedPaymentEarnings(payment, appId, amountUsd, settlement, metadata);
    } else if (payment.user_id && amountUsd > 0) {
      await redeemableEarningsService.addEarnings({
        userId: payment.user_id,
        amount: amountUsd,
        source: "creator_revenue_share",
        sourceId: payment.id,
        dedupeBySourceId: true,
        description: `x402 payment request ${payment.id}`,
        metadata: {
          paymentType: "x402_payment_request",
          network: settlement.network,
          transaction: settlement.transaction,
          payer: settlement.payer,
          platformFeeUsd: metadata.platformFeeUsd,
          serviceFeeUsd: metadata.serviceFeeUsd,
          totalChargedUsd: metadata.totalChargedUsd,
        },
      });
    }

    await triggerCallback(settledPayment, {
      type: "x402.payment_request.paid",
      paymentRequest: this.toView(settledPayment),
      settlement,
    });
    await triggerChannelCallback(settledPayment, "paid");

    return {
      paymentRequest: this.toPublicView(settledPayment),
      paymentResponse: Buffer.from(JSON.stringify(settlement)).toString("base64"),
    };
  }

  private async triggerFailureCallback(
    payment: CryptoPayment,
    reason: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await triggerCallback(payment, {
      type: "x402.payment_request.failed",
      paymentRequest: this.toView(payment),
      reason,
      ...(details && { details }),
    });
    await triggerChannelCallback(payment, "failed", reason);
  }

  toView(payment: CryptoPayment): X402PaymentRequestView {
    const metadata = metadataOf(payment);
    return {
      id: payment.id,
      status: payment.status,
      paid: payment.status === "confirmed",
      amountUsd: Number(metadata.amountUsd ?? payment.credits_to_add ?? 0),
      platformFeeUsd: Number(metadata.platformFeeUsd ?? 0),
      serviceFeeUsd: Number(metadata.serviceFeeUsd ?? 0),
      totalChargedUsd: Number(metadata.totalChargedUsd ?? 0),
      network: payment.network,
      asset: payment.token_address ?? "",
      payTo: payment.payment_address,
      description: typeof metadata.description === "string" ? metadata.description : "",
      appId: typeof metadata.appId === "string" ? metadata.appId : undefined,
      callbackUrl: typeof metadata.callbackUrl === "string" ? metadata.callbackUrl : undefined,
      transaction: payment.transaction_hash,
      payer: typeof metadata.payer === "string" ? metadata.payer : undefined,
      createdAt: payment.created_at.toISOString(),
      expiresAt: payment.expires_at.toISOString(),
      paidAt: payment.confirmed_at?.toISOString() ?? null,
    };
  }

  toPublicView(payment: CryptoPayment): X402PaymentRequestView {
    const view = this.toView(payment);
    const { callbackUrl: _callbackUrl, ...publicView } = view;
    return publicView;
  }
}

export const x402PaymentRequestsService = new X402PaymentRequestsService();
