/**
 * Shared X402 topup flow: validation, payment settlement, recipient resolution,
 * referral apply, ledger-backed credit update, and revenue splits.
 * Used by /api/v1/topup/10, /api/v1/topup/50, and /api/v1/topup/100 so all tiers behave consistently.
 */
import { isAddress } from "viem";
import { verifyWalletSignature } from "@/lib/auth/wallet-auth";
import { creditsService } from "@/lib/services/credits";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { referralsService } from "@/lib/services/referrals";
import { findOrCreateUserByWalletAddress } from "@/lib/services/wallet-signup";
import { x402FacilitatorService } from "@/lib/services/x402-facilitator";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

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
    authorization: PaymentAuthorization;
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

interface TopupRecipient {
  user: UserWithOrganization;
  organizationId: string;
  walletAddress: string;
}

/**
 * Resolve topup recipient: from wallet signature headers (if present) or from body.walletAddress.
 */
async function getTopupRecipient(
  request: Request,
  body: {
    walletAddress?: string;
    ref?: string;
    referral_code?: string;
    appOwnerId?: string;
  },
): Promise<TopupRecipient> {
  const hasWalletSig =
    !!request.headers.get("X-Wallet-Address") &&
    !!request.headers.get("X-Timestamp") &&
    !!request.headers.get("X-Wallet-Signature");

  if (hasWalletSig) {
    const walletUser = await verifyWalletSignature(request);
    if (!walletUser) throw new Error("Wallet signature verification failed");
    return {
      user: walletUser,
      organizationId: walletUser.organization_id!,
      walletAddress: walletUser.wallet_address ?? request.headers.get("X-Wallet-Address")!,
    };
  }

  if (!body?.walletAddress?.trim()) {
    throw new Error("walletAddress is required (body or wallet signature headers)");
  }

  const { user } = await findOrCreateUserByWalletAddress(body.walletAddress, {
    grantInitialCredits: false,
  });

  return {
    user,
    organizationId: user.organization_id!,
    walletAddress: body.walletAddress,
  };
}

export interface CreateTopupHandlerOptions {
  amount: number;
  getSourceId: (walletAddress: string, paymentId: string) => string;
}

type TopupBody = {
  walletAddress?: string;
  ref?: string;
  referral_code?: string;
  appOwnerId?: string;
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

  await x402FacilitatorService.initialize();
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
    await x402FacilitatorService.initialize();
    facilitatorCaller = x402FacilitatorService.getSignerAddress();
    if (!facilitatorCaller) {
      return {
        error: "x402 facilitator signer is not configured",
        status: 503,
      };
    }
  }

  const requirements: PaymentRequirements = {
    scheme,
    network: network.caip2,
    asset: network.asset,
    amount: amountBaseUnits,
    maxAmountRequired: amountBaseUnits,
    resource: req.url,
    description: `Eliza Cloud credit top-up: $${amount}`,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "Eliza Cloud Credits",
      version: "1",
      amountUsd: amount,
      endpoint: new URL(req.url).pathname,
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
  const paymentRequired = {
    x402Version: 2,
    error: "payment_required",
    accepts: [requirements],
    ...(extensions && { extensions }),
  };
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

export function createTopupHandler(options: CreateTopupHandlerOptions) {
  const { amount, getSourceId } = options;

  return async function handler(req: Request, env?: TopupEnv): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as TopupBody;
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

    const settlement = await x402FacilitatorService.settle(
      paymentPayload as Parameters<typeof x402FacilitatorService.settle>[0],
      requirements as Parameters<typeof x402FacilitatorService.settle>[1],
    );
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

    let recipient;
    try {
      recipient = await getTopupRecipient(req, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("walletAddress is required")) {
        return Response.json({ error: msg }, { status: 400 });
      }
      return Response.json({ error: msg }, { status: 401 });
    }

    const { user, organizationId, walletAddress } = recipient;
    const ref =
      new URL(req.url).searchParams.get("ref") ||
      new URL(req.url).searchParams.get("referral_code") ||
      body.ref ||
      body.referral_code;
    const appOwnerId = new URL(req.url).searchParams.get("appOwnerId") || body.appOwnerId;

    if (ref && user) {
      const result = await referralsService.applyReferralCode(user.id, organizationId, ref, {
        appOwnerId: appOwnerId || undefined,
      });
      if (result.success) {
        logger.info(`[x402] Successfully applied referral code ${ref} to user ${user.id}`);
      }
    }

    const idempotencyId = `x402:${settlement.network}:${settlement.transaction}`;
    const creditResult = await creditsService.addCredits({
      organizationId,
      amount,
      description: `x402 wallet top-up: $${amount}`,
      stripePaymentIntentId: idempotencyId,
      metadata: {
        payment_method: "x402",
        network: settlement.network,
        transaction: settlement.transaction,
        payer: settlement.payer,
        wallet_address: walletAddress,
        amount_usd: amount,
      },
    });
    logger.info(`Topped up ${walletAddress} with $${amount} via x402`, {
      organizationId,
      transactionId: creditResult.transaction.id,
      settlementTransaction: settlement.transaction,
    });

    if (user) {
      const { splits } = await referralsService.calculateRevenueSplits(user.id, amount);
      if (splits.length > 0) {
        logger.info(`[x402] Processing revenue splits for $${amount} purchase by user ${user.id}`);
        const paymentId = settlement.transaction || paymentPayload.payload.authorization.nonce;
        const sourceIdBase = getSourceId(walletAddress, paymentId);
        for (const split of splits) {
          if (split.amount <= 0) continue;
          const source =
            split.role === "app_owner" ? "app_owner_revenue_share" : "creator_revenue_share";
          await redeemableEarningsService.addEarnings({
            userId: split.userId,
            amount: split.amount,
            source,
            sourceId: `x402_crypto_split_${sourceIdBase}:${split.userId}`,
            dedupeBySourceId: true,
            description: `${split.role === "app_owner" ? "App Owner" : "Creator"} revenue share (${((split.amount / amount) * 100).toFixed(0)}%) for $${amount} crypto topup`,
            metadata: {
              buyer_user_id: user.id,
              buyer_org_id: organizationId,
              role: split.role,
              payment_method: "x402",
            },
          });
          logger.info(
            `[x402] Credited split: $${split.amount.toFixed(2)} to ${split.role} (${split.userId})`,
          );
        }
      }
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
  };
}
