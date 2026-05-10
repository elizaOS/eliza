import Decimal from "decimal.js";
import { isAddress } from "viem";
import { type CryptoPayment, cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
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
};

const NETWORKS: Record<string, NetworkConfig> = {
  base: {
    caip2: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    scheme: "exact",
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    scheme: "exact",
  },
  ethereum: {
    caip2: "eip155:1",
    asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    scheme: "exact",
  },
  sepolia: {
    caip2: "eip155:11155111",
    asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    scheme: "exact",
  },
  bsc: {
    caip2: "eip155:56",
    asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    scheme: "exact_permit",
  },
  "bsc-testnet": {
    caip2: "eip155:97",
    asset: "0x64544969ed7EBf5f083679233325356EBe738930",
    decimals: 18,
    scheme: "exact_permit",
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

async function resolvePaymentRecipient(): Promise<string> {
  const env = getCloudAwareEnv();
  const configured = env.X402_RECIPIENT_ADDRESS?.trim();
  if (configured) return configured;
  await x402FacilitatorService.initialize();
  const signer = x402FacilitatorService.getSignerAddress();
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
  return (
    typeof value.accepted.scheme === "string" &&
    typeof value.accepted.network === "string" &&
    typeof value.accepted.asset === "string" &&
    typeof value.accepted.amount === "string" &&
    typeof value.accepted.payTo === "string" &&
    typeof value.payload.signature === "string"
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
    const payTo = await resolvePaymentRecipient();
    if (!isAddress(payTo)) {
      throw new X402PaymentRequestError(
        "x402 recipient address must be an EVM address",
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
      return { paymentRequest: this.toView(payment), paymentResponse };
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

    if (payment.user_id && amountUsd > 0) {
      await redeemableEarningsService.addEarnings({
        userId: payment.user_id,
        amount: amountUsd,
        source: appId ? "miniapp" : "creator_revenue_share",
        sourceId: appId ?? payment.id,
        dedupeBySourceId: true,
        description: `${appId ? "App" : "x402"} payment request ${payment.id}`,
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
    }

    await triggerCallback(settledPayment, {
      type: "x402.payment_request.paid",
      paymentRequest: this.toView(settledPayment),
      settlement,
    });

    return {
      paymentRequest: this.toView(settledPayment),
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
}

export const x402PaymentRequestsService = new X402PaymentRequestsService();
